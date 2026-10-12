import { test } from 'node:test';
import assert from 'node:assert/strict';
import { turnElapsed, formatElapsed } from '../shared/timing.js';
import { parseRpcResult } from '../shared/protocol.js';
import { applyThreadEvent } from '../shared/events.js';
import type { Thread, Turn } from '../shared/types.js';

test('native timing survives parsing and completion events; missing history is not fabricated', () => {
  const active: Turn = { id: 'turn', status: 'inProgress', items: [], startedAt: 100 };
  assert.equal(turnElapsed(active, 103500), 3500);
  assert.equal(turnElapsed(active, 99000), 0);
  const completed = parseRpcResult('turn/start', {
    turn: { ...active, status: 'completed', completedAt: 105, durationMs: 4900 },
  }).turn;
  const thread = { id: 'thread', turns: [active] } as Thread;
  const final = applyThreadEvent(thread, {
    seq: 1,
    at: 999999,
    method: 'turn/completed',
    params: { threadId: 'thread', turn: completed },
  });
  assert.equal(turnElapsed(final.turns[0], 999999), 4900);
  assert.equal(turnElapsed({ ...active, status: 'interrupted', completedAt: 105 }), 5000);
  assert.equal(turnElapsed({ ...active, status: 'failed' }), null);
  assert.equal(turnElapsed({ id: 'old', items: [], status: 'completed' }), null);
  assert.equal(turnElapsed({ ...completed, durationMs: 0 }), 0);
  assert.equal(formatElapsed(3661000), '1 小时 1 分 1 秒');
});
