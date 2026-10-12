import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import WebSocket from 'ws';
import { Store } from '../server/store.js';
import { Auth } from '../server/auth.js';
import { Workbench } from '../server/workbench.js';
import { safePath } from '../server/files.js';
import { buildApp } from '../server/app.js';
import { config } from '../server/config.js';
import { MockCodex } from './mock-codex.js';
import { applyThreadEvent } from '../shared/events.js';
import { applyRenderBatch, reconcileThreadSnapshot } from '../src/event-batch.js';

async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-test-'));
  const store = new Store(path.join(dir, 'data'), true);
  const bridge = new MockCodex(dir);
  const workbench = new Workbench(bridge, store, 2);
  const cleanup = async () => {
    workbench.dispose();
    bridge.stop();
    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  };
  return { dir, store, bridge, workbench, cleanup };
}
test('authentication: hashed password, session expiry, revocation and throttling', async () => {
  const f = await fixture();
  try {
    const auth = new Auth(f.store);
    await auth.change('test-password-long');
    assert.notEqual(f.store.get('passwordHash'), 'test-password-long');
    await assert.rejects(auth.login('wrong', 'one', 60000), /密码/);
    const token = await auth.login('test-password-long', 'one', 60000);
    assert.ok(auth.valid(token));
    assert.ok(!auth.valid('wrong-token'));
    assert.equal(
      f.store.db.prepare('SELECT token_hash FROM sessions').get()?.token_hash === token,
      false,
    );
    auth.logout(token);
    assert.ok(!auth.valid(token));
    const second = await auth.login('test-password-long', 'one', 60000);
    await auth.change('another-password-long');
    assert.ok(!auth.valid(second));
    const expired = await auth.login('another-password-long', 'two', -1);
    assert.ok(!auth.valid(expired));
    for (let i = 0; i < 10; i++) await assert.rejects(auth.login('wrong', 'attacker', 1000));
    await assert.rejects(auth.login('another-password-long', 'attacker', 1000), /频繁/);
  } finally {
    await f.cleanup();
  }
});
test('file boundary rejects traversal, absolute paths and escaping directory junctions', async () => {
  const f = await fixture();
  try {
    const root = path.join(f.dir, 'project');
    const outside = path.join(f.dir, 'outside');
    await fs.mkdir(root);
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, 'secret.txt'), 'secret');
    await fs.writeFile(path.join(root, 'ok.txt'), 'ok');
    assert.equal(await safePath(root, 'ok.txt'), await fs.realpath(path.join(root, 'ok.txt')));
    await assert.rejects(safePath(root, '../outside/secret.txt'));
    await assert.rejects(safePath(root, path.join(outside, 'secret.txt')));
    await fs.symlink(
      outside,
      path.join(root, 'link'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await assert.rejects(safePath(root, 'link/secret.txt'), /项目之外/);
  } finally {
    await f.cleanup();
  }
});
test('same-project conversations start concurrently; disconnect interrupts both', async () => {
  const f = await fixture();
  try {
    const a = (await f.workbench.create(f.dir, {})).thread;
    const b = (await f.workbench.create(f.dir, {})).thread;
    const input = [{ type: 'text', text: '慢速', text_elements: [] }];
    const results = await Promise.allSettled([
      f.workbench.send(a.id, input, {}, false),
      f.workbench.send(b.id, input, {}, false),
    ]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 2);
    assert.equal(f.store.publicQueue().length, 0);
    assert.equal(f.workbench.active.size, 2);
    f.bridge.stop();
    assert.equal(f.workbench.active.size, 0);
    assert.ok(f.store.metadata()[a.id].interrupted);
    assert.ok(f.store.metadata()[b.id].interrupted);
  } finally {
    await f.cleanup();
  }
});
test('first completed message gets an AI title within ten characters', async () => {
  const f = await fixture();
  try {
    const thread = (await f.workbench.create(f.dir, {})).thread;
    const renamed = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('标题生成超时')), 3000);
      f.workbench.on('event', (event) => {
        if (event.method === 'thread/name/updated' && event.params.threadId === thread.id) {
          clearTimeout(timer);
          resolve(event.params.threadName || '');
        }
      });
    });
    await f.workbench.send(
      thread.id,
      [{ type: 'text', text: '请对当前项目执行一次完整的代码审查并修复问题', text_elements: [] }],
      {},
      false,
    );
    assert.equal(await renamed, '项目代码审查与问题修');
    assert.equal(f.bridge.threads.size, 1);
  } finally {
    await f.cleanup();
  }
});
test('automatic title respects a manually renamed conversation', async () => {
  const f = await fixture();
  try {
    const thread = (await f.workbench.create(f.dir, {})).thread;
    await f.workbench.action(thread.id, 'rename', '手动标题');
    await f.workbench.send(
      thread.id,
      [{ type: 'text', text: '请对当前项目执行代码审查', text_elements: [] }],
      {},
      false,
    );
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(f.bridge.threads.get(thread.id)?.name, '手动标题');
    assert.equal(f.bridge.threads.size, 1);
  } finally {
    await f.cleanup();
  }
});
test('pending approvals survive browser reconnect and can only be answered once', async () => {
  const f = await fixture();
  try {
    await f.bridge.start();
    f.bridge.emit('request', {
      id: 9,
      method: 'item/commandExecution/requestApproval',
      params: { threadId: 't', turnId: 'u', command: 'echo test' },
    });
    const request = f.workbench.status().pending[0];
    assert.ok(request);
    assert.throws(() => f.workbench.answer(request.id, { decision: 'invalid' }));
    assert.equal(f.workbench.status().pending.length, 1);
    f.workbench.answer(request.id, { decision: 'decline' });
    assert.deepEqual(f.bridge.responses, [{ id: 9, result: { decision: 'decline' } }]);
    assert.throws(() => f.workbench.answer(request.id, { decision: 'accept' }), /已处理/);
    f.bridge.emit('request', {
      id: 10,
      method: 'item/tool/requestUserInput',
      params: { threadId: 't', questions: [{ id: 'q', question: '选择平台' }] },
    });
    const question = f.workbench.status().pending[0];
    f.workbench.answer(question.id, { answers: { q: 'Windows' } });
    assert.deepEqual(f.bridge.responses[1].result, { answers: { q: { answers: ['Windows'] } } });
  } finally {
    await f.cleanup();
  }
});
test('HTTP and WebSocket authentication, origin checks, replay and revocation', async () => {
  const f = await fixture();
  const auth = new Auth(f.store);
  await auth.change('test-password-long');
  const app = await buildApp(f.store, f.workbench, { logger: false });
  let ws: WebSocket | undefined;
  try {
    assert.equal((await app.inject('/api/projects')).statusCode, 401);
    const badOrigin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { password: 'test-password-long' },
      headers: { origin: 'https://evil.test' },
    });
    assert.equal(badOrigin.statusCode, 403);
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { password: 'test-password-long' },
      headers: { origin: config.origin },
    });
    assert.equal(login.statusCode, 200);
    const cookie = login.cookies[0];
    assert.equal(cookie.httpOnly, true);
    assert.equal(cookie.sameSite, 'Strict');
    const headers = { cookie: `${cookie.name}=${cookie.value}`, origin: config.origin };
    assert.equal((await app.inject({ url: '/api/projects', headers })).statusCode, 200);
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/projects',
          headers,
          payload: { name: 'Test', path: f.dir },
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/projects',
          headers: { cookie: headers.cookie },
          payload: { name: 'Test', path: f.dir },
        })
      ).statusCode,
      403,
    );
    const first = f.workbench.publish('test/one', {});
    f.workbench.publish('test/two', {});
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address() as { port: number };
    ws = new WebSocket(`ws://127.0.0.1:${address.port}/api/events?after=${first.seq}`, { headers });
    const messages: any[] = [];
    const synced = new Promise<void>((resolve) =>
      ws!.on('message', (raw) => {
        const msg = JSON.parse(String(raw));
        messages.push(msg);
        if (msg.type === 'synced') resolve();
      }),
    );
    await synced;
    assert.equal(messages[0].reset, false);
    assert.ok(messages.some((m) => m.event?.method === 'test/two'));
    const closed = once(ws, 'close');
    await app.inject({ method: 'POST', url: '/api/auth/logout', headers, payload: {} });
    await closed;
    assert.equal((await app.inject({ url: '/api/projects', headers })).statusCode, 401);
  } finally {
    ws?.terminate();
    await app.close();
    await f.cleanup();
  }
});
test('public responses tell crawlers not to index the workbench', async () => {
  const f = await fixture();
  const app = await buildApp(f.store, f.workbench, { logger: false });
  try {
    const robots = await app.inject('/robots.txt');
    assert.equal(robots.statusCode, 200);
    assert.match(robots.headers['content-type'] || '', /^text\/plain/);
    assert.equal(robots.body, 'User-agent: *\nDisallow: /\n');
    for (const response of [robots, await app.inject('/'), await app.inject('/api/projects')]) {
      assert.equal(
        response.headers['x-robots-tag'],
        'noindex, nofollow, noarchive, nosnippet, noimageindex',
      );
    }
  } finally {
    await app.close();
    await f.cleanup();
  }
});
test('event reduction preserves streaming output and canonical completion replaces deltas', () => {
  const bridge = new MockCodex();
  let thread = bridge.makeThread();
  const event = (method: string, params: any) => ({
    seq: 1,
    method,
    params: { threadId: thread.id, turnId: 'turn', ...params },
    at: 0,
  });
  thread = applyThreadEvent(
    thread,
    event('item/agentMessage/delta', { itemId: 'answer', delta: 'Hello' }),
  );
  thread = applyThreadEvent(
    thread,
    event('item/agentMessage/delta', { itemId: 'answer', delta: ' world' }),
  );
  assert.equal(thread.turns[0].items[0].text, 'Hello world');
  thread = applyThreadEvent(
    thread,
    event('item/completed', { item: { id: 'answer', type: 'agentMessage', text: 'Hello world!' } }),
  );
  assert.equal(thread.turns[0].items[0].text, 'Hello world!');
  thread = applyThreadEvent(
    thread,
    event('turn/completed', { turn: { id: 'turn', status: 'completed', items: [] } }),
  );
  assert.equal(thread.turns[0].items.length, 1);
});

test('partial turn completion preserves streamed user messages and tool output', () => {
  const thread = new MockCodex().makeThread();
  thread.turns = [
    {
      id: 'turn',
      status: 'inProgress',
      items: [
        { id: 'user', type: 'userMessage', content: [{ type: 'text', text: 'hello' }] },
        { id: 'tool', type: 'commandExecution', aggregatedOutput: 'done' },
        { id: 'answer', type: 'agentMessage', text: 'partial' },
      ],
    },
  ];
  const next = applyThreadEvent(thread, {
    seq: 1,
    at: 0,
    method: 'turn/completed',
    params: {
      threadId: thread.id,
      turn: {
        id: 'turn',
        status: 'completed',
        items: [{ id: 'answer', type: 'agentMessage', text: 'complete' }],
      },
    },
  });
  assert.deepEqual(
    next.turns[0].items.map((item) => item.id),
    ['user', 'tool', 'answer'],
  );
  assert.equal(next.turns[0].items[2].text, 'complete');
});

test('history resync retains loaded pages and turns rendered while native history was being read', () => {
  const thread = new MockCodex().makeThread();
  thread.turns = [
    { id: 'older', status: 'completed', items: [] },
    { id: 'latest', status: 'inProgress', items: [] },
  ];
  const event = {
    seq: 11,
    at: 0,
    method: 'item/completed',
    params: {
      threadId: thread.id,
      turnId: 'latest',
      item: { id: 'answer', type: 'agentMessage', text: 'complete' },
    },
  };
  const live = applyRenderBatch(thread, [event]);
  const snapshot = { ...thread, turns: thread.turns.slice(1), renderCursor: 11 };
  const next = reconcileThreadSnapshot(live, snapshot, [event], 10, 11);
  assert.deepEqual(
    next.turns.map((turn) => turn.id),
    ['older', 'latest'],
  );
  assert.equal(next.turns[1].items[0].text, 'complete');
  const canonical = {
    ...snapshot,
    turns: [
      {
        ...snapshot.turns[0],
        items: [
          {
            id: 'answer',
            type: 'agentMessage',
            text: 'canonical',
          },
        ],
      },
    ],
  };
  const finished = {
    ...canonical,
    turns: [{ ...canonical.turns[0], status: 'completed' }],
  };
  assert.equal(
    reconcileThreadSnapshot(live, finished, [event], 10, 11).turns[1].items[0].text,
    'canonical',
  );
  assert.equal(
    reconcileThreadSnapshot(live, canonical, [event], 11, 11).turns[1].items[0].text,
    'canonical',
  );
  const later = {
    ...event,
    seq: 12,
    params: { ...event.params, item: { ...event.params.item, text: 'later' } },
  };
  const replayed = applyRenderBatch(snapshot, [later]);
  assert.equal(
    reconcileThreadSnapshot(live, replayed, [event, later], 10, 11).turns[1].items[0].text,
    'later',
  );
});

test('render batches reconcile snapshots without lost or duplicate text and ignore other threads', () => {
  const bridge = new MockCodex();
  const thread = bridge.makeThread();
  const deltas = Array.from({ length: 180 }, (_, i) => ({
    seq: i + 1,
    method: 'item/agentMessage/delta',
    at: 0,
    params: { threadId: thread.id, turnId: 'turn', itemId: 'answer', delta: String(i) + ',' },
  }));
  const first = applyRenderBatch(thread, deltas.slice(0, 75));
  // A fetched snapshot may already include the first half of a queued batch.
  const snapshot = { ...first, renderCursor: 75 };
  const final = applyRenderBatch(snapshot, deltas.slice(50));
  assert.equal(final.turns[0].items[0].text, deltas.map((e) => e.params.delta).join(''));
  assert.strictEqual(applyRenderBatch(final, deltas), final);
  assert.strictEqual(
    applyRenderBatch(final, [
      {
        ...deltas[0],
        seq: 181,
        params: {
          ...deltas[0].params,
          threadId: 'another-thread',
        },
      },
    ]),
    final,
  );
  assert.strictEqual(
    applyThreadEvent(final, {
      seq: 182,
      at: 0,
      method: 'unknown/notification',
      params: { threadId: thread.id, turnId: 'should-not-exist' },
    }),
    final,
  );
});

test('file browsing reuses a recently read directory and invalidates it on disconnect', async () => {
  const f = await fixture();
  try {
    const thread = f.bridge.makeThread();
    const original = f.bridge.call.bind(f.bridge);
    let reads = 0;
    f.bridge.call = async (method, params) => {
      if (method === 'thread/read') reads++;
      return original(method, params);
    };
    await f.workbench.read(thread.id);
    const before = reads;
    assert.equal(await f.workbench.threadDirectory(thread.id), thread.cwd);
    assert.equal(await f.workbench.threadDirectory(thread.id), thread.cwd);
    assert.equal(reads, before);
    f.bridge.emit('disconnect', 'test disconnect');
    assert.equal(await f.workbench.threadDirectory(thread.id), thread.cwd);
    assert.equal(reads, before + 1);
    assert.equal(f.workbench.status().testMode, true);
  } finally {
    await f.cleanup();
  }
});
test('new paginated history is empty before materialization; unrelated errors are not swallowed', async () => {
  const f = await fixture();
  try {
    const thread = f.bridge.makeThread();
    thread.historyMode = 'paginated';
    const original = f.bridge.call.bind(f.bridge);
    let materialized = false;
    let failure = false;
    f.bridge.call = async (method, params) => {
      if (method === 'thread/turns/list') {
        if (failure) throw new Error('disk permission denied');
        if (!materialized)
          throw new Error(
            `thread ${thread.id} is not materialized yet; thread/turns/list is unavailable before first user message`,
          );
        return {
          data: [
            {
              id: 'turn',
              status: 'completed',
              items: [{ id: 'item', type: 'agentMessage', text: 'saved' }],
            },
          ],
          nextCursor: 'older',
        };
      }
      return original(method, params);
    };
    assert.deepEqual((await f.workbench.read(thread.id)).thread.turns, []);
    materialized = true;
    const page = await f.workbench.read(thread.id);
    assert.equal(page.nextCursor, 'older');
    assert.equal(page.thread.turns[0].items[0].text, 'saved');
    failure = true;
    await assert.rejects(f.workbench.read(thread.id), /disk permission/);
  } finally {
    await f.cleanup();
  }
});

test('history backend changes fall back to full native history without swallowing failures', async () => {
  const f = await fixture();
  try {
    const thread = f.bridge.makeThread();
    thread.historyMode = 'paginated';
    const original = f.bridge.call.bind(f.bridge);
    let fallbackFailure = false;
    f.bridge.call = async (method, params) => {
      if (method === 'thread/turns/list') throw new Error('list_turns is not supported yet');
      if (method === 'thread/read' && params?.includeTurns) {
        if (fallbackFailure) throw new Error('history disk failure');
        return {
          thread: {
            ...thread,
            historyMode: 'legacy',
            turns: [
              {
                id: 'preserved',
                status: 'completed',
                items: [{ id: 'answer', type: 'agentMessage', text: 'native history' }],
              },
            ],
          },
        };
      }
      return original(method, params);
    };
    for (const cursor of [undefined, 'older']) {
      const result = await f.workbench.read(thread.id, cursor);
      assert.equal(result.thread.turns[0].items[0].text, 'native history');
      assert.equal(result.nextCursor, null);
      assert.equal(result.thread.historyMode, 'legacy');
    }
    fallbackFailure = true;
    await assert.rejects(f.workbench.read(thread.id), /history disk failure/);
    thread.path = path.join(f.dir, 'not-materialized.jsonl');
    thread.preview = '';
    assert.deepEqual((await f.workbench.read(thread.id)).thread.turns, []);
    await fs.writeFile(thread.path as string, 'existing history');
    await assert.rejects(f.workbench.read(thread.id), /history disk failure/);
  } finally {
    await f.cleanup();
  }
});
