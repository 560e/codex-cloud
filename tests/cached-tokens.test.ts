import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../server/store.js';
import { accumulateTokens, cacheHitRate, tokenTotal } from '../shared/tokens.js';
import { parseApiResult, parseEventParams } from '../shared/protocol.js';

test('cached input deltas deduplicate, reset safely and never add to total consumption', () => {
  const zero = { total: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 } };
  const first = {
    total: { inputTokens: 100, cachedInputTokens: 80, outputTokens: 20 },
    last: { inputTokens: 100, cachedInputTokens: 80, outputTokens: 20 },
  };
  const one = accumulateTokens(first, zero);
  assert.equal(one.counts.cachedInputTokens, 80);
  assert.equal(tokenTotal(one.counts), 120);
  assert.equal(cacheHitRate(one.counts), 80);
  assert.deepEqual(accumulateTokens(first, first, one.counts).counts, one.counts);
  const second = { total: { inputTokens: 1000, cachedInputTokens: 170, outputTokens: 100 } };
  assert.equal(accumulateTokens(second, first).counts.cachedInputTokens, 90);
  assert.equal(accumulateTokens(first, second).partial, true);
  assert.equal(accumulateTokens(first, first, { inputTokens: 100 }).partial, true);
  assert.equal(
    accumulateTokens({ total: { inputTokens: 200, outputTokens: 30 } }, first, one.counts).partial,
    true,
  );
  assert.equal(cacheHitRate({ inputTokens: 100, cachedInputTokens: 0 }), 0);
  for (const counts of [
    { inputTokens: 0, cachedInputTokens: 0 },
    { inputTokens: 100 },
    { inputTokens: 100, cachedInputTokens: 101 },
  ])
    assert.equal(cacheHitRate(counts), undefined);
  assert.throws(() =>
    parseEventParams('thread/tokenUsage/updated', {
      tokenUsage: { total: { cachedInputTokens: -1 } },
    }),
  );
});

test('overall cache ratio uses summed input across all pages and excludes missing or partial records', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cache-stats-'));
  const store = new Store(dir);
  try {
    const project = store.addProject('Cache', dir);
    store.event('thread/started', { thread: { id: 'a', cwd: dir, preview: '', turns: [] } });
    const insert = (id: string, input: number, cached?: number, partial = 0, at = 100) =>
      store.db.prepare('INSERT INTO token_turns VALUES(?,?,?,?,?)').run(
        'a',
        id,
        JSON.stringify({
          inputTokens: input,
          cachedInputTokens: cached,
          outputTokens: 1,
          totalTokens: input + 1,
        }),
        partial,
        at,
      );
    insert('large', 900, 0);
    for (let n = 0; n < 50; n++) insert('small-' + n, 2, 2);
    insert('missing', 1000);
    insert('partial', 100, 100, 1);
    insert('empty', 0, 0);
    insert('invalid', 10, 20);
    const stats = store.usageStats();
    assert.equal(stats.records.length, 50);
    assert.deepEqual(stats.cache, { inputTokens: 1000, cachedInputTokens: 100, turns: 51 });
    assert.equal(cacheHitRate(stats.cache), 10);
    assert.deepEqual(store.usageStats(0, { page: 2 }).cache, stats.cache);
    assert.deepEqual(store.usageStats(0, { project: project.id, thread: 'a' }).cache, stats.cache);
    assert.equal(store.usageStats(101).cache.turns, 0);
    assert.equal(cacheHitRate(store.usageStats(0, { thread: 'missing' }).cache), undefined);
    assert.deepEqual(parseApiResult('/usage', 'GET', stats), stats);
  } finally {
    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('existing cache counters backfill once without rewriting totals or guessing truncated history', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cache-backfill-'));
  let store = new Store(dir);
  try {
    for (const threadId of ['complete', 'truncated']) {
      store.event('thread/started', { thread: { id: threadId, cwd: dir, preview: '', turns: [] } });
      store.event('thread/tokenUsage/updated', {
        threadId,
        turnId: 'one',
        tokenUsage: {
          total: { inputTokens: 100, cachedInputTokens: 80, outputTokens: 20 },
          last: { inputTokens: 100, cachedInputTokens: 80, outputTokens: 20 },
        },
      });
      store.event('thread/tokenUsage/updated', {
        threadId,
        turnId: 'two',
        tokenUsage: {
          total: { inputTokens: 1000, cachedInputTokens: 170, outputTokens: 100 },
          last: { inputTokens: 900, cachedInputTokens: 90, outputTokens: 80 },
        },
      });
    }
    store.db.exec(
      "UPDATE token_turns SET counts=json_remove(counts,'$.cachedInputTokens'); DELETE FROM migrations WHERE version=9; DELETE FROM events WHERE (json_extract(params,'$.threadId')='truncated' AND json_extract(params,'$.turnId')='one') OR json_extract(params,'$.thread.id')='truncated'",
    );
    const total = store.usageStats().totals.totalTokens;
    store.close();
    store = new Store(dir);
    assert.equal(store.threadUsage('complete').turns.get('one')?.tokenUsage.cachedInputTokens, 80);
    assert.equal(store.threadUsage('complete').turns.get('two')?.tokenUsage.cachedInputTokens, 90);
    assert.equal(
      store.threadUsage('truncated').turns.get('two')?.tokenUsage.cachedInputTokens,
      undefined,
    );
    assert.equal(store.usageStats().totals.totalTokens, total);
    assert.equal(cacheHitRate(store.usageStats().cache), 17);
    store.clearCache();
    store.close();
    store = new Store(dir);
    assert.equal(cacheHitRate(store.usageStats().cache), 17);
    assert.equal(store.usageStats().totals.cachedInputTokens, 170);
  } finally {
    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
