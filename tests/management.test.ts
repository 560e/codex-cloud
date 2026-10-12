import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../server/store.js';
import { Workbench } from '../server/workbench.js';
import { MockCodex } from './mock-codex.js';
import { buildApp } from '../server/app.js';
import { Auth } from '../server/auth.js';
import { config } from '../server/config.js';
import type { Json } from '../shared/types.js';
import { readCodexConfig, userSkillsHome } from '../server/extensions.js';

test('the renamed Skills setting preserves an existing custom directory', () => {
  const current = process.env.CODEX_CLOUD_SKILLS_HOME;
  const legacy = process.env.ARRAN_SKILLS_HOME;
  try {
    delete process.env.CODEX_CLOUD_SKILLS_HOME;
    process.env.ARRAN_SKILLS_HOME = '/tmp/previous-skills';
    assert.equal(userSkillsHome(), path.resolve('/tmp/previous-skills'));
    process.env.CODEX_CLOUD_SKILLS_HOME = '/tmp/current-skills';
    assert.equal(userSkillsHome(), path.resolve('/tmp/current-skills'));
  } finally {
    if (current === undefined) delete process.env.CODEX_CLOUD_SKILLS_HOME;
    else process.env.CODEX_CLOUD_SKILLS_HOME = current;
    if (legacy === undefined) delete process.env.ARRAN_SKILLS_HOME;
    else process.env.ARRAN_SKILLS_HOME = legacy;
  }
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-cloud-management-'));
  const cwd = path.join(root, 'project');
  await fs.mkdir(cwd);
  const oldHome = process.env.CODEX_HOME;
  const oldSkills = process.env.CODEX_CLOUD_SKILLS_HOME;
  process.env.CODEX_HOME = path.join(root, 'codex');
  process.env.CODEX_CLOUD_SKILLS_HOME = path.join(root, 'skills');
  const store = new Store(path.join(root, 'data'));
  const project = store.addProject('one', cwd);
  const second = store.addProject('two', path.join(root, 'other'));
  const bridge = new MockCodex(cwd);
  const calls: { method: string; params: Json }[] = [];
  const original = bridge.call.bind(bridge);
  bridge.call = async (method, params = {}) => {
    calls.push({ method, params });
    return original(method, params);
  };
  const wb = new Workbench(bridge, store, 2);
  const app = await buildApp(store, wb, { logger: false });
  await new Auth(store).change('management-test-password');
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { origin: config.origin },
    payload: { password: 'management-test-password' },
  });
  const cookie = login.cookies[0].name + '=' + login.cookies[0].value;
  const headers = { origin: config.origin, cookie };
  return {
    root,
    store,
    project,
    second,
    bridge,
    calls,
    wb,
    app,
    headers,
    close: async () => {
      await app.close();
      bridge.stop();
      store.close();
      if (oldHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = oldHome;
      if (oldSkills === undefined) delete process.env.CODEX_CLOUD_SKILLS_HOME;
      else process.env.CODEX_CLOUD_SKILLS_HOME = oldSkills;
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

test('project prompts persist independently and reach native creation, resume and queued sends', async () => {
  const f = await fixture();
  try {
    assert.equal(
      (
        await f.app.inject({
          method: 'PUT',
          url: `/api/projects/${f.project.id}/prompt`,
          payload: { systemPrompt: 'one' },
        })
      ).statusCode,
      403,
    );
    const url = `/api/projects/${f.project.id}/prompt`;
    assert.equal(
      (
        await f.app.inject({
          method: 'PUT',
          url,
          headers: f.headers,
          payload: { systemPrompt: '中文回答' },
        })
      ).statusCode,
      200,
    );
    assert.equal(f.store.projects()[1].systemPrompt, '');
    const thread = (await f.wb.create(f.project.path, {})).thread;
    assert.equal(
      f.calls.find((c) => c.method === 'thread/start')!.params.developerInstructions,
      '中文回答',
    );
    await f.app.inject({
      method: 'PUT',
      url,
      headers: f.headers,
      payload: { systemPrompt: '新的约定' },
    });
    await f.wb.send(thread.id, [{ type: 'text', text: '测试' }], {}, false);
    assert.equal(
      f.calls.find((c) => c.method === 'thread/resume')!.params.developerInstructions,
      '新的约定',
    );
    await f.wb.interrupt(thread.id);
    await f.app.inject({ method: 'PUT', url, headers: f.headers, payload: { systemPrompt: '' } });
    await f.wb.send(thread.id, [{ type: 'text', text: '清除提示' }], {}, false);
    assert.equal(
      f.calls.filter((c) => c.method === 'thread/resume').at(-1)!.params.developerInstructions,
      '',
    );
    const other = (await f.wb.create(f.second.path, {})).thread;
    assert.ok(other.id);
    assert.equal(
      f.calls.filter((c) => c.method === 'thread/start').at(-1)!.params.developerInstructions,
      '',
    );
  } finally {
    await f.close();
  }
});

test('extension management requires login only and writes real Skills and MCP config', async () => {
  const f = await fixture();
  try {
    for (const url of ['/api/mcp', '/api/cli']) {
      assert.equal((await f.app.inject({ method: 'GET', url })).statusCode, 401);
    }
    assert.equal((await f.app.inject({ url: '/api/mcp', headers: f.headers })).statusCode, 200);
    const skill = {
      name: 'test-skill',
      content: '---\nname: test-skill\ndescription: test skill\n---\nRun checks.\n',
    };
    assert.equal(
      (
        await f.app.inject({
          method: 'PUT',
          url: '/api/skills',
          headers: f.headers,
          payload: skill,
        })
      ).statusCode,
      200,
    );
    const skills = (
      await f.app.inject({ method: 'GET', url: '/api/skills', headers: f.headers })
    ).json();
    assert.equal(skills[0].name, 'test-skill');
    assert.equal(skills[0].editable, true);
    assert.equal(
      (
        await f.app.inject({
          method: 'POST',
          url: '/api/skills/enabled',
          headers: f.headers,
          payload: { path: skills[0].path, enabled: false },
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (await f.app.inject({ method: 'GET', url: '/api/skills', headers: f.headers })).json()[0]
        .enabled,
      false,
    );
    const mcp = {
      name: 'sample',
      transport: 'stdio',
      command: 'node',
      args: ['server.js'],
      env: { TEST_TOKEN: 'test-secret' },
      enabled: true,
    };
    assert.equal(
      (await f.app.inject({ method: 'PUT', url: '/api/mcp', headers: f.headers, payload: mcp }))
        .statusCode,
      200,
    );
    assert.equal(
      (await readCodexConfig()).config.mcp_servers &&
        ((await readCodexConfig()).config.mcp_servers as Json).sample.command,
      'node',
    );
    assert.equal(
      (
        await f.app.inject({
          method: 'PUT',
          url: '/api/mcp',
          headers: f.headers,
          payload: { ...mcp, enabled: false },
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (await f.app.inject({ method: 'GET', url: '/api/mcp', headers: f.headers })).json().servers[0]
        .enabled,
      false,
    );
    const thread = (await f.wb.create(f.project.path, {})).thread;
    await f.wb.send(thread.id, [{ type: 'text', text: '慢速' }], {}, false);
    assert.equal(
      (await f.app.inject({ method: 'PUT', url: '/api/mcp', headers: f.headers, payload: mcp }))
        .statusCode,
      409,
    );
    assert.equal(
      (await f.app.inject({ method: 'POST', url: '/api/migration/export', headers: f.headers }))
        .statusCode,
      409,
    );
    await f.wb.interrupt(thread.id);
    assert.equal(
      (await f.app.inject({ method: 'DELETE', url: '/api/mcp/sample', headers: f.headers }))
        .statusCode,
      200,
    );
    assert.equal(
      (await f.app.inject({ method: 'DELETE', url: '/api/skills/test-skill', headers: f.headers }))
        .statusCode,
      200,
    );
    assert.deepEqual(
      (await f.app.inject({ method: 'GET', url: '/api/mcp', headers: f.headers })).json().servers,
      [],
    );
  } finally {
    await f.close();
  }
});
