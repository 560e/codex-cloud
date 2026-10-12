import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildApp } from '../server/app.js';
import { config } from '../server/config.js';
import { Store } from '../server/store.js';
import { Workbench } from '../server/workbench.js';
import { MockCodex } from './mock-codex.js';
import { Auth } from '../server/auth.js';
import { imagePreviewLimit } from '../shared/image-preview.js';

test('image previews require authentication, enforce project boundaries and limit content', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-image-'));
  const cwd = path.join(root, 'project');
  await fs.mkdir(cwd);
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><script>alert(1)</script></svg>';
  await fs.writeFile(path.join(cwd, '图 #1.SVG'), svg);
  await fs.writeFile(path.join(cwd, 'note.txt'), 'not an image');
  await fs.writeFile(path.join(root, 'outside.svg'), svg);
  await fs.symlink(
    root,
    path.join(cwd, 'escape'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  const large = await fs.open(path.join(cwd, 'large.png'), 'w');
  await large.truncate(imagePreviewLimit + 1);
  await large.close();
  const store = new Store(path.join(root, 'data'));
  const bridge = new MockCodex(cwd);
  const wb = new Workbench(bridge, store, 1);
  const project = store.addProject('Images', cwd);
  const app = await buildApp(store, wb, { logger: false });
  const url = (file: string, mode = 'preview') =>
    `/api/files?project=${project.id}&mode=${mode}&path=${encodeURIComponent(file)}`;
  try {
    assert.equal((await app.inject({ url: url('图 #1.SVG') })).statusCode, 401);
    await new Auth(store).change('image-test-password');
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: config.origin },
      payload: { password: 'image-test-password' },
    });
    const headers = { cookie: `${login.cookies[0].name}=${login.cookies[0].value}` };
    const image = await app.inject({ url: url('图 #1.SVG'), headers });
    assert.equal(image.statusCode, 200);
    assert.equal(image.body, svg);
    assert.match(String(image.headers['content-type']), /image\/svg\+xml/);
    assert.match(String(image.headers['content-security-policy']), /sandbox; default-src 'none'/);
    assert.equal(image.headers['x-content-type-options'], 'nosniff');
    assert.equal(image.headers['cache-control'], 'no-store');
    for (const [file, status] of [
      ['../outside.svg', 403],
      ['escape/outside.svg', 403],
      ['large.png', 413],
      ['note.txt', 415],
      ['', 400],
    ] as const) {
      assert.equal((await app.inject({ url: url(file), headers })).statusCode, status, file);
    }
    const download = await app.inject({ url: url('图 #1.SVG', 'download'), headers });
    assert.equal(download.statusCode, 200);
    assert.match(String(download.headers['content-disposition']), /^attachment/);
  } finally {
    await app.close();
    bridge.stop();
    store.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
