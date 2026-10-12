import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../server/store.js';
import { Workbench } from '../server/workbench.js';
import { threadExecution, legacyThreadExecution } from '../server/thread-execution.js';
import { MockCodex } from './mock-codex.js';

test('execution settings survive service restarts and executor disconnects without changing readonly sessions', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-execution-'));
  let store = new Store(path.join(root, 'data'));
  const bridge = new MockCodex(root);
  let workbench = new Workbench(bridge, store, 1);
  const resumes: Record<string, unknown>[] = [];
  const call = bridge.call.bind(bridge);
  bridge.call = async (method, params = {}) => {
    if (method === 'thread/resume') resumes.push(params);
    return call(method, params);
  };
  try {
    const threads = [];
    for (const sandbox of ['read-only', 'workspace-write', 'danger-full-access']) {
      const { thread } = await workbench.create(root, { sandbox, approvalPolicy: 'on-request' });
      threads.push({ id: thread.id, sandbox });
    }
    workbench.dispose();
    bridge.stop();
    store.close();
    store = new Store(path.join(root, 'data'), true);
    workbench = new Workbench(bridge, store, 1);
    for (const thread of threads) {
      await workbench.send(thread.id, [{ type: 'text', text: '慢速' }], {}, false);
      assert.equal(resumes.at(-1)?.sandbox, thread.sandbox);
      assert.equal(resumes.at(-1)?.approvalPolicy, 'on-request');
      await workbench.interrupt(thread.id);
      bridge.emit('disconnect', 'test reconnect');
    }
  } finally {
    workbench.dispose();
    bridge.stop();
    store.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('forked threads preserve execution settings and deletion removes the saved permissions', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-fork-policy-'));
  const store = new Store(path.join(root, 'data'));
  const bridge = new MockCodex(root);
  const workbench = new Workbench(bridge, store, 1);
  try {
    const { thread } = await workbench.create(root, {
      sandbox: 'read-only',
      approvalPolicy: 'never',
    });
    const result = (await workbench.action(thread.id, 'fork')) as { thread: { id: string } };
    assert.deepEqual(store.threadExecution(result.thread.id), {
      sandbox: 'read-only',
      approvalPolicy: 'never',
    });
    store.deleteThreadData(result.thread.id);
    assert.equal(store.threadExecution(result.thread.id), null);
    assert.equal(store.threadExecution(thread.id)?.sandbox, 'read-only');
  } finally {
    workbench.dispose();
    bridge.stop();
    store.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('managed native permissions override requested defaults and invalid saved settings fail closed', () => {
  assert.deepEqual(
    threadExecution(
      { sandbox: { type: 'readOnly' }, approvalPolicy: 'never' },
      {
        sandbox: 'danger-full-access',
        approvalPolicy: 'on-request',
      },
    ),
    { sandbox: 'read-only', approvalPolicy: 'never' },
  );
  assert.throws(() => threadExecution({}, { sandbox: 'unknown' }));
});

test('legacy workbench resumes recover the original permission rather than the overwritten readonly default', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-legacy-policy-'));
  const store = new Store(path.join(root, 'data'));
  const bridge = new MockCodex(root);
  const workbench = new Workbench(bridge, store, 1);
  try {
    const thread = bridge.makeThread(root);
    const file = path.join(root, 'history.jsonl');
    thread.path = file;
    const rows = [
      { type: 'session_meta', payload: { id: thread.id, originator: 'codex_private_workbench' } },
      {
        type: 'turn_context',
        payload: { sandbox_policy: { type: 'danger-full-access' }, approval_policy: 'never' },
      },
      {
        type: 'turn_context',
        payload: { sandbox_policy: { type: 'read-only' }, approval_policy: 'never' },
      },
    ];
    await fs.writeFile(file, rows.map((row) => JSON.stringify(row)).join('\n'));
    let resumed: Record<string, unknown> = {};
    const call = bridge.call.bind(bridge);
    bridge.call = async (method, params = {}) => {
      if (method === 'thread/resume') resumed = params;
      return call(method, params);
    };
    const fork = (await workbench.action(thread.id, 'fork')) as { thread: { id: string } };
    assert.deepEqual(store.threadExecution(fork.thread.id), {
      sandbox: 'danger-full-access',
      approvalPolicy: 'never',
    });
    await workbench.send(thread.id, [{ type: 'text', text: '慢速' }], {}, false);
    assert.equal(resumed.sandbox, 'danger-full-access');
    assert.equal(resumed.approvalPolicy, 'never');
    assert.equal(store.threadExecution(thread.id)?.sandbox, 'danger-full-access');
    await workbench.interrupt(thread.id);
    rows[0].payload.originator = 'codex_cli_rs';
    await fs.writeFile(file, rows.map((row) => JSON.stringify(row)).join('\n'));
    assert.equal(await legacyThreadExecution(file, thread.id), null);
    assert.equal(await legacyThreadExecution(file, 'another-thread'), null);
    assert.equal(await legacyThreadExecution(path.join(root, 'missing.jsonl'), thread.id), null);
    await fs.writeFile(file, 'null\n');
    assert.equal(await legacyThreadExecution(file, thread.id), null);
  } finally {
    workbench.dispose();
    bridge.stop();
    store.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
