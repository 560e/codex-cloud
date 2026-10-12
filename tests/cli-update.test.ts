import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  validCliVersion,
  managedCli,
  activateCli,
  latestCliVersion,
} from '../server/cli-update.js';

test('managed CLI survives restart and rejects corrupted/traversing version selectors', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-cloud-cli-test-'));
  try {
    for (const value of ['latest', '../../outside', '1.2.3; echo secret', '1.2.3-beta', '', null])
      assert.throws(() => validCliVersion(value));
    assert.equal(managedCli(dir), undefined);
    const binary = path.join(dir, 'cli/1.2.3/node_modules/@openai/codex/bin/codex.js');
    await fs.mkdir(path.dirname(binary), { recursive: true });
    await fs.writeFile(binary, '');
    await activateCli(dir, '1.2.3');
    assert.equal(managedCli(dir), binary);
    await fs.writeFile(
      path.join(dir, 'cli/active.json'),
      JSON.stringify({ version: '../../outside' }),
    );
    assert.equal(managedCli(dir), undefined);
    await fs.writeFile(path.join(dir, 'cli/active.json'), '{invalid');
    assert.equal(managedCli(dir), undefined);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('version lookup uses official package identity and refuses invalid registry results', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async (url) => {
      assert.equal(url, 'https://registry.npmjs.org/@openai%2fcodex/latest');
      return new Response(JSON.stringify({ name: '@openai/codex', version: '1.2.3' }));
    };
    assert.equal(await latestCliVersion(), '1.2.3');
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ name: 'other', version: '1.2.3' }));
    await assert.rejects(latestCliVersion(), /来源/);
    globalThis.fetch = async () => new Response('', { status: 503 });
    await assert.rejects(latestCliVersion(), /无法查询/);
  } finally {
    globalThis.fetch = original;
  }
});
