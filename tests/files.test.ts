import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { gitDiff } from '../server/files.js';
const exec = promisify(execFile);

test('ordinary folders return a supported change source instead of a Git error', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-cloud-folder-'));
  try {
    await fs.writeFile(path.join(dir, 'local.txt'), 'local file');
    const result = await gitDiff(dir);
    assert.equal(result.kind, 'folder');
    assert.equal(
      await fs.stat(path.join(dir, '.git')).then(
        () => true,
        () => false,
      ),
      false,
    );
    assert.ok(!('status' in result), 'absence of Git must not be reported as a clean repository');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('local Git diff works without a remote and separates staged and unstaged changes', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-cloud-local-git-'));
  const git = (...args: string[]) => exec('git', args, { cwd: dir, windowsHide: true });
  try {
    await git('init');
    await fs.writeFile(path.join(dir, 'tracked.txt'), 'original\n');
    await git('add', '--', 'tracked.txt');
    await git(
      '-c',
      'user.name=Workbench Test',
      '-c',
      'user.email=test@example.invalid',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-m',
      'test baseline',
    );
    assert.equal((await git('remote')).stdout.trim(), '');
    const clean = await gitDiff(dir);
    assert.equal(clean.kind, 'git');
    if (clean.kind !== 'git') throw new Error('Expected local Git repository');
    assert.equal(clean.status, '');
    await fs.writeFile(path.join(dir, 'tracked.txt'), 'staged version\n');
    await git('add', '--', 'tracked.txt');
    await fs.writeFile(path.join(dir, 'tracked.txt'), 'working version\n');
    await fs.writeFile(path.join(dir, 'untracked.txt'), 'new file\n');
    const result = await gitDiff(dir);
    assert.equal(result.kind, 'git');
    if (result.kind !== 'git') throw new Error('Expected local Git repository');
    assert.match(result.staged, /\+staged version/);
    assert.match(result.unstaged, /\+working version/);
    assert.match(result.status, /\?\? untracked.txt/);
    assert.equal((await git('remote')).stdout.trim(), '');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('broken repositories remain distinguishable from ordinary folders', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-cloud-broken-git-'));
  try {
    await fs.writeFile(path.join(dir, '.git'), 'invalid gitfile');
    const result = await gitDiff(dir);
    assert.equal(result.kind, 'unavailable');
    assert.ok('message' in result && result.message.includes('对话改动记录仍可查看'));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('project directories browse multiple levels and create missing parent directories', async () => {
  const { projectPath, listProjectDirectories } = await import('../server/files.js');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-cloud-directories-'));
  try {
    const target = path.join(dir, 'one', 'two', 'project');
    assert.equal(await projectPath(target, [dir], true), await fs.realpath(target));
    const listing = await listProjectDirectories(dir, [dir]);
    assert.equal(listing.parent, null);
    assert.deepEqual(
      listing.entries.map((entry) => entry.name),
      ['one'],
    );
    const nested = await listProjectDirectories(path.join(dir, 'one'), [dir]);
    assert.equal(nested.parent, await fs.realpath(dir));
    assert.equal(nested.entries[0].name, 'two');
    assert.equal(await projectPath(target, [], false), await fs.realpath(target));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('recursive project creation checks real ancestors before creating outside configured roots', async () => {
  const { projectPath, listProjectDirectories } = await import('../server/files.js');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-cloud-root-boundary-'));
  try {
    const root = path.join(dir, 'allowed');
    const outside = path.join(dir, 'outside');
    await fs.mkdir(root);
    await fs.mkdir(outside);
    await fs.symlink(
      outside,
      path.join(root, 'escape'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await assert.rejects(
      projectPath(path.join(root, 'escape', 'new', 'nested'), [root], true),
      /允许的项目根目录/,
    );
    await assert.rejects(fs.stat(path.join(outside, 'new')), { code: 'ENOENT' });
    assert.deepEqual((await listProjectDirectories(root, [root])).entries, []);
    await assert.rejects(
      projectPath(path.join(root, '..', 'outside', 'new'), [root], true),
      /允许的项目根目录/,
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
