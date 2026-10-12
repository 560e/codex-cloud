import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../server/store.js';
import { Workbench } from '../server/workbench.js';
import { nativeTurnModels } from '../server/turn-models.js';
import { MockCodex } from './mock-codex.js';
import { applyThreadEvent } from '../shared/events.js';
import type { WorkEvent } from '../shared/types.js';

const input = (text: string) => [{ type: 'text', text }];
async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-turn-models-'));
  const store = new Store(dir);
  const bridge = new MockCodex(dir);
  bridge.defaultModel = 'default-a';
  const wb = new Workbench(bridge, store, 2);
  const thread = bridge.makeThread();
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

test('model snapshots survive switching, steering, queued sends and service restart', async () => {
  const f = await fixture();
  const events: WorkEvent[] = [];
  f.wb.on('event', (event) => events.push(event));
  try {
    await f.wb.send(f.thread.id, input('慢速气泡验证'), { model: 'model-a' }, false);
    const first = f.thread.turns[0];
    assert.equal(
      events.find((event) => event.method === 'turn/started')?.params.turn?.model,
      'model-a',
    );
    await f.wb.send(f.thread.id, input('补充'), { model: 'model-b' }, true);
    f.bridge.defaultModel = 'default-b';
    await f.wb.enqueue(f.thread.id, input('second'), { model: 'model-b' }, 'second');
    assert.equal((await f.wb.read(f.thread.id)).thread.turns[0].model, 'model-a');
    first.status = 'completed';
    f.bridge.notify('turn/completed', { threadId: f.thread.id, turn: first });
    const deadline = Date.now() + 5000;
    while (f.thread.turns.length < 2 || f.wb.active.size || f.store.publicQueue().length) {
      assert.ok(Date.now() < deadline, 'queue should finish');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.deepEqual(
      (await f.wb.read(f.thread.id)).thread.turns.map((turn) => turn.model),
      ['model-a', 'model-b'],
    );
    await f.wb.send(f.thread.id, input('慢速'), {}, false);
    assert.equal((await f.wb.read(f.thread.id)).thread.turns.at(-1)?.model, 'default-b');
    await f.wb.interrupt(f.thread.id);
    f.wb.dispose();
    f.bridge.stop();
    const reopenedStore = new Store(f.dir);
    const restarted = new Workbench(f.bridge, reopenedStore, 2);
    try {
      assert.deepEqual(
        (await restarted.read(f.thread.id)).thread.turns.map((turn) => turn.model),
        ['model-a', 'model-b', 'default-b'],
      );
      reopenedStore.deleteThreadData(f.thread.id);
      assert.equal(reopenedStore.threadModels(f.thread.id).size, 0);
    } finally {
      restarted.dispose();
      reopenedStore.close();
    }
  } finally {
    await f.close();
  }
});

test('a start response without a notification still records the model and delayed events preserve it', async () => {
  const f = await fixture();
  try {
    const call = f.bridge.call.bind(f.bridge);
    f.bridge.call = async (method, params = {}) =>
      method === 'turn/start'
        ? { turn: { id: 'late', status: 'inProgress', items: [] } }
        : call(method, params);
    const result = await f.wb.send(f.thread.id, input('test'), { model: 'model-a' }, false);
    assert.equal(result.turn.model, 'model-a');
    f.bridge.defaultModel = 'model-b';
    f.bridge.notify('turn/started', {
      threadId: f.thread.id,
      turn: { id: 'late', status: 'inProgress', items: [] },
    });
    assert.equal((await f.wb.read(f.thread.id)).thread.turns[0].model, 'model-a');
  } finally {
    await f.close();
  }
});

test('native history backfills exact turn models and never guesses from the current thread model', async () => {
  const f = await fixture();
  try {
    const file = path.join(f.dir, 'rollout.jsonl');
    f.thread.path = file;
    f.thread.model = 'current-model';
    f.thread.turns = ['old-a', 'old-b', 'unknown'].map((id) => ({
      id,
      items: [],
      status: 'completed',
    }));
    await fs.writeFile(
      file,
      [
        { type: 'session_meta', payload: { id: f.thread.id } },
        { type: 'turn_context', payload: { turn_id: 'old-a', model: 'historical-a' } },
        { type: 'turn_context', payload: { turn_id: 'old-b', model: 'historical-b' } },
        { type: 'turn_context', payload: { model: 'unattributed-model' } },
      ]
        .map((row) => JSON.stringify(row))
        .join('\n') + '\n',
    );
    assert.deepEqual(
      (await f.wb.read(f.thread.id)).thread.turns.map((turn) => turn.model),
      ['historical-a', 'historical-b', undefined],
    );
    assert.equal((await nativeTurnModels(file, 'other-thread')).size, 0);
    await fs.appendFile(
      file,
      JSON.stringify({
        type: 'turn_context',
        payload: { turn_id: 'unknown', model: 'recovered-model' },
      }) + '\n',
    );
    assert.equal((await f.wb.read(f.thread.id)).thread.turns[2].model, 'recovered-model');
    await fs.unlink(file);
    assert.equal((await f.wb.read(f.thread.id)).thread.turns[0].model, 'historical-a');
  } finally {
    await f.close();
  }
});

test('model events only update their target turn and completion preserves the snapshot', () => {
  const thread = {
    id: 'thread',
    preview: '',
    cwd: '',
    createdAt: 0,
    updatedAt: 0,
    status: { type: 'idle' },
    turns: [
      { id: 'first', status: 'completed', items: [], model: 'a' },
      { id: 'second', status: 'inProgress', items: [], model: 'b' },
    ],
  };
  const event = {
    seq: 1,
    at: 1,
    method: 'workbench/turnModelUpdated',
    params: { threadId: 'thread', turnId: 'second', model: 'c' },
  };
  const updated = applyThreadEvent(thread, event);
  assert.deepEqual(
    updated.turns.map((turn) => turn.model),
    ['a', 'c'],
  );
  assert.deepEqual(
    applyThreadEvent(updated, {
      ...event,
      method: 'turn/completed',
      params: { threadId: 'thread', turn: { id: 'second', status: 'completed', items: [] } },
    }).turns.map((turn) => turn.model),
    ['a', 'c'],
  );
  assert.equal(
    applyThreadEvent(thread, { ...event, params: { ...event.params, turnId: 'missing' } }).turns
      .length,
    2,
  );
});
