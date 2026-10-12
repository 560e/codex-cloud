import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../server/store.js';
import { Workbench } from '../server/workbench.js';
import { MockCodex } from './mock-codex.js';
import { acquireDataLock } from '../server/data-lock.js';
import { backupWorkbench } from '../server/backup.js';
import { BoundedCache } from '../server/cache.js';
import { rotatingLog, pruneLogs } from '../server/logging.js';
import { listFiles, safePath } from '../server/files.js';
import { buildApp } from '../server/app.js';
import { Auth } from '../server/auth.js';
import { config } from '../server/config.js';
import {
  parseRpcResult,
  parseSocketMessage,
  itemSchema,
  requestParamsSchema,
} from '../shared/protocol.js';

async function fixture(maxConcurrent = 3) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-cloud-fixes-'));
  const store = new Store(path.join(root, 'data'));
  const bridge = new MockCodex(root);
  const wb = new Workbench(bridge, store, maxConcurrent);
  const thread = (await wb.create(root, {})).thread;
  return {
    root,
    store,
    bridge,
    wb,
    thread,
    async close() {
      wb.dispose();
      bridge.stop();
      store.close();
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}
const input = [{ type: 'text', text: '慢速' }];

test('verified backup excludes live owners, restores files and refuses missing attachments', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-cloud-backup-fixes-'));
  const data = path.join(root, 'data'),
    destination = path.join(root, 'snapshot');
  const store = new Store(data);
  const id = randomUUID(),
    file = path.join(data, 'uploads', id, 'payload.txt');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, 'retained content');
  store.db
    .prepare('INSERT INTO attachments(id,thread_id,name,mime,size,path) VALUES(?,?,?,?,?,?)')
    .run(id, 'thread', 'payload.txt', 'text/plain', 16, file);
  store.close();
  try {
    const release = acquireDataLock(data);
    try {
      await assert.rejects(backupWorkbench(data, destination), /占用/);
      assert.throws(() => acquireDataLock(data), /占用/);
      assert.equal(
        await fs.stat(destination).then(
          () => true,
          () => false,
        ),
        false,
      );
    } finally {
      release();
    }
    await backupWorkbench(data, destination);
    const manifest = JSON.parse(await fs.readFile(path.join(destination, 'manifest.json'), 'utf8'));
    assert.equal(manifest.files.length, 1);
    assert.match(manifest.files[0].sha256, /^[a-f0-9]{64}$/);
    // Restore into the original path inside this isolated fixture.
    await fs.rename(data, path.join(root, 'old-data'));
    await fs.cp(destination, data, { recursive: true });
    const restored = new DatabaseSync(path.join(data, 'workbench.sqlite'), { readOnly: true });
    const row = restored.prepare('SELECT path FROM attachments').get()!;
    restored.close();
    assert.equal(await fs.readFile(String(row.path), 'utf8'), 'retained content');
    await fs.unlink(file);
    await assert.rejects(backupWorkbench(data, path.join(root, 'broken')));
    assert.equal(
      await fs.stat(path.join(root, 'broken')).then(
        () => true,
        () => false,
      ),
      false,
    );
    assert.ok(!(await fs.readdir(root)).some((name) => name.includes('.partial-')));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('real directory and junction conversations run concurrently using the canonical directory', async () => {
  const f = await fixture();
  try {
    const actual = path.join(f.root, 'actual'),
      alias = path.join(f.root, 'alias');
    await fs.mkdir(actual);
    await fs.symlink(actual, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const a = (await f.wb.create(actual, {})).thread;
    const b = (await f.wb.create(alias, {})).thread;
    await f.wb.send(a.id, input, {}, false);
    await f.wb.send(b.id, input, {}, false);
    assert.equal(f.wb.active.size, 2);
    assert.equal(f.store.publicQueue().length, 0);
    assert.equal(f.wb.active.get(a.id)!.cwd, await fs.realpath(actual));
    assert.equal(f.wb.active.get(b.id)!.cwd, await fs.realpath(actual));
    await f.wb.interrupt(a.id);
    assert.equal(f.wb.active.size, 1);
    assert.ok(f.wb.active.has(b.id));
  } finally {
    await f.close();
  }
});

test('stop during pending turn/start interrupts the late turn and retains capacity on interrupt failure', async () => {
  const f = await fixture(1);
  try {
    const original = f.bridge.call.bind(f.bridge);
    for (const interruptFails of [false, true]) {
      let release!: () => void, entered!: () => void;
      const gate = new Promise<void>((r) => {
        release = r;
      });
      const started = new Promise<void>((r) => {
        entered = r;
      });
      f.bridge.call = async (method, params) => {
        if (method === 'turn/start') {
          entered();
          await gate;
        }
        if (method === 'turn/interrupt' && interruptFails) throw new Error('interrupt unavailable');
        return original(method, params);
      };
      const sending = f.wb.send(f.thread.id, input, {}, false);
      await started;
      assert.deepEqual(await f.wb.interrupt(f.thread.id), { stopping: true });
      release();
      if (interruptFails) {
        await assert.rejects(sending, /interrupt unavailable/);
        assert.ok(f.wb.active.has(f.thread.id));
        const other = (await f.wb.create(f.root, {})).thread;
        assert.equal((await f.wb.send(other.id, input, {}, false)).queued, true);
        assert.equal(f.store.publicQueue().find((r) => r.threadId === other.id)?.state, 'queued');
      } else {
        await sending;
        assert.equal(f.wb.active.size, 0);
      }
    }
  } finally {
    await f.close();
  }
});

test('pending attachments are recoverable/removable; submitted and queued files remain protected', async () => {
  const f = await fixture();
  const app = await buildApp(f.store, f.wb, { logger: false });
  try {
    await new Auth(f.store).change('test-password-long');
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: config.origin },
      payload: { password: 'test-password-long' },
    });
    const headers = {
      origin: config.origin,
      cookie: `${login.cookies[0].name}=${login.cookies[0].value}`,
    };
    const upload = async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/threads/${f.thread.id}/attachments`,
        headers: { ...headers, 'content-type': 'multipart/form-data; boundary=ReviewBoundary' },
        payload:
          '--ReviewBoundary\r\nContent-Disposition: form-data; name="file"; filename="notes.txt"\r\nContent-Type: text/plain\r\n\r\nhello\r\n--ReviewBoundary--\r\n',
      });
      assert.equal(response.statusCode, 200, response.body);
      return response.json();
    };
    const first = await upload();
    const url = `/api/threads/${f.thread.id}/attachments`;
    assert.equal((await app.inject({ url, headers })).json()[0].id, first.id);
    const file = String(
      f.store.db.prepare('SELECT path FROM attachments WHERE id=?').get(first.id)!.path,
    );
    assert.equal(
      (await app.inject({ method: 'DELETE', url: `${url}/${first.id}`, headers })).statusCode,
      200,
    );
    await assert.rejects(fs.stat(file));
    const second = await upload();
    await f.wb.send(f.thread.id, input, {}, false);
    const conflict = await app.inject({
      method: 'POST',
      url: `/api/threads/${f.thread.id}/messages`,
      headers,
      payload: { text: 'conflict', attachments: [second.id] },
    });
    assert.equal(conflict.statusCode, 200);
    assert.equal(conflict.json().queued, true);
    assert.equal((await app.inject({ url, headers })).json().length, 0);
    assert.equal(f.store.publicQueue()[0].preview, 'conflict');
    const queued = await app.inject({
      method: 'POST',
      url: `/api/threads/${f.thread.id}/messages`,
      headers,
      payload: { text: 'queued', attachments: [second.id], enqueue: true },
    });
    assert.equal(queued.statusCode, 200);
    assert.equal(
      (await app.inject({ method: 'DELETE', url: `${url}/${second.id}`, headers })).statusCode,
      409,
    );
    assert.ok(f.store.db.prepare('SELECT path FROM attachments WHERE id=?').get(second.id));
  } finally {
    await app.close();
    await f.close();
  }
});

test('file listing paginates all entries and Windows Git variants are inaccessible', async () => {
  const f = await fixture();
  try {
    const dir = path.join(f.root, 'files');
    await fs.mkdir(dir);
    await Promise.all(
      Array.from({ length: 1005 }, (_, i) =>
        fs.writeFile(path.join(dir, `entry-${String(i).padStart(4, '0')}.txt`), 'x'),
      ),
    );
    const first = await listFiles(dir, ''),
      last = await listFiles(dir, '', first.nextOffset!);
    assert.equal(first.total, 1005);
    assert.equal(first.entries.length, 1000);
    assert.equal(last.entries.length, 5);
    assert.equal(last.nextOffset, null);
    assert.equal(new Set([...first.entries, ...last.entries].map((e) => e.path)).size, 1005);
    if (process.platform === 'win32') {
      await fs.mkdir(path.join(dir, '.GIT'));
      await fs.writeFile(path.join(dir, '.GIT', 'config'), 'secret');
      await assert.rejects(safePath(dir, '.GIT/config'), /Git 内部/);
      assert.equal((await listFiles(dir, '')).total, 1005);
    }
  } finally {
    await f.close();
  }
});

test('public HTTP is rejected even with secure cookies; loopback HTTP remains supported', () => {
  for (const [origin, secure, allowed] of [
    ['http://review.example:18473', 'true', false],
    ['https://review.example', 'false', false],
    ['http://127.0.0.1:18473', 'false', true],
  ] as const) {
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', "await import('./server/config.ts')"],
      { env: { ...process.env, PUBLIC_ORIGIN: origin, COOKIE_SECURE: secure }, windowsHide: true },
    );
    assert.equal(result.status === 0, allowed, result.stderr.toString());
  }
});

test('cache evicts by bytes and LRU; event retention stays within budget and signals large snapshots', async () => {
  const cache = new BoundedCache<string>(2, 100, 80);
  cache.set('a', 'small');
  cache.set('b', 'small');
  cache.get('a');
  cache.set('c', 'small');
  assert.equal(cache.has('b'), false);
  assert.ok(cache.has('a'));
  cache.set('huge', 'x'.repeat(1000));
  assert.equal(cache.has('huge'), false);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-cloud-budget-'));
  const store = new Store(root, false, 8192);
  try {
    for (let i = 0; i < 50; i++)
      store.event('item/agentMessage/delta', { threadId: 't', delta: 'x'.repeat(700) });
    assert.ok(
      Number(
        store.db.prepare('SELECT SUM(length(CAST(params AS BLOB))) AS n FROM events').get()!.n,
      ) <= 8192,
    );
    assert.ok(store.replay(0)[0].seq > 1);
    assert.equal(
      store.event('item/completed', { threadId: 't', payload: 'x'.repeat(3000) }).method,
      'workbench/resyncRequired',
    );
    store.clearCache();
    store.event('test/event', {});
    assert.equal(store.replay(0).length, 1);
  } finally {
    store.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('service logs rotate within a fixed budget and old deployment logs are pruned', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-cloud-logs-'));
  try {
    const write = rotatingLog(root, 'server.out', 100, 2);
    write('x'.repeat(650));
    const files = await fs.readdir(root);
    assert.equal(files.length, 3);
    for (const file of files) assert.ok((await fs.stat(path.join(root, file))).size <= 100);
    const old = path.join(root, 'server-legacy.out.log');
    await fs.writeFile(old, 'legacy');
    await fs.utimes(old, 1, 1);
    await fs.writeFile(path.join(root, 'unrelated.txt'), 'keep');
    pruneLogs(root);
    await assert.rejects(fs.stat(old));
    assert.equal(await fs.readFile(path.join(root, 'unrelated.txt'), 'utf8'), 'keep');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('evicted live items do not overwrite native history with a streaming suffix', async () => {
  const f = await fixture();
  try {
    const text = 'x'.repeat(4 * 1024 * 1024 + 1);
    const item = { id: 'large-item', type: 'agentMessage', text };
    const native = f.bridge.threads.get(f.thread.id)!;
    native.turns = [{ id: 'turn', status: 'inProgress', items: [item] }];
    f.bridge.notify('item/started', { threadId: f.thread.id, turnId: 'turn', item });
    item.text += 'tail';
    f.bridge.notify('item/agentMessage/delta', {
      threadId: f.thread.id,
      turnId: 'turn',
      itemId: item.id,
      delta: 'tail',
    });
    assert.equal((await f.wb.read(f.thread.id)).thread.turns[0].items[0].text, text + 'tail');
    assert.ok(f.store.replay(0).some((e) => e.method === 'workbench/resyncRequired'));
  } finally {
    await f.close();
  }
});

test('malformed known protocol data is rejected; future fields are retained', async () => {
  // Nullable fields from the CLI 0.155.1 generated protocol must remain valid.
  assert.equal(
    itemSchema.parse({ id: 'a', type: 'agentMessage', text: 'ok', phase: null, questions: null })
      .text,
    'ok',
  );
  assert.equal(
    itemSchema.parse({ id: 'c', type: 'commandExecution', processId: null }).processId,
    undefined,
  );
  assert.equal(
    itemSchema.parse({
      id: 'w',
      type: 'webSearch',
      query: 'q',
      action: { type: 'search', query: null },
    }).action?.query,
    undefined,
  );
  assert.equal(
    requestParamsSchema.parse({ threadId: 't', turnId: null, cwd: null }).turnId,
    undefined,
  );
  assert.equal(
    requestParamsSchema.parse({ questions: [{ id: 'q', question: 'Explain', options: null }] })
      .questions?.[0].options,
    undefined,
  );
  assert.doesNotThrow(() =>
    parseRpcResult('account/read', { account: { type: 'chatgpt', email: null, planType: 'pro' } }),
  );
  assert.throws(() => parseRpcResult('thread/read', { thread: { id: 12 } }));
  assert.throws(() =>
    parseSocketMessage(
      JSON.stringify({
        type: 'event',
        event: { seq: 1, at: 0, method: 'turn/started', params: { threadId: 't' } },
      }),
    ),
  );
  const f = await fixture();
  try {
    const result = parseRpcResult('thread/read', {
      thread: { ...f.thread, futureField: 'kept' },
    }) as { thread: { futureField: string } };
    assert.equal(result.thread.futureField, 'kept');
    f.bridge.notify('turn/started', { threadId: f.thread.id, turn: { id: null } });
    assert.equal(f.wb.active.size, 0);
    assert.equal(f.store.replay(0).at(-1)?.method, 'workbench/warning');
  } finally {
    await f.close();
  }
});

test('remote control status notifications do not trigger warnings or alter conversation execution', async () => {
  const f = await fixture();
  try {
    await f.wb.send(f.thread.id, input, {}, false);
    const active = [...f.wb.active.values()];
    const cursor = f.store.cursor();
    for (const status of ['disabled', 'connecting', 'connected', 'errored', 'future-status']) {
      f.bridge.notify('remoteControl/status/changed', {
        status,
        serverName: 'remote-server',
        installationId: 'private-installation',
        environmentId: null,
      });
    }
    assert.equal(f.store.cursor(), cursor);
    assert.deepEqual([...f.wb.active.values()], active);
    assert.equal(f.bridge.ready, true);
    f.bridge.notify('thread/status/changed', { threadId: f.thread.id, status: { type: 'active' } });
    assert.equal(f.store.replay(cursor).at(-1)?.method, 'thread/status/changed');
    f.bridge.notify('turn/started', { threadId: f.thread.id, turn: { id: null } });
    assert.equal(f.store.replay(cursor).at(-1)?.method, 'workbench/warning');
    assert.deepEqual([...f.wb.active.values()], active);
  } finally {
    await f.close();
  }
});

test('service supervisor captures both streams and stops its other child on failure', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-cloud-supervisor-'));
  let child: ReturnType<typeof spawn> | undefined;
  try {
    await fs.mkdir(path.join(root, 'scripts'));
    await fs.mkdir(path.join(root, 'dist', 'server'), { recursive: true });
    await fs.writeFile(path.join(root, 'package.json'), '{"type":"module"}');
    // Load TypeScript with tsx so this regression does not depend on a prior build.
    const logging = (await fs.readFile('scripts/run-service.mjs', 'utf8')).replace(
      '../dist/server/logging.js',
      new URL('../server/logging.ts', import.meta.url).href,
    );
    await fs.writeFile(path.join(root, 'scripts', 'run-service.mjs'), logging);
    await fs.writeFile(
      path.join(root, 'dist', 'server', 'index.js'),
      "import fs from 'node:fs'; fs.writeFileSync('backend.pid', String(process.pid)); console.log('backend output'); console.error('backend error'); setInterval(() => {}, 1000);",
    );
    // Node serves as a harmless Caddy executable; its first argument is `run`.
    await fs.writeFile(
      path.join(root, 'run'),
      "import fs from 'node:fs'; console.log('proxy output'); console.error('proxy error'); const timer = setInterval(() => { if (fs.existsSync('backend.pid')) { clearInterval(timer); process.exitCode = 2; } }, 25);",
    );
    child = spawn(
      process.execPath,
      [
        '--import',
        import.meta.resolve('tsx'),
        'scripts/run-service.mjs',
        process.execPath,
        path.join(root, 'logs'),
      ],
      { cwd: root, windowsHide: true, stdio: 'pipe' },
    );
    let errors = '';
    child.stderr!.on('data', (chunk) => {
      errors += String(chunk);
    });
    const code = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Supervisor did not stop')), 10000);
      child!.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child!.once('exit', (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
    assert.equal(code, 1, errors);
    const pid = Number(await fs.readFile(path.join(root, 'backend.pid'), 'utf8'));
    assert.throws(() => process.kill(pid, 0), /ESRCH/);
    assert.match(
      await fs.readFile(path.join(root, 'logs', 'server.out.log'), 'utf8'),
      /backend output/,
    );
    assert.match(
      await fs.readFile(path.join(root, 'logs', 'caddy.err.log'), 'utf8'),
      /proxy error/,
    );
  } finally {
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      if (process.platform === 'win32')
        spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
      else child.kill('SIGKILL');
      await new Promise<void>((resolve) => child!.once('close', () => resolve()));
    }
    await fs.rm(root, { recursive: true, force: true });
  }
});
