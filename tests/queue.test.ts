import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { Store } from '../server/store.js';
import { Workbench } from '../server/workbench.js';
import { CodexBridge } from '../server/codex.js';
import { MockCodex } from './mock-codex.js';

const input = (text: string) => [{ type: 'text', text, text_elements: [] }];
async function until(check: () => boolean) {
  const deadline = Date.now() + 4000;
  while (!check()) {
    assert.ok(Date.now() < deadline, 'state transition timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-cloud-queue-'));
  const store = new Store(dir, true);
  const bridge = new MockCodex(dir);
  const wb = new Workbench(bridge, store, 2);
  const thread = (await wb.create(dir, {})).thread;
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

test('models include hidden entries and every page, deduplicate and detect cursor loops', async () => {
  const f = await fixture();
  try {
    const cursors: unknown[] = [];
    f.bridge.call = async (method, params = {}) => {
      assert.equal(method, 'model/list');
      assert.equal(params.includeHidden, true);
      cursors.push(params.cursor);
      return params.cursor
        ? { data: [{ model: 'hidden', hidden: true }], nextCursor: null }
        : { data: [{ model: 'first' }], nextCursor: 'next' };
    };
    assert.deepEqual(
      (await f.wb.models()).data.map((m) => m.model),
      ['first', 'hidden'],
    );
    assert.deepEqual(cursors, [undefined, 'next']);
    f.bridge.call = async () => ({ data: [], nextCursor: 'loop' });
    await assert.rejects(f.wb.models(), /游标重复/);
  } finally {
    await f.close();
  }
});

test('queue executes FIFO without browser, cancel removes a message, steering stays in current turn', async () => {
  const f = await fixture();
  try {
    await f.wb.send(f.thread.id, input('慢速'), {}, false);
    await f.wb.enqueue(f.thread.id, input('second'), {}, 'second');
    const cancelled = await f.wb.enqueue(f.thread.id, input('cancelled'), {}, 'cancelled');
    await f.wb.enqueue(f.thread.id, input('third'), {}, 'third');
    f.wb.queueAction(cancelled.id, 'cancel');
    await f.wb.send(f.thread.id, input('steer'), {}, true);
    const live = f.bridge.threads.get(f.thread.id)!;
    assert.equal(live.turns.length, 1);
    assert.equal(live.turns[0].items.at(-1)!.content[0].text, 'steer');
    live.turns[0].status = 'completed';
    f.bridge.notify('turn/completed', { threadId: live.id, turn: live.turns[0] });
    await until(() => live.turns.length === 3 && f.wb.active.size === 0);
    assert.deepEqual(
      live.turns.slice(1).map((t) => t.items[0].content[0].text),
      ['second', 'third'],
    );
    assert.equal(f.store.publicQueue().length, 0);
  } finally {
    await f.close();
  }
});

test('stop pauses queue, explicit resume continues; force stop pauses all sessions', async () => {
  const f = await fixture();
  try {
    await f.wb.send(f.thread.id, input('慢速'), {}, false);
    const row = await f.wb.enqueue(f.thread.id, input('next'), {}, 'next');
    await f.wb.interrupt(f.thread.id);
    assert.equal(f.store.publicQueue()[0].state, 'paused');
    f.wb.queueAction(row.id, 'resume');
    await until(() => f.bridge.threads.get(f.thread.id)!.turns.length === 2 && !f.wb.active.size);
    await fs.mkdir(path.join(f.dir, 'other'));
    const other = (await f.wb.create(path.join(f.dir, 'other'), {})).thread;
    for (const id of [f.thread.id, other.id]) {
      await f.wb.send(id, input('慢速'), {}, false);
      await until(() => f.wb.active.has(id));
      await f.wb.enqueue(id, input('later'), {}, 'later');
    }
    assert.equal(f.wb.active.size, 2);
    await f.wb.forceStop();
    assert.equal(f.wb.active.size, 0);
    assert.equal(f.store.publicQueue().length, 2);
    assert.ok(f.store.publicQueue().every((r) => r.state === 'paused'));
  } finally {
    await f.close();
  }
});

test('same-project queued work uses spare capacity while each session remains serial and bounded', async () => {
  const f = await fixture();
  try {
    const other = (await f.wb.create(f.dir, {})).thread;
    await f.wb.send(f.thread.id, input('慢速'), {}, false);
    await f.wb.enqueue(other.id, input('慢速 second session'), {}, 'second session');
    await until(() => f.wb.active.size === 2 && f.store.publicQueue().length === 0);
    for (let i = 0; i < 20; i++) await f.wb.enqueue(f.thread.id, input(String(i)), {}, String(i));
    await assert.rejects(f.wb.enqueue(f.thread.id, input('overflow'), {}, 'overflow'), /队列已满/);
    assert.equal(f.bridge.threads.get(f.thread.id)!.turns.length, 1);
    await f.wb.interrupt(f.thread.id);
    assert.equal(f.wb.active.has(other.id), true);
    assert.equal(f.wb.active.has(f.thread.id), false);
    assert.ok(f.store.publicQueue().every((row) => row.state === 'paused'));
  } finally {
    await f.close();
  }
});

for (const sameProject of [true, false]) {
  test(`${sameProject ? 'same' : 'different'}-project conversations share capacity and queued work starts when a slot opens`, async () => {
    const f = await fixture();
    try {
      const threads = [f.thread];
      for (let i = 0; i < 3; i++) {
        const cwd = sameProject ? f.dir : path.join(f.dir, `project-${i}`);
        await fs.mkdir(cwd, { recursive: true });
        threads.push((await f.wb.create(cwd, {})).thread);
      }
      await Promise.all(
        threads.map((thread) => f.wb.send(thread.id, input('慢速 parallel'), {}, false)),
      );
      assert.equal(f.wb.active.size, 2);
      assert.equal(f.store.publicQueue().length, 2);
      const [stopped, continuing] = [...f.wb.active.keys()];
      const queued = f.store.publicQueue().map((row) => row.threadId);
      await f.wb.interrupt(stopped);
      await until(() => f.wb.active.size === 2 && f.store.publicQueue().length === 1);
      assert.equal(f.wb.active.has(continuing), true);
      assert.equal(f.wb.active.has(queued[0]), true);
      assert.equal(f.bridge.threads.get(queued[1])!.turns.length, 0);
      await f.wb.interrupt(continuing);
      await until(() => f.wb.active.size === 2 && f.store.publicQueue().length === 0);
      assert.ok(queued.every((id) => f.wb.active.has(id)));
      assert.ok(threads.every((thread) => f.bridge.threads.get(thread.id)!.turns.length === 1));
    } finally {
      await f.close();
    }
  });
}

test('in-flight starts reserve capacity before the CLI announces running turns', async () => {
  const f = await fixture();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let first: Promise<unknown> | undefined;
  try {
    const other = (await f.wb.create(f.dir, {})).thread;
    const waiting = (await f.wb.create(f.dir, {})).thread;
    const call = f.bridge.call.bind(f.bridge);
    let starting = false;
    f.bridge.call = async (method, params) => {
      if (method === 'turn/start' && params?.threadId === f.thread.id) {
        starting = true;
        await held;
      }
      return call(method, params);
    };
    first = f.wb.send(f.thread.id, input('慢速 reserved'), {}, false);
    await until(() => starting);
    await f.wb.send(other.id, input('慢速 active'), {}, false);
    const result = await f.wb.send(waiting.id, input('慢速 waiting'), {}, false);
    assert.equal(result.queued, true);
    assert.equal(f.wb.active.size, 1);
    assert.equal(f.bridge.threads.get(waiting.id)!.turns.length, 0);
    release();
    await first;
    assert.equal(f.wb.active.size, 2);
    await f.wb.interrupt(other.id);
    await until(() => f.wb.active.has(waiting.id));
    assert.equal(f.wb.active.size, 2);
  } finally {
    release();
    await first?.catch(() => {});
    await f.close();
  }
});

test('another conversation queue does not block a native task in a free slot', async () => {
  const f = await fixture();
  try {
    const other = (await f.wb.create(f.dir, {})).thread;
    await f.wb.send(f.thread.id, input('慢速'), {}, false);
    await f.wb.enqueue(f.thread.id, input('later'), {}, 'later');
    const result = await f.wb.send(other.id, [], {}, false, false, undefined, { type: 'compact' });
    assert.equal(result.accepted, true);
    assert.equal(f.wb.active.size, 2);
    assert.equal(f.store.publicQueue().length, 1);
  } finally {
    await f.close();
  }
});

test('uncertain submission pauses following messages and never auto-retries', async () => {
  const f = await fixture();
  try {
    const call = f.bridge.call.bind(f.bridge);
    let attempts = 0;
    f.bridge.call = async (method, params) => {
      if (method === 'turn/start') {
        attempts++;
        throw new Error('unknown delivery');
      }
      return call(method, params);
    };
    await f.wb.enqueue(f.thread.id, input('first'), {}, 'first');
    await f.wb.enqueue(f.thread.id, input('second'), {}, 'second');
    await until(() => f.store.publicQueue().every((r) => r.state === 'paused'));
    assert.equal(attempts, 1);
    assert.equal(f.store.publicQueue().length, 2);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(attempts, 1);
  } finally {
    await f.close();
  }
});

test('stopping while a queued message awaits thread read prevents late submission', async () => {
  const f = await fixture();
  try {
    const call = f.bridge.call.bind(f.bridge);
    await f.wb.threadDirectory(f.thread.id);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reading = false;
    f.bridge.call = async (method, params) => {
      if (method === 'thread/read') {
        reading = true;
        await held;
      }
      return call(method, params);
    };
    await f.wb.enqueue(f.thread.id, input('must not run'), {}, 'must not run');
    await until(() => reading);
    await assert.rejects(f.wb.interrupt(f.thread.id), /没有运行/);
    release();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.bridge.threads.get(f.thread.id)!.turns.length, 0);
    assert.equal(f.store.publicQueue()[0].state, 'paused');
  } finally {
    await f.close();
  }
});

test('restart retains queue inputs and options but pauses queued and ambiguous sending rows', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-cloud-recovery-'));
  let store = new Store(dir);
  try {
    const first = store.enqueue(
      'thread',
      dir,
      input('reference and prompt'),
      { model: 'custom' },
      'preview',
    );
    store.enqueue('thread', dir, input('second'), {}, 'second');
    store.db.prepare("UPDATE message_queue SET state='sending' WHERE id=?").run(first);
    store.close();
    store = new Store(dir, true);
    assert.ok(store.publicQueue().every((r) => r.state === 'paused'));
    assert.equal(store.queueRows()[0].input[0].text, 'reference and prompt');
    assert.equal(store.queueRows()[0].options.model, 'custom');
  } finally {
    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('force stop terminates only an owned disposable process', async () => {
  const bridge = new CodexBridge();
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'pipe',
    windowsHide: true,
    detached: process.platform !== 'win32',
  });
  bridge.child = child;
  try {
    await once(child, 'spawn');
    await bridge.forceStop();
    assert.ok(child.exitCode !== null || child.signalCode !== null);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
});

test('ordinary messages automatically queue globally and start across projects when a slot frees', async () => {
  const f = await fixture();
  try {
    const ids = [f.thread.id];
    for (const name of ['second-project', 'third-project', 'fourth-project']) {
      const cwd = path.join(f.dir, name);
      await fs.mkdir(cwd);
      ids.push((await f.wb.create(cwd, {})).thread.id);
    }
    await f.wb.send(ids[0], input('慢速 first'), {}, false);
    await f.wb.send(ids[1], input('慢速 second'), {}, false);
    let claims = 0;
    const third = await f.wb.send(ids[2], input('慢速 third'), {}, false, false, () => {
      claims++;
    });
    const fourth = await f.wb.send(ids[3], input('慢速 fourth'), {}, false);
    assert.equal(third.queued, true);
    assert.equal(fourth.queued, true);
    assert.equal(claims, 1);
    assert.equal(f.wb.active.size, 2);
    assert.deepEqual(
      f.store.publicQueue().map((r) => r.threadId),
      ids.slice(2),
    );
    const first = f.bridge.threads.get(ids[0])!;
    first.turns[0].status = 'completed';
    f.bridge.notify('turn/completed', { threadId: first.id, turn: first.turns[0] });
    await until(() => f.wb.active.has(ids[2]));
    assert.equal(f.wb.active.has(ids[3]), false);
    assert.equal(claims, 1);
    assert.equal(f.store.publicQueue().length, 1);
    const second = f.bridge.threads.get(ids[1])!;
    second.turns[0].status = 'completed';
    f.bridge.notify('turn/completed', { threadId: second.id, turn: second.turns[0] });
    await until(() => f.wb.active.has(ids[3]));
    assert.equal(f.store.publicQueue().length, 0);
    assert.equal(f.wb.active.size, 2);
  } finally {
    await f.close();
  }
});

test('stale ordinary submission to a running conversation queues without steering', async () => {
  const f = await fixture();
  try {
    await f.wb.send(f.thread.id, input('慢速'), {}, false);
    assert.equal((await f.wb.send(f.thread.id, input('next'), {}, false)).queued, true);
    assert.equal(f.bridge.threads.get(f.thread.id)!.turns.length, 1);
    assert.equal(f.store.publicQueue()[0].preview, 'next');
  } finally {
    await f.close();
  }
});
