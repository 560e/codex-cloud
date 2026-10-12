import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../server/store.js';
import { Workbench } from '../server/workbench.js';
import { MockCodex } from './mock-codex.js';
import { parseApiResult } from '../shared/protocol.js';
import type { UsageStats } from '../shared/types.js';
import { balanceDifference, formatMoney, moneyUnit } from '../shared/money.js';

test('balance decimal differences preserve small charges and ignore credits and missing snapshots', () => {
  assert.equal(balanceDifference(100.123456789, 100.123444444), 0.000012345);
  assert.equal(balanceDifference(0.3, 0.2), 0.1);
  assert.equal(balanceDifference(1e-8, 2e-9), 8e-9);
  assert.equal(balanceDifference(-2, -3), 1);
  assert.equal(balanceDifference(1, 2), undefined);
  assert.equal(balanceDifference(undefined, 2), undefined);
  assert.equal(formatMoney(0.000012345), '0.000012345');
  assert.equal(formatMoney(0.123456, 4), '0.1235');
  assert.equal(formatMoney(99.98765, 2), '99.99');
  assert.equal(moneyUnit('usd'), '$');
});

test('round statistics paginate, filter across projects and sessions, retain exact charges and survive cache cleanup', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-cloud-usage-details-'));
  let store = new Store(dir);
  try {
    const one = store.addProject('Project A', path.join(dir, 'a'));
    const two = store.addProject('Project B', path.join(dir, 'b'));
    for (const [id, cwd] of [
      ['thread-a', one.path],
      ['thread-b', two.path],
    ])
      store.event('thread/started', { thread: { id, cwd, name: id, preview: '', turns: [] } });
    for (let i = 0; i < 55; i++) {
      const thread = i < 53 ? 'thread-a' : 'thread-b';
      const turnId = String(i).padStart(3, '0');
      store.event('turn/started', {
        threadId: thread,
        turn: { id: turnId, status: 'inProgress', items: [], startedAt: (1000 + i) / 1000 },
      });
      store.event('item/completed', {
        threadId: thread,
        turnId,
        item: {
          id: 'question-' + i,
          type: 'userMessage',
          content: [{ type: 'text', text: 'Question ' + i }],
        },
      });
      store.db.prepare('INSERT INTO token_turns VALUES(?,?,?,?,?)').run(
        thread,
        turnId,
        JSON.stringify({
          totalTokens: 13,
          inputTokens: 10,
          outputTokens: 3,
          reasoningOutputTokens: 2,
        }),
        0,
        2000 + i,
      );
      store.event('turn/completed', {
        threadId: thread,
        turn: { id: turnId, status: 'completed', items: [], completedAt: (2000 + i) / 1000 },
      });
      store.saveBalance(thread, turnId, {
        status: 'available',
        checkedAt: 2000 + i,
        unit: 'USD',
        remaining: 10,
        beforeRemaining: 10.000012345,
        spent: 0.000012345,
      });
    }
    const all = store.usageStats();
    const parsed = parseApiResult('/usage', 'GET', all) as UsageStats;
    assert.equal(parsed.records[0].balance?.spent, 0.000012345);
    assert.equal(parsed.filters.projects.length, 2);
    assert.equal(all.records[0].startedAt, 1054);
    assert.equal(all.turns, 55);
    assert.equal(all.records.length, 50);
    assert.equal(all.pages, 2);
    assert.equal(all.totals.totalTokens, 55 * 13);
    assert.equal(all.expenses[0].spent, 0.000678975);
    assert.equal(store.usageStats(0, { page: 2 }).records.length, 5);
    const a = store.usageStats(0, { project: one.id, page: 2 });
    assert.equal(a.turns, 53);
    assert.equal(a.records.length, 3);
    assert.equal(a.records[0].turnNumber, 3);
    assert.equal(a.records[0].prompt, 'Question 2');
    assert.equal(a.filters.threads.length, 1);
    const b = store.usageStats(0, { thread: 'thread-b' });
    assert.equal(b.turns, 2);
    assert.equal(b.records[0].projectName, 'Project B');
    assert.equal(b.records[0].balance?.spent, 0.000012345);
    assert.equal(store.usageStats(0, { thread: 'thread-b', project: one.id }).turns, 0);
    assert.equal(store.usageStats(2054).records[0].turnNumber, 2);
    store.clearCache();
    store.close();
    store = new Store(dir, true);
    assert.equal(store.usageStats().turns, 55);
    assert.equal(store.usageStats().records[0].prompt, 'Question 54');
    store.deleteThreadData('thread-b');
    assert.equal(store.usageStats().turns, 53);
  } finally {
    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('balance is captured before submission, charged after completion and never recomputed on reload', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-cloud-charge-'));
  const store = new Store(dir);
  const bridge = new MockCodex(dir);
  let queries = 0;
  const wb = new Workbench(bridge, store, 2, async () => ({
    status: 'available',
    checkedAt: Date.now(),
    unit: 'USD',
    remaining: ++queries === 1 ? 10.123456789 : 10.111111111,
  }));
  try {
    const thread = (await wb.create(dir, {})).thread;
    await wb.send(
      thread.id,
      [{ type: 'text', text: '慢速余额测试', text_elements: [] }],
      {},
      false,
    );
    const live = bridge.threads.get(thread.id)!;
    const turn = live.turns[0];
    assert.equal(store.threadBalances(thread.id).get(turn.id)?.beforeRemaining, 10.123456789);
    bridge.notify('turn/completed', {
      threadId: thread.id,
      turn: { ...turn, status: 'completed' },
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(queries, 2);
    assert.equal(store.threadBalances(thread.id).get(turn.id)?.spent, 0.012345678);
    bridge.notify('turn/completed', {
      threadId: thread.id,
      turn: { ...turn, status: 'completed' },
    });
    await wb.read(thread.id);
    assert.equal(queries, 2);
    assert.equal(store.usageStats().records[0].balance?.spent, 0.012345678);
  } finally {
    wb.dispose();
    bridge.stop();
    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
