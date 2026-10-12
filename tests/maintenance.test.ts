import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../server/store.js';
import { Workbench } from '../server/workbench.js';
import { clearLogs } from '../server/maintenance.js';
import { MockCodex } from './mock-codex.js';
import { buildApp } from '../server/app.js';
import { Auth } from '../server/auth.js';
import { config } from '../server/config.js';

async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-cloud-maintenance-'));
  const store = new Store(dir, true),
    bridge = new MockCodex(dir);
  const wb = new Workbench(bridge, store, 2);
  const thread = (await wb.create(dir, {})).thread;
  await new Promise((resolve) => setImmediate(resolve));
  return {
    dir,
    store,
    bridge,
    wb,
    thread,
    async close() {
      wb.dispose();
      bridge.stop();
      store.close();
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}
async function attachment(store: Store, threadId: string) {
  const id = randomUUID(),
    dir = path.join(store.dir, 'uploads', id),
    file = path.join(dir, 'owned.txt');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(file, 'attachment payload');
  store.db
    .prepare('INSERT INTO attachments(id,thread_id,name,mime,size,path) VALUES(?,?,?,?,?,?)')
    .run(id, threadId, 'owned.txt', 'text/plain', 18, file);
  return { id, dir, file };
}

test('cache cleanup removes persisted replay payloads without deleting history, project or attachments', async () => {
  const f = await fixture();
  try {
    f.store.addProject('keep', f.dir);
    const file = await attachment(f.store, f.thread.id);
    f.store.event('test/cache', { payload: 'cached-secret' });
    f.store.db.prepare('INSERT INTO sessions VALUES(?,?)').run('expired', 1);
    const before = f.store.cursor();
    assert.ok(f.wb.clearCache().events > 0);
    assert.ok(f.store.cursor() > before, 'replay cursor must not go backwards');
    const disk = new DatabaseSync(path.join(f.dir, 'workbench.sqlite'), { readOnly: true });
    try {
      assert.equal(
        disk.prepare("SELECT COUNT(*) AS n FROM events WHERE params LIKE '%cached-secret%'").get()!
          .n,
        0,
      );
      assert.equal(disk.prepare('SELECT COUNT(*) AS n FROM sessions').get()!.n, 0);
      assert.equal(disk.prepare('SELECT COUNT(*) AS n FROM projects').get()!.n, 1);
    } finally {
      disk.close();
    }
    assert.ok(f.bridge.threads.has(f.thread.id));
    assert.equal(await fs.readFile(file.file, 'utf8'), 'attachment payload');
    await f.wb.send(f.thread.id, [{ type: 'text', text: '慢速' }], {}, false);
    assert.throws(() => f.wb.clearCache(), /任务和操作/);
  } finally {
    await f.close();
  }
});

test('log cleanup truncates on-disk logs and preserves unrelated files and linked targets', async () => {
  const f = await fixture();
  try {
    const logs = path.join(f.dir, 'logs');
    await fs.mkdir(logs);
    const log = path.join(logs, 'server.log'),
      other = path.join(logs, 'notes.txt');
    await fs.writeFile(log, 'real log contents');
    await fs.writeFile(other, 'keep');
    const external = path.join(f.dir, 'external.log');
    await fs.writeFile(external, 'preserve linked file');
    await fs.link(external, path.join(logs, 'linked.log'));
    await assert.rejects(clearLogs(f.store), /链接/);
    await fs.unlink(path.join(logs, 'linked.log'));
    const result = await clearLogs(f.store);
    assert.deepEqual(result.failed, []);
    assert.equal(result.cleared, 1);
    assert.ok(result.bytes > 0);
    assert.equal((await fs.stat(log)).size, 0);
    assert.equal(await fs.readFile(other, 'utf8'), 'keep');
    assert.equal(await fs.readFile(external, 'utf8'), 'preserve linked file');
  } finally {
    await f.close();
  }
});

test('permanent deletion invokes native delete and removes owned files and database rows only', async () => {
  const f = await fixture();
  try {
    const other = (await f.wb.create(f.dir, {})).thread;
    const owned = await attachment(f.store, f.thread.id),
      kept = await attachment(f.store, other.id);
    f.store.pin(f.thread.id, true);
    f.store.pin(other.id, true);
    f.store.enqueue(f.thread.id, f.dir, [{ text: 'queued secret' }], {}, 'queued secret');
    f.store.event('workbench/queueChanged', {
      queued: [{ threadId: f.thread.id, preview: 'queued secret' }, { threadId: other.id }],
    });
    f.store.event('item/completed', { threadId: f.thread.id, item: { text: 'owned secret' } });
    f.store.event('item/completed', { threadId: other.id, item: { text: 'keep message' } });
    await f.wb.action(f.thread.id, 'rename', 'delete target');
    const result = await f.wb.deleteThread(f.thread.id);
    assert.equal(result.attachments, 1);
    assert.ok(!f.bridge.threads.has(f.thread.id));
    assert.ok(f.bridge.threads.has(other.id));
    assert.equal(
      await fs.stat(owned.dir).then(
        () => true,
        () => false,
      ),
      false,
    );
    assert.equal(await fs.readFile(kept.file, 'utf8'), 'attachment payload');
    for (const table of ['attachments', 'message_queue', 'runs', 'thread_deletions'])
      assert.equal(
        f.store.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE thread_id=?`).get(f.thread.id)!
          .n,
        0,
      );
    assert.equal(f.store.metadata()[f.thread.id], undefined);
    assert.ok(f.store.metadata()[other.id]);
    assert.equal(
      f.store.db
        .prepare(
          "SELECT COUNT(*) AS n FROM events WHERE params LIKE '%owned secret%' OR params LIKE '%queued secret%'",
        )
        .get()!.n,
      0,
    );
    assert.equal(
      f.store.db
        .prepare("SELECT COUNT(*) AS n FROM events WHERE params LIKE '%keep message%'")
        .get()!.n,
      1,
    );
  } finally {
    await f.close();
  }
});

test('active tasks and in-flight operations cannot be deleted', async () => {
  const f = await fixture();
  try {
    await f.wb.send(f.thread.id, [{ type: 'text', text: '慢速' }], {}, false);
    await assert.rejects(f.wb.deleteThread(f.thread.id), /停止/);
    await f.wb.interrupt(f.thread.id);
    let release!: () => void;
    const hold = f.wb.exclusive(
      f.thread.id,
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    await assert.rejects(f.wb.deleteThread(f.thread.id), /另一个操作/);
    release();
    await hold;
    assert.ok(f.bridge.threads.has(f.thread.id));
  } finally {
    await f.close();
  }
});

test('native deletion failure preserves files and records, with a persisted retry journal', async () => {
  const f = await fixture();
  try {
    const owned = await attachment(f.store, f.thread.id);
    const call = f.bridge.call.bind(f.bridge);
    f.bridge.call = async (method, params) => {
      if (method === 'thread/delete') throw new Error('upstream unavailable');
      return call(method, params);
    };
    await assert.rejects(f.wb.deleteThread(f.thread.id), /原生删除未完成/);
    assert.equal(await fs.readFile(owned.file, 'utf8'), 'attachment payload');
    assert.equal(f.store.deletion(f.thread.id)!.native_deleted, 0);
    f.bridge.call = call;
    await f.wb.deleteThread(f.thread.id);
    assert.equal(f.store.deletion(f.thread.id), undefined);
    assert.equal(
      await fs.stat(owned.dir).then(
        () => true,
        () => false,
      ),
      false,
    );
  } finally {
    await f.close();
  }
});

test('an invalid attachment target blocks native deletion and never touches the project', async () => {
  const f = await fixture();
  try {
    const owned = await attachment(f.store, f.thread.id);
    const projectFile = path.join(f.dir, 'project-file.txt');
    await fs.writeFile(projectFile, 'keep project');
    f.store.db.prepare('UPDATE attachments SET path=? WHERE id=?').run(projectFile, owned.id);
    await assert.rejects(f.wb.deleteThread(f.thread.id), /上传目录/);
    assert.ok(f.bridge.threads.has(f.thread.id));
    assert.equal(await fs.readFile(projectFile, 'utf8'), 'keep project');
  } finally {
    await f.close();
  }
});

test('native success with incomplete local cleanup can be resumed without deleting native data twice', async () => {
  const f = await fixture();
  try {
    const owned = await attachment(f.store, f.thread.id);
    const call = f.bridge.call.bind(f.bridge);
    let deletes = 0;
    f.bridge.call = async (method, params) => {
      const result = await call(method, params);
      if (method === 'thread/delete') {
        deletes++;
        f.store.db
          .prepare('UPDATE attachments SET path=? WHERE id=?')
          .run(path.join(f.dir, 'outside.txt'), owned.id);
      }
      return result;
    };
    await assert.rejects(f.wb.deleteThread(f.thread.id), /上传目录/);
    assert.equal(f.store.deletion(f.thread.id)!.native_deleted, 1);
    f.store.db.prepare('UPDATE attachments SET path=? WHERE id=?').run(owned.file, owned.id);
    await f.wb.deleteThread(f.thread.id);
    assert.equal(deletes, 1);
    assert.equal(f.store.deletion(f.thread.id), undefined);
  } finally {
    await f.close();
  }
});

test('cleanup and permanent deletion require authentication, origin and explicit confirmation', async () => {
  const f = await fixture();
  await new Auth(f.store).change('test-password-long');
  const app = await buildApp(f.store, f.wb, { logger: false });
  try {
    assert.equal(
      (
        await app.inject({
          method: 'DELETE',
          url: `/api/threads/${f.thread.id}`,
          headers: { origin: config.origin },
          payload: { confirm: true },
        })
      ).statusCode,
      401,
    );
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: config.origin },
      payload: { password: 'test-password-long' },
    });
    const headers = {
      cookie: `${login.cookies[0].name}=${login.cookies[0].value}`,
      origin: config.origin,
    };
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/maintenance',
          headers,
          payload: { action: 'cache' },
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/maintenance',
          headers: { ...headers, origin: 'https://invalid.test' },
          payload: { action: 'cache', confirm: true },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await app.inject({
          method: 'DELETE',
          url: `/api/threads/${f.thread.id}`,
          headers,
          payload: { confirm: true },
        })
      ).statusCode,
      200,
    );
    assert.ok(!f.bridge.threads.has(f.thread.id));
  } finally {
    await app.close();
    await f.close();
  }
});
