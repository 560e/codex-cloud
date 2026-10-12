import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../server/store.js';
import { Workbench } from '../server/workbench.js';
import { MockCodex } from './mock-codex.js';
import { buildApp } from '../server/app.js';
import { Auth } from '../server/auth.js';
import { config } from '../server/config.js';
import { parseRpcResult } from '../shared/protocol.js';
import type { Json } from '../shared/types.js';

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-native-'));
  const cwd = path.join(root, 'project');
  await fs.mkdir(cwd);
  const store = new Store(path.join(root, 'data'));
  const bridge = new MockCodex(cwd);
  const wb = new Workbench(bridge, store, 2);
  const thread = (await wb.create(cwd, {})).thread;
  const project = store.addProject('project', cwd);
  const app = await buildApp(store, wb, { logger: false });
  await new Auth(store).change('test-native-password');
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { origin: config.origin },
    payload: { password: 'test-native-password' },
  });
  const headers = {
    origin: config.origin,
    cookie: `${login.cookies[0].name}=${login.cookies[0].value}`,
  };
  return {
    root,
    cwd,
    store,
    bridge,
    wb,
    thread,
    project,
    app,
    headers,
    async close() {
      await app.close();
      bridge.stop();
      store.close();
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}
const compact = (f: Awaited<ReturnType<typeof fixture>>) =>
  f.wb.send(f.thread.id, [], {}, false, false, undefined, { type: 'compact' });
async function until(fn: () => boolean) {
  for (let n = 0; n < 150; n++) {
    if (fn()) return;
    await delay(20);
  }
  assert.fail('condition not reached');
}

test('native review validates targets and runs inline alongside another same-project conversation', async () => {
  const f = await fixture();
  try {
    const calls: { method: string; params: Json }[] = [];
    const original = f.bridge.call.bind(f.bridge);
    f.bridge.call = async (method, params = {}) => {
      calls.push({ method, params });
      return original(method, params);
    };
    const url = `/api/threads/${f.thread.id}/native-task`;
    assert.equal(
      (
        await f.app.inject({
          method: 'POST',
          url,
          headers: { origin: config.origin },
          payload: { type: 'compact' },
        })
      ).statusCode,
      401,
    );
    assert.equal(
      (
        await f.app.inject({
          method: 'POST',
          url,
          headers: { ...f.headers, origin: 'https://evil.test' },
          payload: { type: 'compact' },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await f.app.inject({
          method: 'POST',
          url,
          headers: f.headers,
          payload: { type: 'review', target: { type: 'commit', sha: '; command' } },
        })
      ).statusCode,
      400,
    );
    const response = await f.app.inject({
      method: 'POST',
      url,
      headers: f.headers,
      payload: { type: 'review', target: { type: 'baseBranch', branch: 'main' } },
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(calls.find((c) => c.method === 'review/start')!.params, {
      threadId: f.thread.id,
      delivery: 'inline',
      target: { type: 'baseBranch', branch: 'main' },
    });
    const other = (await f.wb.create(f.cwd, {})).thread;
    await f.wb.send(other.id, [{ type: 'text', text: '慢速 parallel' }], {}, false);
    assert.equal(f.wb.active.size, 2);
    assert.equal(f.store.publicQueue().length, 0);
    await f.wb.interrupt(f.thread.id);
    assert.equal(f.wb.active.size, 1);
    assert.equal(f.wb.active.has(other.id), true);
    assert.throws(() => parseRpcResult('review/start', { turn: {}, reviewThreadId: f.thread.id }));
  } finally {
    await f.close();
  }
});

test('compaction keeps its conversation occupied after acknowledgement and stop waits for the native turn id', async () => {
  const f = await fixture();
  try {
    const original = f.bridge.call.bind(f.bridge);
    const interrupts: Json[] = [];
    f.bridge.call = async (method, params = {}) => {
      if (method === 'thread/compact/start') return {};
      if (method === 'turn/interrupt') {
        interrupts.push(params);
        f.bridge.notify('turn/completed', {
          threadId: f.thread.id,
          turn: { id: params.turnId, status: 'interrupted', items: [] },
        });
        return {};
      }
      return original(method, params);
    };
    assert.deepEqual(await compact(f), { accepted: true });
    assert.equal(f.wb.active.size, 1);
    await assert.rejects(
      f.wb.send(f.thread.id, [], {}, false, false, undefined, {
        type: 'review',
        target: { type: 'uncommittedChanges' },
      }),
      /此会话正在运行/,
    );
    const supplier = f.wb.providers.save({
      name: 'test',
      baseUrl: 'https://example.test/v1',
      model: 'test',
      apiKey: 'test-key',
    });
    await assert.rejects(f.wb.switchProvider(supplier.id), /结束运行任务/);
    await assert.rejects(f.wb.send(f.thread.id, [], {}, true), /压缩过程中/);
    await f.wb.enqueue(f.thread.id, [{ type: 'text', text: 'queued' }], {}, 'queued');
    await f.wb.interrupt(f.thread.id);
    assert.equal(interrupts.length, 0);
    assert.equal(f.store.publicQueue()[0].state, 'paused');
    f.bridge.notify('turn/started', {
      threadId: f.thread.id,
      turn: { id: 'real-turn', status: 'inProgress', items: [] },
    });
    await until(() => !f.wb.active.size);
    assert.deepEqual(interrupts, [{ threadId: f.thread.id, turnId: 'real-turn' }]);
  } finally {
    await f.close();
  }
});

test('compaction completion drains queued messages, while failure and disconnect pause them', async () => {
  const f = await fixture();
  try {
    await compact(f);
    await f.wb.enqueue(f.thread.id, [{ type: 'text', text: 'after compact' }], {}, 'after compact');
    await until(() => f.store.publicQueue().length === 0 && !f.wb.active.size);
    assert.equal(f.bridge.threads.get(f.thread.id)!.turns.length, 2);
    const original = f.bridge.call.bind(f.bridge);
    f.bridge.call = async (method, params) =>
      method === 'thread/compact/start' ? {} : original(method, params);
    await compact(f);
    await f.wb.enqueue(f.thread.id, [{ type: 'text', text: 'must pause' }], {}, 'must pause');
    f.bridge.notify('turn/completed', {
      threadId: f.thread.id,
      turn: { id: 'failed-turn', status: 'failed', items: [], error: { message: 'failed' } },
    });
    assert.equal(f.store.publicQueue()[0].state, 'paused');
    f.wb.queueAction(f.store.publicQueue()[0].id, 'cancel');
    await compact(f);
    f.bridge.stop();
    assert.equal(f.wb.active.size, 0);
  } finally {
    await f.close();
  }
});

test('unsupported compaction releases only its pending lock; unknown outcome retains it', async () => {
  const f = await fixture();
  try {
    const original = f.bridge.call.bind(f.bridge);
    let unknown = false;
    f.bridge.call = async (method, params) => {
      if (method === 'thread/compact/start')
        throw unknown
          ? new Error('unknown outcome')
          : Object.assign(new Error('unsupported'), { rpcCode: -32601 });
      return original(method, params);
    };
    const response = await f.app.inject({
      method: 'POST',
      url: `/api/threads/${f.thread.id}/native-task`,
      headers: f.headers,
      payload: { type: 'compact' },
    });
    assert.equal(response.statusCode, 501);
    assert.equal(f.wb.active.size, 0);
    unknown = true;
    await assert.rejects(compact(f), /unknown outcome/);
    assert.equal(f.wb.active.size, 1);
    f.bridge.stop();
    assert.equal(f.wb.active.size, 0);
  } finally {
    await f.close();
  }
});

test('file search filters escaped, internal and stale paths; submitted references are validated', async () => {
  const f = await fixture();
  try {
    await fs.writeFile(path.join(f.cwd, 'hello.ts'), 'secret file content');
    await fs.mkdir(path.join(f.cwd, '.git'));
    await fs.writeFile(path.join(f.cwd, '.git', 'config'), 'private');
    await fs.writeFile(path.join(f.root, 'outside.txt'), 'outside');
    await fs.symlink(
      f.root,
      path.join(f.cwd, 'escape'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const original = f.bridge.call.bind(f.bridge);
    const inputs: Json[][] = [];
    f.bridge.call = async (method, params = {}) => {
      if (method === 'fuzzyFileSearch')
        return {
          files: [
            'hello.ts',
            'hello.ts',
            '../outside.txt',
            '.git/config',
            'escape/outside.txt',
            'missing.ts',
          ].map((file) => ({
            root: f.cwd,
            path: file,
            match_type: 'file',
            file_name: file,
            score: 1,
            indices: null,
          })),
        };
      if (method === 'turn/start') inputs.push(params.input);
      return original(method, params);
    };
    assert.equal(
      (await f.app.inject({ url: `/api/file-search?thread=${f.thread.id}&query=hello` }))
        .statusCode,
      401,
    );
    const found = await f.app.inject({
      url: `/api/file-search?thread=${f.thread.id}&query=hello`,
      headers: f.headers,
    });
    assert.equal(found.statusCode, 200, found.body);
    assert.deepEqual(found.json(), { files: [{ path: 'hello.ts', name: 'hello.ts' }] });
    const url = `/api/threads/${f.thread.id}/messages`;
    for (const file of ['../outside.txt', '.git/config', 'escape/outside.txt']) {
      assert.equal(
        (
          await f.app.inject({
            method: 'POST',
            url,
            headers: f.headers,
            payload: { text: 'review', fileReferences: [file] },
          })
        ).statusCode,
        403,
      );
    }
    const sent = await f.app.inject({
      method: 'POST',
      url,
      headers: f.headers,
      payload: { text: '慢速', fileReferences: ['hello.ts'] },
    });
    assert.equal(sent.statusCode, 200, sent.body);
    assert.ok(JSON.stringify(inputs).includes('hello.ts'));
    assert.ok(!JSON.stringify(inputs).includes('secret file content'));
  } finally {
    await f.close();
  }
});

test('stop received during review submission interrupts the late result', async () => {
  const f = await fixture();
  try {
    const original = f.bridge.call.bind(f.bridge);
    let entered = false;
    let resolve!: (value: Json) => void;
    const replies: Json[] = [];
    f.bridge.call = async (method, params = {}) => {
      if (method === 'review/start') {
        entered = true;
        return new Promise<Json>((r) => {
          resolve = r;
        });
      }
      if (method === 'turn/interrupt') {
        replies.push(params);
        return {};
      }
      return original(method, params);
    };
    const started = f.wb.send(f.thread.id, [], {}, false, false, undefined, {
      type: 'review',
      target: { type: 'custom', instructions: 'check' },
    });
    await until(() => entered);
    await f.wb.interrupt(f.thread.id);
    resolve({
      turn: { id: 'late-review', status: 'inProgress', items: [] },
      reviewThreadId: f.thread.id,
    });
    await started;
    assert.deepEqual(replies, [{ threadId: f.thread.id, turnId: 'late-review' }]);
    assert.equal(f.wb.active.size, 1);
  } finally {
    await f.close();
  }
});
