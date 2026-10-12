import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CodexBridge } from '../server/codex.js';
import { Store } from '../server/store.js';
import { Workbench } from '../server/workbench.js';
import { MockCodex } from './mock-codex.js';
import { buildApp } from '../server/app.js';
import { Auth } from '../server/auth.js';
import { config } from '../server/config.js';

test('project removal respects filesystem case sensitivity and still blocks active projects', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-case-'));
  const store = new Store(path.join(root, 'data'));
  const bridge = new MockCodex(root);
  const wb = new Workbench(bridge, store, 1);
  const app = await buildApp(store, wb, { logger: false });
  try {
    await new Auth(store).change('test-path-password');
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: config.origin },
      payload: { password: 'test-path-password' },
    });
    const headers = {
      origin: config.origin,
      cookie: `${response.cookies[0].name}=${response.cookies[0].value}`,
    };
    const project = store.addProject('Upper', path.join(root, 'Project'));
    wb.active.set('running', {
      threadId: 'running',
      turnId: 'turn',
      cwd: path.join(root, 'project'),
    });
    const removal = await app.inject({
      method: 'DELETE',
      url: `/api/projects/${project.id}`,
      headers,
    });
    assert.equal(removal.statusCode, process.platform === 'win32' ? 409 : 200);
    const active = store.addProject('Active', path.join(root, 'project'));
    assert.equal(
      (await app.inject({ method: 'DELETE', url: `/api/projects/${active.id}`, headers }))
        .statusCode,
      409,
    );
  } finally {
    await app.close();
    bridge.stop();
    store.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test(
  'Linux stop kills owned descendants even when the group ignores SIGTERM',
  { skip: process.platform !== 'linux', timeout: 10000 },
  async () => {
    const grandchild = `process.on('SIGTERM', () => {}); console.log(process.pid); setInterval(() => {}, 1000);`;
    const parent = `const { spawn } = require('node:child_process'); process.on('SIGTERM', () => {}); spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: ['ignore', 'inherit', 'inherit'] }); setInterval(() => {}, 1000);`;
    const child = spawn(process.execPath, ['-e', parent], {
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const bridge = new CodexBridge();
    bridge.child = child;
    const lines = createInterface({ input: child.stdout });
    try {
      const [line] = await once(lines, 'line', { signal: AbortSignal.timeout(4000) });
      const pid = Number(line);
      assert.ok(pid > 0);
      const exited = once(child, 'exit');
      bridge.stop();
      const [, signal] = await exited;
      assert.equal(signal, 'SIGKILL');
      // A killed orphan can remain a zombie until the host's PID 1 reaps it.
      let state = '';
      for (let attempt = 0; attempt < 50; attempt++) {
        state = await fs
          .readFile(`/proc/${pid}/stat`, 'utf8')
          .catch((error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT' || error.code === 'ESRCH') return '';
            throw error;
          });
        if (!state || /\) [ZX] /.test(state)) break;
        await delay(20);
      }
      assert.ok(!state || /\) [ZX] /.test(state), `descendant still running: ${state}`);
    } finally {
      lines.close();
      if (child.pid) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
      }
    }
  },
);
