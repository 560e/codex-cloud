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

test('HTML preview assets are scoped, sandboxed, size-limited and revoked with the login session', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'html-preview-'));
  const project = path.join(root, 'project');
  await fs.mkdir(project);
  await fs.writeFile(path.join(project, 'index.html'), '<h1>preview</h1>');
  await fs.writeFile(path.join(project, 'style.css'), 'h1{color:blue}');
  await fs.writeFile(path.join(project, '.private.js'), 'private');
  await fs.writeFile(path.join(root, 'outside.js'), 'outside');
  await fs.symlink(path.join(root, 'outside.js'), path.join(project, 'escape.js'));
  await fs.writeFile(path.join(project, '.env'), 'synthetic');
  await fs.symlink(path.join(project, '.env'), path.join(project, 'secret.js'));
  await fs.writeFile(path.join(project, 'large.html'), 'x'.repeat(2 * 1024 * 1024 + 1));
  const store = new Store(path.join(root, 'data'));
  const bridge = new MockCodex(project);
  const wb = new Workbench(bridge, store, 3);
  const app = await buildApp(store, wb, { logger: false });
  try {
    const p = store.addProject('preview', project);
    const payload = { project: p.id, path: 'index.html' };
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/html-preview',
          headers: { origin: config.origin },
          payload,
        })
      ).statusCode,
      401,
    );
    await new Auth(store).change('preview-test-password');
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: config.origin },
      payload: { password: 'preview-test-password' },
    });
    const headers = {
      origin: config.origin,
      cookie: `${login.cookies[0].name}=${login.cookies[0].value}`,
    };
    const created = await app.inject({
      method: 'POST',
      url: '/api/html-preview',
      headers,
      payload,
    });
    assert.equal(created.statusCode, 200, created.body);
    const url = created.json().url;
    const html = await app.inject({ url }); // Opaque frames need no session cookie.
    assert.equal(html.statusCode, 200);
    assert.match(String(html.headers['content-security-policy']), /sandbox allow-scripts;/);
    assert.ok(!String(html.headers['content-security-policy']).includes('allow-same-origin'));
    assert.equal(html.headers['x-frame-options'], 'SAMEORIGIN');
    assert.equal(html.headers['access-control-allow-origin'], 'null');
    const asset = (name: string) => app.inject({ url: url.replace('index.html', name) });
    assert.equal((await asset('style.css')).body, 'h1{color:blue}');
    assert.equal((await asset('.private.js')).statusCode, 403);
    assert.equal((await asset('.env')).statusCode, 403);
    assert.equal((await asset('escape.js')).statusCode, 403);
    assert.equal((await asset('secret.js')).statusCode, 403);
    assert.equal((await asset('%2e%2e%2foutside.js')).statusCode, 403);
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/html-preview',
          headers,
          payload: { ...payload, path: 'large.html' },
        })
      ).statusCode,
      413,
    );
    assert.equal(
      (await app.inject({ url: url.replace(/html-preview\/[^/]+/, 'html-preview/invalid') }))
        .statusCode,
      401,
    );
    await app.inject({ method: 'POST', url: '/api/auth/logout', headers });
    assert.equal((await app.inject({ url })).statusCode, 401);
  } finally {
    wb.dispose();
    await app.close();
    bridge.stop();
    store.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
