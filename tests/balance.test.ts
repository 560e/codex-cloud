import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { queryBalance, queryBalanceAfterTurn } from '../server/balance.js';
import { balanceErrorText } from '../shared/balance.js';
import { Store } from '../server/store.js';
import { Workbench } from '../server/workbench.js';
import { MockCodex } from './mock-codex.js';
import { applyThreadEvent } from '../shared/events.js';
import type { UpstreamBalance } from '../shared/types.js';

const provider = {
  id: 'p',
  name: '测试上游',
  baseUrl: '',
  apiKey: 'secret-test-only',
  model: 'm',
  models: [],
};

test('balance HTTP query normalizes URLs, authenticates, extracts fallbacks and safely handles errors', async () => {
  let body: unknown = { remaining: 0, is_active: false };
  let mode = 'normal';
  let requestedPath = '';
  const server = createServer((req, res) => {
    assert.equal(req.method, 'GET');
    assert.equal(req.headers.authorization, 'Bearer secret-test-only');
    requestedPath = req.url!;
    if (mode === 'timeout') return;
    if (mode === 'redirect') {
      res.writeHead(302, { Location: '/elsewhere' });
      res.end();
      return;
    }
    if (mode === 'error') {
      res.writeHead(500);
      res.end('secret-test-only');
      return;
    }
    res.end(mode === 'large' ? 'x'.repeat(70000) : JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    for (const [base, expected] of [
      ['', '/v1/usage'],
      ['/v1/', '/v1/usage'],
      ['/prefix/v1', '/prefix/v1/usage'],
    ]) {
      const balance = await queryBalance({ ...provider, baseUrl: origin + base });
      assert.equal(requestedPath, expected);
      assert.equal(balance.status, 'available');
      assert.equal(balance.remaining, 0);
      assert.equal(balance.isValid, false);
      assert.equal(balance.unit, 'USD');
      assert.ok(!JSON.stringify(balance).includes(provider.apiKey));
    }
    body = { quota: { remaining: '12.345678', unit: 'CNY' }, isValid: false };
    assert.equal((await queryBalance({ ...provider, baseUrl: origin })).remaining, 12.345678);
    body = { balance: -1, unit: 'credits' };
    assert.equal((await queryBalance({ ...provider, baseUrl: origin })).remaining, -1);
    for (body of [
      {},
      { remaining: null },
      { remaining: '' },
      { remaining: true },
      { remaining: 'NaN' },
    ])
      assert.equal((await queryBalance({ ...provider, baseUrl: origin })).status, 'error');
    for (mode of ['error', 'redirect', 'large', 'timeout']) {
      const balance = await queryBalance({ ...provider, baseUrl: origin }, 100);
      assert.equal(balance.status, 'error');
      assert.equal(
        balance.errorCode,
        mode === 'timeout' ? 'timeout' : mode === 'large' ? 'invalid_response' : 'http',
      );
      if (mode === 'error') assert.equal(balance.httpStatus, 500);
      assert.ok(!JSON.stringify(balance).includes(provider.apiKey));
    }
    assert.equal((await queryBalance(null)).status, 'unavailable');
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('background balance queries retry transient failures with a longer timeout and keep safe diagnostics', async () => {
  let calls = 0;
  const result = await queryBalanceAfterTurn(provider, async (received, timeout) => {
    assert.equal(received, provider);
    assert.equal(timeout, 15000);
    calls++;
    return calls === 1
      ? { status: 'error', checkedAt: Date.now(), errorCode: 'timeout' }
      : calls === 2
        ? { status: 'error', checkedAt: Date.now(), errorCode: 'http', httpStatus: 429 }
        : { status: 'available', checkedAt: Date.now(), remaining: 0, unit: 'USD' };
  });
  assert.equal(result.status, 'available');
  assert.equal(result.remaining, 0);
  assert.equal(result.attempts, 3);
  calls = 0;
  const failed = await queryBalanceAfterTurn(provider, async () => {
    calls++;
    throw new Error(provider.apiKey);
  });
  assert.equal(calls, 3);
  assert.equal(failed.errorCode, 'network');
  assert.equal(failed.attempts, 3);
  assert.ok(!JSON.stringify(failed).includes(provider.apiKey));
  for (const httpStatus of [401, 403, 404, 302]) {
    let attempts = 0;
    const denied = await queryBalanceAfterTurn(provider, async () => {
      attempts++;
      return { status: 'error', checkedAt: Date.now(), errorCode: 'http', httpStatus };
    });
    assert.equal(attempts, 1);
    assert.equal(denied.httpStatus, httpStatus);
  }
  assert.equal(
    balanceErrorText({ status: 'error', checkedAt: 0, errorCode: 'timeout' }),
    '余额查询超时',
  );
  assert.equal(
    balanceErrorText({ status: 'error', checkedAt: 0, errorCode: 'http', httpStatus: 429 }),
    '余额查询被限流',
  );
});

test('cancelling a background balance query stops retrying', async () => {
  const controller = new AbortController();
  let calls = 0;
  const pending = queryBalanceAfterTurn(
    provider,
    async () => {
      calls++;
      return { status: 'error', errorCode: 'timeout', checkedAt: Date.now() };
    },
    controller.signal,
  );
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(calls, 1);
});

test('completion stays loading during retry, captures the provider and persists one recovered snapshot', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'balance-retry-'));
  const store = new Store(dir);
  const bridge = new MockCodex(dir);
  const thread = bridge.makeThread();
  let calls = 0;
  const seen: (string | undefined)[] = [];
  const wb = new Workbench(bridge, store, 3, async (current) => {
    calls++;
    seen.push(current?.id);
    return calls === 1
      ? { status: 'error', errorCode: 'http', httpStatus: 503, checkedAt: Date.now() }
      : { status: 'available', remaining: 9, unit: 'USD', checkedAt: Date.now() };
  });
  try {
    const profile = wb.providers.save({ ...provider, baseUrl: 'https://example.test' });
    store.set('activeProvider', profile.id);
    const turn = { id: 'retry', status: 'inProgress', items: [] };
    bridge.notify('turn/started', { threadId: thread.id, turn });
    store.saveBalance(thread.id, turn.id, {
      status: 'loading',
      beforeRemaining: 10,
      unit: 'USD',
      checkedAt: Date.now(),
    });
    thread.turns = [{ ...turn, status: 'completed' }];
    bridge.notify('turn/completed', { threadId: thread.id, turn: thread.turns[0] });
    bridge.notify('turn/completed', { threadId: thread.id, turn: thread.turns[0] });
    assert.equal(wb.active.size, 0);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(store.threadBalances(thread.id).get(turn.id)?.status, 'loading');
    store.set('activeProvider', '');
    const deadline = Date.now() + 4000;
    while (store.threadBalances(thread.id).get(turn.id)?.status === 'loading') {
      assert.ok(Date.now() < deadline);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const balance = store.threadBalances(thread.id).get(turn.id)!;
    assert.equal(balance.status, 'available');
    assert.equal(balance.spent, 1);
    assert.equal(balance.attempts, 2);
    assert.deepEqual(seen, [profile.id, profile.id]);
    await wb.read(thread.id);
    assert.equal(calls, 2);
    assert.equal(
      store.replay(0).filter((event) => event.method === 'workbench/balanceUpdated').length,
      1,
    );
  } finally {
    wb.dispose();
    bridge.stop();
    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('each completion queries once without blocking, captures provider, persists history, and does not resurrect deleted threads', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'balance-test-'));
  let store = new Store(dir);
  const bridge = new MockCodex(dir);
  const thread = bridge.makeThread();
  let calls = 0;
  let seenName: string | undefined;
  let resolve!: (balance: UpstreamBalance) => void;
  const wb = new Workbench(bridge, store, 3, async (p) => {
    calls++;
    seenName = p?.name;
    return new Promise((done) => {
      resolve = done;
    });
  });
  try {
    const profile = wb.providers.save({ ...provider, baseUrl: 'https://example.test' });
    store.set('activeProvider', profile.id);
    const turn = { id: 'one', status: 'inProgress', items: [] };
    bridge.notify('turn/started', { threadId: thread.id, turn });
    store.set('activeProvider', '');
    thread.turns = [{ ...turn, status: 'completed' }];
    bridge.notify('turn/completed', { threadId: thread.id, turn: thread.turns[0] });
    bridge.notify('turn/completed', { threadId: thread.id, turn: thread.turns[0] });
    assert.equal(calls, 1);
    assert.equal(seenName, provider.name);
    assert.equal(wb.active.size, 0);
    assert.equal((await wb.read(thread.id)).thread.turns[0].upstreamBalance?.status, 'loading');
    resolve({
      status: 'available',
      checkedAt: Date.now(),
      remaining: 12.5,
      unit: 'USD',
      isValid: false,
    });
    await new Promise((done) => setImmediate(done));
    assert.equal((await wb.read(thread.id)).thread.turns[0].upstreamBalance?.remaining, 12.5);
    assert.ok(!JSON.stringify(store.replay(0)).includes(provider.apiKey));
    wb.dispose();
    bridge.stop();
    store.clearCache();
    store.close();
    store = new Store(dir, true);
    const reader = new Workbench(
      bridge,
      store,
      3,
      async () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    try {
      assert.equal((await reader.read(thread.id)).thread.turns[0].upstreamBalance?.remaining, 12.5);
      const failed = { id: 'two', status: 'failed', items: [] };
      thread.turns.push(failed);
      bridge.notify('turn/completed', { threadId: thread.id, turn: failed });
      assert.equal(store.threadBalances(thread.id).get('two')?.status, 'loading');
      await reader.deleteThread(thread.id);
      resolve({ status: 'available', remaining: 0, unit: 'USD', checkedAt: Date.now() });
      await new Promise((done) => setImmediate(done));
      assert.equal(store.threadBalances(thread.id).size, 0);
      assert.equal(
        store.replay(0).filter((e) => e.method === 'workbench/balanceUpdated').length,
        0,
      );
    } finally {
      reader.dispose();
    }
  } finally {
    wb.dispose();
    bridge.stop();
    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('balance updates do not fabricate turns and pending snapshots become errors after restart', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'balance-recovery-'));
  let store = new Store(dir);
  try {
    const bridge = new MockCodex(dir);
    const thread = bridge.makeThread();
    const balance: UpstreamBalance = { status: 'loading', checkedAt: Date.now() };
    const event = {
      seq: 1,
      at: Date.now(),
      method: 'workbench/balanceUpdated',
      params: { threadId: thread.id, turnId: 'missing', upstreamBalance: balance },
    };
    assert.equal(applyThreadEvent(thread, event).turns.length, 0);
    store.saveBalance(thread.id, 'missing', balance);
    store.close();
    store = new Store(dir, true);
    assert.equal(store.threadBalances(thread.id).get('missing')?.status, 'error');
  } finally {
    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('opening an old conversation initializes its latest finished turn once with a current balance', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'balance-open-'));
  const store = new Store(dir);
  const bridge = new MockCodex(dir);
  const thread = bridge.makeThread();
  thread.turns = [
    { id: 'older', status: 'completed', items: [] },
    { id: 'latest', status: 'completed', items: [] },
    { id: 'running', status: 'inProgress', items: [] },
  ];
  let calls = 0;
  let resolve!: (value: UpstreamBalance) => void;
  const wb = new Workbench(bridge, store, 3, async () => {
    calls++;
    return new Promise((done) => {
      resolve = done;
    });
  });
  try {
    const first = await wb.read(thread.id);
    assert.equal(first.thread.turns[0].upstreamBalance, undefined);
    assert.equal(first.thread.turns[1].upstreamBalance?.status, 'loading');
    assert.equal(first.thread.turns[1].upstreamBalance?.source, 'opened');
    assert.equal(first.thread.turns[2].upstreamBalance, undefined);
    await wb.read(thread.id);
    assert.equal(calls, 1);
    resolve({ status: 'available', remaining: 42, unit: 'USD', checkedAt: Date.now() });
    await new Promise((done) => setImmediate(done));
    const last = await wb.read(thread.id);
    assert.equal(last.thread.turns[1].upstreamBalance?.remaining, 42);
    assert.equal(last.thread.turns[1].upstreamBalance?.source, 'opened');
    assert.equal(calls, 1);
  } finally {
    wb.dispose();
    bridge.stop();
    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
