import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../server/store.js';
import { Workbench } from '../server/workbench.js';
import { buildApp } from '../server/app.js';
import { Auth } from '../server/auth.js';
import { config } from '../server/config.js';
import { MockCodex } from './mock-codex.js';

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-cloud-continuity-'));
  const first = path.join(root, 'first');
  const second = path.join(root, 'second');
  await fs.mkdir(first);
  await fs.mkdir(second);
  const store = new Store(path.join(root, 'data'));
  const bridge = new MockCodex(first);
  const workbench = new Workbench(bridge, store, 2);
  const app = await buildApp(store, workbench, { logger: false });
  await new Auth(store).change('continuity-test-password');
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { origin: config.origin },
    payload: { password: 'continuity-test-password' },
  });
  const headers = {
    origin: config.origin,
    cookie: `${login.cookies[0].name}=${login.cookies[0].value}`,
  };
  const firstProject = store.addProject('first', first);
  const secondProject = store.addProject('second', second);
  const api = async (method: string, url: string, payload?: unknown) => {
    const response = await app.inject({ method, url: '/api' + url, headers, payload });
    return { status: response.statusCode, body: response.json() };
  };
  return {
    root,
    store,
    bridge,
    workbench,
    app,
    api,
    firstProject,
    secondProject,
    async close() {
      await app.close();
      bridge.stop();
      store.close();
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}
async function until(check: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    assert.ok(Date.now() < deadline, 'timed out waiting for collaboration');
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

test('memory and collaboration are off by default and enabled independently', async () => {
  const f = await fixture();
  try {
    assert.deepEqual((await f.api('GET', '/features')).body, {
      memory: false,
      collaboration: false,
    });
    assert.equal((await f.api('GET', '/memories')).status, 409);
    assert.equal((await f.api('GET', '/collaborations')).status, 409);
    assert.equal(
      (await f.api('PUT', '/features', { memory: true, collaboration: false })).status,
      200,
    );
    assert.equal((await f.api('GET', '/memories')).status, 200);
    assert.equal((await f.api('GET', '/collaborations')).status, 409);
    assert.equal(
      (await f.api('PUT', '/features', { memory: false, collaboration: true })).status,
      200,
    );
    assert.equal((await f.api('GET', '/memories')).status, 409);
    assert.equal((await f.api('GET', '/collaborations')).status, 200);
  } finally {
    await f.close();
  }
});

test('saved memory reaches another conversation in its project and global memory reaches other projects', async () => {
  const f = await fixture();
  try {
    const a = (await f.workbench.create(f.firstProject.path, {})).thread.id;
    const b = (await f.workbench.create(f.firstProject.path, {})).thread.id;
    const c = (await f.workbench.create(f.secondProject.path, {})).thread.id;
    await f.api('PUT', '/features', { memory: true, collaboration: false });
    await f.api('POST', '/memories', {
      projectId: f.firstProject.id,
      content: '活动预算最高是五千元',
    });
    await f.api('POST', '/memories', { projectId: null, content: '默认回答使用中文' });
    const sent = await f.workbench.send(
      b,
      [{ type: 'text', text: '活动预算和回答语言是什么？' }],
      {},
      false,
    );
    assert.ok(sent.turn?.id);
    const contents = f.bridge.threads.get(b)!.turns.at(-1)!.items[0].content as { text: string }[];
    assert.match(contents[0].text, /五千元/);
    assert.match(contents[0].text, /中文/);
    assert.deepEqual(
      (await f.api('GET', `/threads/${b}/turns/${sent.turn.id}/memories`)).body.length,
      2,
    );
    const other = await f.workbench.send(
      c,
      [{ type: 'text', text: '回答语言是什么？' }],
      {},
      false,
    );
    assert.ok(other.turn?.id);
    const otherText = (
      f.bridge.threads.get(c)!.turns.at(-1)!.items[0].content as { text: string }[]
    )[0].text;
    assert.match(otherText, /中文/);
    assert.doesNotMatch(otherText, /五千元/);
    await f.api('PUT', '/features', { memory: false, collaboration: false });
    await until(
      () =>
        f.bridge.threads.get(a)!.turns.length === 0 &&
        f.bridge.threads.get(b)!.turns.at(-1)?.status === 'completed',
    );
    await f.workbench.send(a, [{ type: 'text', text: '活动预算是什么？' }], {}, false);
    const disabled = (
      f.bridge.threads.get(a)!.turns.at(-1)!.items[0].content as { text: string }[]
    )[0].text;
    assert.doesNotMatch(disabled, /已保存记忆/);
  } finally {
    await f.close();
  }
});

test('collaboration hands off across projects and returns to the first conversation for the configured number of steps', async () => {
  const f = await fixture();
  try {
    const a = (await f.workbench.create(f.firstProject.path, {})).thread.id;
    const b = (await f.workbench.create(f.secondProject.path, {})).thread.id;
    await f.api('PUT', '/features', { memory: false, collaboration: true });
    const group = (
      await f.api('POST', '/collaborations', {
        name: '讨论组',
        goal: '共同完善活动方案',
        maxSteps: 3,
        members: [
          { threadId: a, instruction: '先提出想法' },
          { threadId: b, instruction: '补充意见' },
        ],
      })
    ).body;
    assert.ok(group.id);
    const started = (
      await f.api('POST', `/collaborations/${group.id}/runs`, { prompt: '讨论周末活动' })
    ).body;
    assert.ok(started.id);
    await until(
      () =>
        f.store.db.prepare('SELECT status FROM collaboration_runs WHERE id=?').get(started.id)
          ?.status === 'completed',
    );
    const run = (await f.api('GET', `/collaboration-runs/${started.id}`)).body;
    assert.equal(run.stepsDone, 3);
    assert.equal(f.bridge.threads.get(a)!.turns.length, 2);
    assert.equal(f.bridge.threads.get(b)!.turns.length, 1);
    const handoffs = (await f.api('GET', `/collaboration-runs/${started.id}/handoffs`)).body;
    assert.equal(handoffs.length, 3);
    assert.equal(handoffs[0].target_thread_id, b);
    assert.equal(handoffs[1].target_thread_id, a);
    assert.equal(handoffs[2].target_thread_id, null);
  } finally {
    await f.close();
  }
});

test('each collaboration member can choose the next conversation', async () => {
  const f = await fixture();
  try {
    const a = (await f.workbench.create(f.firstProject.path, {})).thread.id;
    const b = (await f.workbench.create(f.firstProject.path, {})).thread.id;
    const c = (await f.workbench.create(f.secondProject.path, {})).thread.id;
    await f.api('PUT', '/features', { memory: false, collaboration: true });
    const created = await f.api('POST', '/collaborations', {
      name: '自定义路线',
      goal: '讨论活动',
      maxSteps: 3,
      members: [
        { threadId: a, instruction: '发起', nextThreadId: c },
        { threadId: b, instruction: '结论' },
        { threadId: c, instruction: '补充', nextThreadId: b },
      ],
    });
    assert.equal(created.status, 200);
    const started = await f.api('POST', `/collaborations/${created.body.id}/runs`, {
      prompt: '讨论活动内容',
    });
    assert.equal(started.status, 200);
    await until(
      () =>
        f.store.db.prepare('SELECT status FROM collaboration_runs WHERE id=?').get(started.body.id)
          ?.status === 'completed',
    );
    const handoffs = (await f.api('GET', `/collaboration-runs/${started.body.id}/handoffs`)).body;
    assert.deepEqual(
      handoffs.map((item: { source_thread_id: string; target_thread_id: string | null }) => [
        item.source_thread_id,
        item.target_thread_id,
      ]),
      [
        [a, c],
        [c, b],
        [b, null],
      ],
    );
    assert.deepEqual(
      handoffs.map((item: { step_index: number }) => item.step_index),
      [0, 1, 2],
    );
  } finally {
    await f.close();
  }
});

test('stopping a run during the first submission prevents the next handoff', async () => {
  const f = await fixture();
  try {
    const a = (await f.workbench.create(f.firstProject.path, {})).thread.id;
    const b = (await f.workbench.create(f.secondProject.path, {})).thread.id;
    await f.api('PUT', '/features', { memory: false, collaboration: true });
    const group = (
      await f.api('POST', '/collaborations', {
        name: '可停止的讨论',
        goal: '讨论活动',
        maxSteps: 4,
        members: [
          { threadId: a, instruction: '' },
          { threadId: b, instruction: '' },
        ],
      })
    ).body;
    const run = (
      await f.api('POST', `/collaborations/${group.id}/runs`, { prompt: '讨论活动安排' })
    ).body;
    const stopped = await f.api('POST', `/collaboration-runs/${run.id}/actions`, {
      action: 'stop',
    });
    assert.equal(stopped.status, 200);
    await until(
      () =>
        f.store.db.prepare('SELECT status FROM collaboration_runs WHERE id=?').get(run.id)
          ?.status === 'cancelled',
    );
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(f.bridge.threads.get(b)!.turns.length, 0);
    assert.equal((await f.api('GET', `/collaboration-runs/${run.id}/handoffs`)).body.length, 0);
  } finally {
    await f.close();
  }
});

async function discussion(f: Awaited<ReturnType<typeof fixture>>, members?: string[]) {
  const ids = members || [
    (await f.workbench.create(f.firstProject.path, {})).thread.id,
    (await f.workbench.create(f.secondProject.path, {})).thread.id,
  ];
  await f.api('PUT', '/features', { collaboration: true });
  const created = await f.api('POST', '/collaborations', {
    name: '边界检查',
    goal: '讨论方案',
    maxSteps: 2,
    members: ids.map((threadId) => ({ threadId, instruction: '' })),
  });
  assert.equal(created.status, 200);
  return { id: created.body.id as string, ids };
}

function gate() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release };
}

test('partial feature updates preserve the other switch and memory scope edits affect retrieval', async () => {
  const f = await fixture();
  try {
    await f.api('PUT', '/features', { memory: true });
    assert.deepEqual((await f.api('PUT', '/features', { collaboration: true })).body, {
      memory: true,
      collaboration: true,
    });
    assert.equal((await f.api('PUT', '/features', {})).status, 400);
    const memory = (
      await f.api('POST', '/memories', {
        projectId: f.firstProject.id,
        content: '预算限制五千元',
      })
    ).body;
    assert.equal(f.workbench.continuity!.relevantMemories(f.secondProject.path, '预算').length, 0);
    assert.equal((await f.api('PATCH', `/memories/${memory.id}`, { projectId: null })).status, 200);
    assert.equal(f.workbench.continuity!.relevantMemories(f.secondProject.path, '预算').length, 1);
    assert.equal(
      (await f.api('PATCH', `/memories/${memory.id}`, { projectId: 'missing' })).status,
      404,
    );
    await f.api('PATCH', `/memories/${memory.id}`, { projectId: f.secondProject.id });
    assert.equal(f.workbench.continuity!.relevantMemories(f.firstProject.path, '预算').length, 0);
  } finally {
    await f.close();
  }
});

test('memory use records include only complete notes actually injected within the budget', async () => {
  const f = await fixture();
  try {
    await f.api('PUT', '/features', { memory: true });
    const ids: string[] = [];
    for (const marker of ['FIRST', 'SECOND', 'THIRD']) {
      ids.push(
        (
          await f.api('POST', '/memories', {
            projectId: null,
            content: `预算 ${marker} ${'x'.repeat(2300)}`,
          })
        ).body.id,
      );
    }
    const threadId = (await f.workbench.create(f.firstProject.path, {})).thread.id;
    const result = await f.workbench.send(threadId, [{ type: 'text', text: '预算' }], {}, false);
    const used = (await f.api('GET', `/threads/${threadId}/turns/${result.turn!.id}/memories`))
      .body;
    assert.equal(used.length, 1);
    const input = f.bridge.threads.get(threadId)!.turns[0].items[0].content as { text: string }[];
    for (const id of ids) {
      const memory = f.workbench.continuity!.memory(id)!;
      assert.equal(input[0].text.includes(String(memory.content)), used.includes(id));
    }
  } finally {
    await f.close();
  }
});

test('collaboration capacity contention pauses without creating an ordinary queue message and can resume', async () => {
  const f = await fixture();
  try {
    const group = await discussion(f);
    const occupied: string[] = [];
    for (let i = 0; i < 2; i++) {
      const id = (await f.workbench.create(f.firstProject.path, {})).thread.id;
      occupied.push(id);
      await f.workbench.send(id, [{ type: 'text', text: '慢速占用容量' }], {}, false);
    }
    const run = (await f.api('POST', `/collaborations/${group.id}/runs`, { prompt: '讨论预算' }))
      .body;
    await until(() => f.workbench.continuity!.run(run.id).status === 'paused');
    assert.equal(f.store.publicQueue().length, 0);
    assert.equal(f.workbench.continuity!.run(run.id).currentThreadId, null);
    for (const id of occupied) await f.workbench.interrupt(id);
    const resumed = await f.api('POST', `/collaboration-runs/${run.id}/actions`, {
      action: 'resume',
    });
    assert.equal(resumed.status, 200);
    await until(() => f.workbench.continuity!.run(run.id).status === 'completed');
  } finally {
    await f.close();
  }
});

for (const status of ['failed', 'interrupted'] as const) {
  test(`explicit resume retries a ${status} collaboration step and ignores its late completion`, async () => {
    const f = await fixture();
    try {
      const group = await discussion(f);
      const run = (await f.api('POST', `/collaborations/${group.id}/runs`, { prompt: '慢速讨论' }))
        .body;
      const continuity = f.workbench.continuity!;
      await until(
        () =>
          continuity.run(run.id).status === 'running' &&
          !f.workbench.hasPendingOperation(group.ids[0]),
      );
      const thread = f.bridge.threads.get(group.ids[0])!;
      const failed = thread.turns[0];
      failed.status = status;
      thread.status = { type: 'idle' };
      f.bridge.notify('turn/completed', { threadId: thread.id, turn: failed });
      assert.equal(continuity.run(run.id).status, 'paused');
      assert.equal(thread.turns.length, 1);
      assert.match(continuity.run(run.id).error!, /重新提交本步/);
      const resumed = await f.api('POST', `/collaboration-runs/${run.id}/actions`, {
        action: 'resume',
      });
      assert.equal(resumed.status, 200);
      await until(
        () =>
          thread.turns.length === 2 &&
          continuity.run(run.id).status === 'running' &&
          !f.workbench.hasPendingOperation(thread.id),
      );
      const retry = thread.turns[1];
      assert.notEqual(retry.id, failed.id);
      assert.deepEqual(retry.items[0].content, failed.items[0].content);
      assert.equal(continuity.run(run.id).stepsDone, 0);
      f.bridge.notify('turn/completed', { threadId: thread.id, turn: failed });
      assert.equal(continuity.run(run.id).currentTurnId, retry.id);
      assert.equal(continuity.run(run.id).status, 'running');
      const reply = {
        id: 'retry-final',
        type: 'agentMessage',
        phase: 'final_answer',
        text: '交接成功',
      };
      retry.items.push(reply);
      f.bridge.notify('item/completed', { threadId: thread.id, turnId: retry.id, item: reply });
      retry.status = 'completed';
      thread.status = { type: 'idle' };
      f.bridge.notify('turn/completed', { threadId: thread.id, turn: retry });
      await until(() => continuity.run(run.id).status === 'completed');
      const handoffs = continuity.handoffs(run.id);
      assert.equal(handoffs.length, 2);
      assert.equal(handoffs[0].source_turn_id, retry.id);
      assert.equal(continuity.run(run.id).stepsDone, 2);
      assert.equal(f.bridge.threads.get(group.ids[1])!.turns.length, 1);
    } finally {
      await f.close();
    }
  });
}

for (const action of ['pause', 'stop', 'disable'] as const) {
  test(`${action} during collaboration preparation prevents a late native submission`, async () => {
    const f = await fixture();
    const blocked = gate();
    try {
      const group = await discussion(f);
      const original = f.bridge.call.bind(f.bridge);
      let entered = false;
      f.bridge.call = async (method, params = {}) => {
        if (
          method === 'thread/read' &&
          params.threadId === group.ids[0] &&
          !params.includeTurns &&
          !entered
        ) {
          entered = true;
          await blocked.wait;
        }
        return original(method, params);
      };
      const run = (await f.api('POST', `/collaborations/${group.id}/runs`, { prompt: '讨论预算' }))
        .body;
      await until(() => entered);
      if (action === 'disable') await f.api('PUT', '/features', { collaboration: false });
      else
        assert.equal(
          (await f.api('POST', `/collaboration-runs/${run.id}/actions`, { action })).status,
          200,
        );
      blocked.release();
      await until(() => !f.workbench.hasPendingOperation(group.ids[0]));
      await until(
        () =>
          f.store.db
            .prepare('SELECT current_thread_id FROM collaboration_runs WHERE id=?')
            .get(run.id)?.current_thread_id === null,
      );
      assert.equal(f.bridge.threads.get(group.ids[0])!.turns.length, 0);
      assert.equal(f.store.publicQueue().length, 0);
      const saved = f.store.db
        .prepare('SELECT status FROM collaboration_runs WHERE id=?')
        .get(run.id)!;
      assert.equal(saved.status, action === 'stop' ? 'cancelled' : 'paused');
    } finally {
      blocked.release();
      await f.close();
    }
  });
}

test('a delayed resume cannot revive a stopped collaboration', async () => {
  const f = await fixture();
  const blocked = gate();
  try {
    const group = await discussion(f);
    const run = (await f.api('POST', `/collaborations/${group.id}/runs`, { prompt: '慢速讨论' }))
      .body;
    await until(() => f.workbench.continuity!.run(run.id).status === 'running');
    await f.api('POST', `/collaboration-runs/${run.id}/actions`, { action: 'pause' });
    const original = f.bridge.call.bind(f.bridge);
    let entered = false;
    f.bridge.call = async (method, params = {}) => {
      if (method === 'thread/read' && params.includeTurns && !entered) {
        entered = true;
        const snapshot = structuredClone(await original(method, params));
        await blocked.wait;
        return snapshot;
      }
      return original(method, params);
    };
    const resuming = f.api('POST', `/collaboration-runs/${run.id}/actions`, { action: 'resume' });
    await until(() => entered);
    assert.equal(
      (await f.api('POST', `/collaboration-runs/${run.id}/actions`, { action: 'stop' })).status,
      200,
    );
    blocked.release();
    assert.equal((await resuming).status, 409);
    assert.equal(f.workbench.continuity!.run(run.id).status, 'cancelled');
    assert.equal(f.bridge.threads.get(group.ids[1])!.turns.length, 0);
  } finally {
    blocked.release();
    await f.close();
  }
});

test('only final reply text is handed off and duplicate completion cannot advance twice', async () => {
  const f = await fixture();
  try {
    const group = await discussion(f);
    const run = (await f.api('POST', `/collaborations/${group.id}/runs`, { prompt: '气泡验证' }))
      .body;
    await until(() => f.workbench.continuity!.run(run.id).status === 'completed');
    const handoffs = f.workbench.continuity!.handoffs(run.id);
    assert.equal(handoffs.length, 2);
    assert.equal(handoffs[0].content, '已完成你的任务。');
    const turn = f.bridge.threads.get(group.ids[0])!.turns[0];
    f.workbench.publish('turn/completed', { threadId: group.ids[0], turn });
    assert.equal(f.workbench.continuity!.handoffs(run.id).length, 2);
  } finally {
    await f.close();
  }
});

test('a paused run cannot resume into another collaboration using its members', async () => {
  const f = await fixture();
  try {
    const group = await discussion(f);
    const run = (await f.api('POST', `/collaborations/${group.id}/runs`, { prompt: '讨论预算' }))
      .body;
    await until(() => f.workbench.continuity!.run(run.id).status === 'running');
    await f.api('POST', `/collaboration-runs/${run.id}/actions`, { action: 'pause' });
    await until(() => !f.workbench.active.has(group.ids[0]));
    assert.equal(
      (await f.api('POST', `/collaborations/${group.id}/runs`, { prompt: '重复启动' })).status,
      409,
    );
    const other = await discussion(f, group.ids);
    const otherRun = await f.api('POST', `/collaborations/${other.id}/runs`, {
      prompt: '慢速另一任务',
    });
    assert.equal(otherRun.status, 200);
    const resumed = await f.api('POST', `/collaboration-runs/${run.id}/actions`, {
      action: 'resume',
    });
    assert.equal(resumed.status, 409);
    assert.equal(f.workbench.continuity!.run(run.id).status, 'paused');
    await f.api('POST', `/collaboration-runs/${otherRun.body.id}/actions`, { action: 'stop' });
  } finally {
    await f.close();
  }
});

test('partial completion notifications still hand off the streamed final reply', async () => {
  const f = await fixture();
  try {
    const group = await discussion(f);
    const notify = f.bridge.notify.bind(f.bridge);
    f.bridge.notify = (method, params) =>
      notify(
        method,
        method === 'turn/completed' ? { ...params, turn: { ...params.turn, items: [] } } : params,
      );
    const run = (await f.api('POST', `/collaborations/${group.id}/runs`, { prompt: '讨论方案' }))
      .body;
    await until(() => f.workbench.continuity!.run(run.id).status === 'completed');
    assert.equal(f.workbench.continuity!.handoffs(run.id)[0].content, '已完成你的任务。');
  } finally {
    await f.close();
  }
});

test('feature changes during asynchronous member validation cannot create a hidden run', async () => {
  const f = await fixture();
  const blocked = gate();
  try {
    const group = await discussion(f);
    const original = f.workbench.threadDirectory.bind(f.workbench);
    let entered = false;
    f.workbench.threadDirectory = async (id) => {
      if (!entered) {
        entered = true;
        await blocked.wait;
      }
      return original(id);
    };
    const starting = f.api('POST', `/collaborations/${group.id}/runs`, { prompt: '讨论预算' });
    await until(() => entered);
    await f.api('PUT', '/features', { collaboration: false });
    blocked.release();
    assert.equal((await starting).status, 409);
    assert.equal(
      f.store.db.prepare('SELECT COUNT(*) AS total FROM collaboration_runs').get()!.total,
      0,
    );
  } finally {
    blocked.release();
    await f.close();
  }
});

test('disconnect pauses collaboration and an uncertain submission can be ended without replay', async () => {
  const f = await fixture();
  try {
    const group = await discussion(f);
    const run = (await f.api('POST', `/collaborations/${group.id}/runs`, { prompt: '慢速讨论' }))
      .body;
    await until(() => f.workbench.continuity!.run(run.id).status === 'running');
    f.bridge.emit('disconnect', 'test disconnect');
    assert.equal(f.workbench.continuity!.run(run.id).status, 'paused');
    assert.equal(f.bridge.threads.get(group.ids[1])!.turns.length, 0);
    // Represents a restart after turn/start was sent but its response was lost.
    f.store.db.prepare('UPDATE collaboration_runs SET current_turn_id=NULL WHERE id=?').run(run.id);
    const resumed = await f.api('POST', `/collaboration-runs/${run.id}/actions`, {
      action: 'resume',
    });
    assert.equal(resumed.status, 409);
    assert.equal(f.bridge.threads.get(group.ids[0])!.turns.length, 1);
    const stopped = await f.api('POST', `/collaboration-runs/${run.id}/actions`, {
      action: 'stop',
    });
    assert.equal(stopped.status, 200);
    assert.equal(stopped.body.status, 'cancelled');
    assert.match(stopped.body.error, /核对/);
    assert.equal(f.bridge.threads.get(group.ids[0])!.turns.length, 1);
  } finally {
    await f.close();
  }
});

test('stopping a paused run targets its original native turn even if a newer turn starts while history is read', async () => {
  const f = await fixture();
  const blocked = gate();
  try {
    const group = await discussion(f);
    const run = (await f.api('POST', `/collaborations/${group.id}/runs`, { prompt: '慢速讨论' }))
      .body;
    await until(() => f.workbench.continuity!.run(run.id).status === 'running');
    const originalTurnId = f.workbench.continuity!.run(run.id).currentTurnId;
    const original = f.bridge.call.bind(f.bridge);
    let entered = false;
    let interrupted: unknown;
    f.bridge.call = async (method, params = {}) => {
      if (method === 'thread/read' && params.includeTurns && !entered) {
        entered = true;
        const snapshot = structuredClone(await original(method, params));
        await blocked.wait;
        return snapshot;
      }
      if (method === 'turn/interrupt') {
        interrupted = params.turnId;
        return {};
      }
      return original(method, params);
    };
    const stopping = f.api('POST', `/collaboration-runs/${run.id}/actions`, { action: 'stop' });
    await until(() => entered);
    f.workbench.active.set(group.ids[0], {
      threadId: group.ids[0],
      turnId: 'new-unrelated-turn',
      cwd: f.firstProject.path,
    });
    blocked.release();
    assert.equal((await stopping).status, 200);
    assert.equal(interrupted, originalTurnId);
    assert.equal(f.workbench.active.get(group.ids[0])?.turnId, 'new-unrelated-turn');
  } finally {
    blocked.release();
    await f.close();
  }
});

test('a late read from the previous step cannot clear the next step submission ownership', async () => {
  const f = await fixture();
  const firstRead = gate();
  const secondStart = gate();
  try {
    const group = await discussion(f);
    const original = f.bridge.call.bind(f.bridge);
    let readingFirst = false;
    let startingSecond = false;
    f.bridge.call = async (method, params = {}) => {
      if (
        method === 'thread/read' &&
        params.includeTurns &&
        params.threadId === group.ids[0] &&
        !readingFirst
      ) {
        readingFirst = true;
        const snapshot = structuredClone(await original(method, params));
        await firstRead.wait;
        return snapshot;
      }
      if (method === 'turn/start' && params.threadId === group.ids[1]) {
        const result = await original(method, params);
        startingSecond = true;
        await secondStart.wait;
        return result;
      }
      return original(method, params);
    };
    const run = (await f.api('POST', `/collaborations/${group.id}/runs`, { prompt: '讨论预算' }))
      .body;
    await until(() => readingFirst && startingSecond);
    firstRead.release();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    const stopped = await f.api('POST', `/collaboration-runs/${run.id}/actions`, {
      action: 'stop',
    });
    assert.equal(stopped.body.status, 'stopping');
    secondStart.release();
    await until(() => f.workbench.continuity!.run(run.id).status === 'cancelled');
    assert.equal(f.bridge.threads.get(group.ids[1])!.turns[0].status, 'interrupted');
  } finally {
    firstRead.release();
    secondStart.release();
    await f.close();
  }
});
