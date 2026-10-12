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
import type { Json } from '../shared/types.js';

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-cloud-project-context-'));
  const store = new Store(path.join(root, 'data'));
  const bridge = new MockCodex(root);
  const calls: { method: string; params: Json }[] = [];
  const call = bridge.call.bind(bridge);
  bridge.call = async (method, params = {}) => {
    calls.push({ method, params: structuredClone(params) });
    return call(method, params);
  };
  const wb = new Workbench(bridge, store, 2);
  const app = await buildApp(store, wb, { logger: false });
  await new Auth(store).change('project-context-test-password');
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { origin: config.origin },
    payload: { password: 'project-context-test-password' },
  });
  const headers = {
    origin: config.origin,
    cookie: `${login.cookies[0].name}=${login.cookies[0].value}`,
  };
  return {
    root,
    store,
    bridge,
    calls,
    wb,
    app,
    headers,
    async close() {
      wb.dispose();
      await app.close();
      bridge.stop();
      store.close();
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}
async function until(check: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!check()) {
    assert.ok(Date.now() < deadline, 'state transition timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('project API validates context controls, preserves all five thresholds and defaults legacy projects', async () => {
  const f = await fixture();
  try {
    for (const autoCompactPercent of [49, 55, 65, 91, 70.5, '70', null]) {
      const response = await f.app.inject({
        method: 'POST',
        url: '/api/projects',
        headers: f.headers,
        payload: { name: 'invalid', path: f.root, contextWindow1M: true, autoCompactPercent },
      });
      assert.equal(response.statusCode, 400, response.body);
    }
    const invalidToggle = await f.app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: f.headers,
      payload: { name: 'invalid', path: f.root, contextWindow1M: 'true' },
    });
    assert.equal(invalidToggle.statusCode, 400);
    assert.equal(f.store.projects().length, 0);
    for (const percent of [50, 60, 70, 80, 90]) {
      const response = await f.app.inject({
        method: 'POST',
        url: '/api/projects',
        headers: f.headers,
        payload: {
          name: `context-${percent}`,
          path: path.join(f.root, `project-${percent}`),
          create: true,
          contextWindow1M: true,
          autoCompactPercent: percent,
        },
      });
      assert.equal(response.statusCode, 200, response.body);
      const project = response.json();
      assert.equal(project.contextWindow1M, true);
      assert.equal(project.autoCompactPercent, percent);
      await f.wb.create(project.path, {});
      assert.deepEqual(f.calls.filter((c) => c.method === 'thread/start').at(-1)!.params.config, {
        model_post_turn_compact_threshold_percent: percent,
        model_context_window: 1_000_000,
        model_auto_compact_token_limit: percent * 10_000,
      });
    }
    const defaults = await f.app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: f.headers,
      payload: { name: 'default', path: f.root },
    });
    assert.equal(defaults.statusCode, 200);
    assert.equal(defaults.json().contextWindow1M, false);
    assert.equal(defaults.json().autoCompactPercent, 90);
    const legacy = defaults.json();
    f.store.db.prepare('DELETE FROM settings WHERE key=?').run(`projectContext:${legacy.id}`);
    f.store.close();
    f.store.reload();
    const projects = (await f.app.inject({ url: '/api/projects', headers: f.headers })).json();
    assert.equal(projects.find((p: Json) => p.id === legacy.id).contextWindow1M, false);
    for (const percent of [50, 60, 70, 80, 90]) {
      const saved = projects.find((p: Json) => p.name === `context-${percent}`);
      assert.equal(saved.autoCompactPercent, percent);
      assert.equal(saved.contextWindow1M, true);
    }
    const removed = projects.find((p: Json) => p.name === 'context-50');
    assert.equal(
      (
        await f.app.inject({
          method: 'DELETE',
          url: `/api/projects/${removed.id}`,
          headers: f.headers,
        })
      ).statusCode,
      200,
    );
    assert.equal(f.store.get(`projectContext:${removed.id}`), undefined);
    assert.equal((await fs.stat(removed.path)).isDirectory(), true);
  } finally {
    await f.close();
  }
});

test('project context reaches creation, reconnect, fork and queue without leaking across concurrent projects', async () => {
  const f = await fixture();
  try {
    const threads: string[] = [];
    for (const [name, enabled, percent] of [
      ['large', true, 70],
      ['other', true, 50],
      ['default', false, 60],
    ] as const) {
      const cwd = path.join(f.root, name);
      await fs.mkdir(cwd);
      f.store.addProject(name, cwd, { contextWindow1M: enabled, autoCompactPercent: percent });
      threads.push((await f.wb.create(cwd, {})).thread.id);
    }
    const starts = f.calls.filter((c) => c.method === 'thread/start');
    assert.equal(starts[0].params.config.model_auto_compact_token_limit, 700_000);
    assert.equal(starts[1].params.config.model_auto_compact_token_limit, 500_000);
    assert.deepEqual(starts[2].params.config, { model_post_turn_compact_threshold_percent: 60 });
    await f.wb.forceStop();
    const input = [{ type: 'text', text: '慢速 context isolation' }];
    await Promise.all(threads.slice(0, 2).map((id) => f.wb.send(id, input, {}, false)));
    assert.equal(f.wb.active.size, 2);
    for (const [id, threshold] of [
      [threads[0], 700_000],
      [threads[1], 500_000],
    ] as const) {
      const resumed = f.calls.find(
        (c) => c.method === 'thread/resume' && c.params.threadId === id,
      )!;
      assert.deepEqual(resumed.params.config, {
        model_post_turn_compact_threshold_percent: threshold / 10_000,
        model_context_window: 1_000_000,
        model_auto_compact_token_limit: threshold,
      });
    }
    assert.equal((await f.wb.send(threads[2], input, {}, false)).queued, true);
    await f.wb.interrupt(threads[0]);
    await until(() => f.wb.active.has(threads[2]));
    const normal = f.calls.find(
      (c) => c.method === 'thread/resume' && c.params.threadId === threads[2],
    )!;
    assert.deepEqual(normal.params.config, { model_post_turn_compact_threshold_percent: 60 });
    await f.wb.action(threads[0], 'fork');
    assert.deepEqual(f.calls.find((c) => c.method === 'thread/fork')!.params.config, {
      model_post_turn_compact_threshold_percent: 70,
      model_context_window: 1_000_000,
      model_auto_compact_token_limit: 700_000,
    });
  } finally {
    await f.close();
  }
});
