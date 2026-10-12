import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseFileLink } from '../shared/file-links.js';
import { resolveFileLink } from '../server/files.js';
import { buildApp } from '../server/app.js';
import { config } from '../server/config.js';
import { Store } from '../server/store.js';
import { Workbench } from '../server/workbench.js';
import { MockCodex } from './mock-codex.js';
import { Auth } from '../server/auth.js';

test('Markdown file destinations recognize Windows, Linux, encoded names and line suffixes without enabling URI handlers', () => {
  for (const [href, expected] of [
    ['src/main.ts:12:3', { path: 'src/main.ts', line: 12, column: 3 }],
    ['README.md:8', { path: 'README.md', line: 8 }],
    ['/srv/project/a.ts#L9-L12', { path: '/srv/project/a.ts', line: 9 }],
    ['C:\\project\\a.ts:9:2', { path: 'C:/project/a.ts', line: 9, column: 2 }],
    ['file:///C:/project/a%20b.ts#L7C2', { path: 'C:/project/a b.ts', line: 7, column: 2 }],
    ['file:///srv/a%23b.ts:4', { path: '/srv/a#b.ts', line: 4 }],
    ['docs/', { path: 'docs/' }],
  ] as const)
    assert.deepEqual(parseFileLink(href), expected);
  for (const href of [
    'https://example.com',
    'mailto:a@example.com',
    'javascript:alert(1)',
    'javascript:1',
    '%6aavascript:alert(1)',
    'data:text/html,hello',
    'command:run',
    'file://remote-host/share/x',
    '\\\\host\\share\\x',
    '//example.com',
    '#heading',
    'x.ts:0',
    'x.ts#L999999999999999999',
    '%00x',
    '%zz',
  ])
    assert.equal(parseFileLink(href), null, href);
});

test('file links resolve only current-project files and directories through authenticated API', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-links-'));
  const cwd = path.join(root, 'project');
  await fs.mkdir(path.join(cwd, 'docs'), { recursive: true });
  await fs.writeFile(path.join(cwd, 'a b.ts'), 'first\nsecond\nthird');
  await fs.writeFile(path.join(root, 'secret.txt'), 'outside');
  await fs.mkdir(path.join(cwd, '.git'));
  await fs.writeFile(path.join(cwd, '.git', 'config'), 'internal');
  await fs.symlink(
    root,
    path.join(cwd, 'escape'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  const store = new Store(path.join(root, 'data'));
  const bridge = new MockCodex(cwd);
  const wb = new Workbench(bridge, store, 1);
  const thread = (await wb.create(cwd, {})).thread;
  const app = await buildApp(store, wb, { logger: false });
  try {
    for (const href of [
      'a%20b.ts:2',
      path.join(cwd, 'a b.ts') + ':2',
      pathToFileURL(path.join(cwd, 'a b.ts')).href + '#L2',
    ]) {
      assert.deepEqual(await resolveFileLink(cwd, href), {
        path: 'a b.ts',
        line: 2,
        directory: false,
      });
    }
    assert.deepEqual(await resolveFileLink(cwd, 'docs/'), { path: 'docs', directory: true });
    for (const href of [
      '../secret.txt',
      path.join(root, 'secret.txt'),
      'escape/secret.txt',
      '.git/config',
      '%2e%2e/secret.txt',
    ])
      await assert.rejects(resolveFileLink(cwd, href));
    const url = `/api/file-link?thread=${thread.id}&target=a%2520b.ts%3A2`;
    assert.equal((await app.inject({ url })).statusCode, 401);
    await new Auth(store).change('file-link-password');
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: config.origin },
      payload: { password: 'file-link-password' },
    });
    const headers = { cookie: `${login.cookies[0].name}=${login.cookies[0].value}` };
    const resolved = await app.inject({ url, headers });
    assert.equal(resolved.statusCode, 200, resolved.body);
    assert.equal(resolved.json().line, 2);
    assert.equal(
      (await app.inject({ url: `/api/file-link?thread=${thread.id}&target=missing.ts`, headers }))
        .statusCode,
      404,
    );
    assert.equal(
      (
        await app.inject({
          url: `/api/file-link?thread=${thread.id}&target=..%2Fsecret.txt`,
          headers,
        })
      ).statusCode,
      403,
    );
  } finally {
    await app.close();
    bridge.stop();
    store.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
