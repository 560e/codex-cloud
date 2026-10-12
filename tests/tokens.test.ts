import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../server/store.js';
import { Workbench } from '../server/workbench.js';
import { MockCodex } from './mock-codex.js';
import { applyThreadEvent } from '../shared/events.js';
import { accumulateTokens, tokenTotal } from '../shared/tokens.js';
import { buildApp } from '../server/app.js';
import { Auth } from '../server/auth.js';
import { config } from '../server/config.js';
import type { TokenUsage } from '../shared/types.js';

test('token accumulation uses cumulative deltas, deduplicates snapshots, and excludes reasoning from the total sum', () => {
  const zero: TokenUsage = { total: { inputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 } };
  const first: TokenUsage = {
    total: { inputTokens: 100, outputTokens: 40, reasoningOutputTokens: 25 },
    last: { inputTokens: 100, outputTokens: 40, reasoningOutputTokens: 25 },
  };
  const one = accumulateTokens(first, zero);
  assert.equal(tokenTotal(one.counts), 140);
  assert.equal(one.partial, false);
  const repeated = accumulateTokens(first, first, one.counts);
  assert.deepEqual(repeated.counts, one.counts);
  const second: TokenUsage = {
    total: { inputTokens: 230, outputTokens: 95, reasoningOutputTokens: 60 },
  };
  const combined = accumulateTokens(second, first, one.counts);
  assert.deepEqual(combined.counts, {
    inputTokens: 230,
    outputTokens: 95,
    reasoningOutputTokens: 60,
    totalTokens: 325,
  });
  const nextTurn = accumulateTokens(second, first);
  assert.equal(nextTurn.counts.inputTokens, 130);
  assert.equal(nextTurn.counts.outputTokens, 55);
  assert.equal(tokenTotal(nextTurn.counts), 185);
  const partial = accumulateTokens(first);
  assert.equal(partial.partial, false);
  assert.equal(accumulateTokens({ ...first, total: second.total }).partial, true);
  const reset = accumulateTokens(first, second);
  assert.equal(reset.partial, true);
  assert.equal(tokenTotal(reset.counts), 140);
  const lastOnly = accumulateTokens({ last: first.last });
  assert.deepEqual(
    accumulateTokens({ last: first.last }, undefined, lastOnly.counts).counts,
    lastOnly.counts,
  );
});

test('usage survives restart and cache cleanup, enriches thread history, and is removed with its thread', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'usage-test-'));
  let store = new Store(dir);
  const bridge = new MockCodex(dir);
  const thread = bridge.makeThread();
  thread.turns = [
    {
      id: 'turn-1',
      status: 'completed',
      items: [{ id: 'reply', type: 'agentMessage', text: 'done' }],
    },
  ];
  try {
    store.event('thread/started', { thread: { ...thread, turns: [], preview: '' } });
    const sample = store.event('thread/tokenUsage/updated', {
      threadId: thread.id,
      turnId: 'turn-1',
      tokenUsage: { total: { inputTokens: 100, outputTokens: 30, reasoningOutputTokens: 20 } },
    });
    const live = applyThreadEvent(thread, sample);
    assert.equal(live.turns[0].tokenUsage?.totalTokens, 130);
    store.event('thread/tokenUsage/updated', sample.params);
    assert.equal(store.usageStats().totals.totalTokens, 130);
    store.event('thread/tokenUsage/updated', {
      threadId: thread.id,
      turnId: 'turn-2',
      tokenUsage: { total: { inputTokens: 220, outputTokens: 80, reasoningOutputTokens: 45 } },
    });
    assert.equal(store.usageStats().totals.totalTokens, 300);
    assert.equal(store.usageStats(Date.now() + 1000).turns, 0);
    store.db.exec(
      "CREATE TRIGGER reject_bad_usage BEFORE INSERT ON token_turns WHEN NEW.turn_id='bad' BEGIN SELECT RAISE(ABORT,'test rollback'); END",
    );
    assert.throws(
      () =>
        store.event('thread/tokenUsage/updated', {
          threadId: thread.id,
          turnId: 'bad',
          tokenUsage: { total: { inputTokens: 330, outputTokens: 100 } },
        }),
      /test rollback/,
    );
    assert.equal(store.threadUsage(thread.id).snapshot?.total?.inputTokens, 220);
    assert.equal(store.usageStats().totals.totalTokens, 300);
    store.db.exec('DROP TRIGGER reject_bad_usage');
    store.clearCache();
    store.close();
    store = new Store(dir);
    assert.equal(store.usageStats().turns, 2);
    assert.equal(store.usageStats().totals.reasoningOutputTokens, 45);
    const workbench = new Workbench(bridge, store, 3);
    try {
      const result = await workbench.read(thread.id);
      assert.equal(result.thread.turns[0].tokenUsage?.inputTokens, 100);
      assert.equal(result.thread.tokenUsage?.total?.inputTokens, 220);
    } finally {
      workbench.dispose();
    }
    store.deleteThreadData(thread.id);
    assert.equal(store.usageStats().turns, 0);
  } finally {
    bridge.stop();
    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('usage migration backfills retained native notifications once and stats require authentication', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'usage-migrate-'));
  let store = new Store(dir);
  const bridge = new MockCodex(dir);
  try {
    const thread = bridge.makeThread();
    store.event('thread/tokenUsage/updated', {
      threadId: thread.id,
      turnId: 'older',
      tokenUsage: {
        total: { inputTokens: 1000, outputTokens: 300 },
        last: { inputTokens: 50, outputTokens: 20 },
      },
    });
    store.db.exec(
      'DELETE FROM token_state; DELETE FROM token_turns; DELETE FROM migrations WHERE version=6',
    );
    store.close();
    store = new Store(dir);
    assert.equal(store.usageStats().totals.totalTokens, 70);
    assert.equal(store.usageStats().threads[0].partial, true);
    assert.equal(store.usageStats().totals.reasoningOutputTokens, undefined);
    store.close();
    store = new Store(dir);
    assert.equal(store.usageStats().totals.totalTokens, 70);
    const workbench = new Workbench(bridge, store, 3);
    const app = await buildApp(store, workbench, { logger: false });
    try {
      assert.equal((await app.inject('/api/usage')).statusCode, 401);
      await new Auth(store).change('test-password-long');
      const login = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { origin: config.origin },
        payload: { password: 'test-password-long' },
      });
      const cookie = login.cookies[0];
      const headers = { cookie: `${cookie.name}=${cookie.value}` };
      const result = await app.inject({ url: '/api/usage', headers });
      assert.equal(result.statusCode, 200);
      assert.equal(result.json().totals.totalTokens, 70);
      assert.equal((await app.inject({ url: '/api/usage?since=-1', headers })).statusCode, 400);
    } finally {
      await app.close();
    }
  } finally {
    bridge.stop();
    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
