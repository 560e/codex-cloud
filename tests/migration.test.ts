import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { create } from 'tar';
import { Store } from '../server/store.js';
import {
  exportMigration,
  unpackMigration,
  restoreOffline,
  remapPath,
  installRestore,
  withPreparedRestore,
} from '../server/migration.js';

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-cloud-portable-'));
  const dataDir = path.join(root, 'data');
  const codexHome = path.join(root, 'codex');
  const skillsHome = path.join(root, 'skills');
  await fs.mkdir(codexHome);
  await fs.mkdir(skillsHome);
  const store = new Store(dataDir);
  const project = store.addProject('Windows project', 'C:\\Projects\\demo', {
    contextWindow1M: true,
    autoCompactPercent: 70,
  });
  store.set('projectPrompt:' + project.id, '使用中文并运行检查');
  store.set('passwordHash', 'keep-password-hash');
  store.db.prepare('INSERT INTO sessions VALUES(?,?)').run('stale-login', Date.now() + 100000);
  const id = randomUUID();
  const file = path.join(dataDir, 'uploads', id, 'note.txt');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, 'attachment');
  store.db
    .prepare(
      'INSERT INTO attachments(id,thread_id,name,mime,size,path,state) VALUES(?,?,?,?,?,?,?)',
    )
    .run(id, 'thread', 'note.txt', 'text/plain', 10, file, 'used');
  const input = [
    {
      type: 'text',
      text: `用户上传的文件：note.txt\n服务器绝对路径：${file}\n请根据任务需要读取该文件。`,
    },
    { type: 'text', text: `用户引用的项目文件（按需读取）：\n${project.path}\\main.ts` },
    { type: 'localImage', path: file },
    { type: 'text', text: `请解释旧路径 ${file}，不要改写这段文字` },
  ];
  store.enqueue('thread', project.path, input, {}, '附件消息');
  await fs.mkdir(path.join(codexHome, 'sessions'), { recursive: true });
  await fs.writeFile(
    path.join(codexHome, 'sessions', 'session.jsonl'),
    JSON.stringify({ type: 'session_meta', payload: { cwd: project.path, id: 'thread' } }) +
      '\n' +
      JSON.stringify({
        type: 'turn_context',
        payload: { cwd: project.path, input: [{ path: file }, ...input] },
      }) +
      '\n',
  );
  await fs.writeFile(
    path.join(codexHome, 'auth.json'),
    JSON.stringify({ api_key: 'test-only-secret' }),
  );
  await fs.writeFile(
    path.join(codexHome, 'config.toml'),
    '[projects."C:\\\\Projects\\\\demo"]\ntrust_level = "trusted"\n[mcp_servers.demo]\ncommand = "node"\n',
  );
  await fs.writeFile(path.join(skillsHome, 'SKILL.md'), 'user skill');
  const state = new DatabaseSync(path.join(codexHome, 'state_5.sqlite'));
  state.exec('CREATE TABLE threads(id TEXT PRIMARY KEY,cwd TEXT,rollout_path TEXT)');
  state
    .prepare('INSERT INTO threads VALUES(?,?,?)')
    .run('thread', project.path, path.join(codexHome, 'sessions/session.jsonl'));
  state.close();
  const archive = path.join(root, 'migration.tar.gz');
  await exportMigration(store, { codexHome, skillsHome }, archive);
  return { root, store, project, archive };
}

test('portable migration retains workbench and Codex data, rebases Windows paths, and revokes sessions', async () => {
  const f = await fixture();
  try {
    const targets = {
      dataDir: path.join(f.root, 'new-data'),
      codexHome: path.join(f.root, 'new-codex'),
      skillsHome: path.join(f.root, 'new-skills'),
      projects: { [f.project.id]: path.join(f.root, 'new-project') },
    };
    const result = await restoreOffline(f.archive, targets);
    assert.equal(result.manifest.format, 'codex-cloud-portable');
    const restored = new Store(targets.dataDir);
    try {
      assert.equal(restored.projects()[0].path, targets.projects[f.project.id]);
      assert.equal(restored.projects()[0].systemPrompt, '使用中文并运行检查');
      assert.equal(restored.projects()[0].contextWindow1M, true);
      assert.equal(restored.projects()[0].autoCompactPercent, 70);
      assert.equal(restored.get('passwordHash'), 'keep-password-hash');
      assert.equal(restored.db.prepare('SELECT count(*) AS n FROM sessions').get()!.n, 0);
      const file = String(restored.db.prepare('SELECT path FROM attachments').get()!.path);
      assert.ok(file.startsWith(targets.dataDir));
      assert.equal(await fs.readFile(file, 'utf8'), 'attachment');
      const queued = restored.queueRows()[0];
      assert.equal(queued.state, 'paused');
      assert.equal(
        queued.input[0].text,
        `用户上传的文件：note.txt\n服务器绝对路径：${file}\n请根据任务需要读取该文件。`,
      );
      assert.equal(
        queued.input[1].text,
        `用户引用的项目文件（按需读取）：\n${path.join(targets.projects[f.project.id], 'main.ts')}`,
      );
      assert.equal(queued.input[2].path, file);
      assert.equal(queued.input[3].text, f.store.queueRows()[0].input[3].text);
    } finally {
      restored.close();
    }
    const state = new DatabaseSync(path.join(targets.codexHome, 'state_5.sqlite'), {
      readOnly: true,
    });
    try {
      const row = state.prepare('SELECT * FROM threads').get()!;
      assert.equal(row.cwd, targets.projects[f.project.id]);
      assert.equal(row.rollout_path, path.join(targets.codexHome, 'sessions/session.jsonl'));
    } finally {
      state.close();
    }
    const lines = (
      await fs.readFile(path.join(targets.codexHome, 'sessions/session.jsonl'), 'utf8')
    )
      .trim()
      .split('\n')
      .map(JSON.parse);
    assert.equal(lines[0].payload.cwd, targets.projects[f.project.id]);
    assert.ok(lines[1].payload.input[0].path.startsWith(targets.dataDir));
    assert.ok(lines[1].payload.input[1].text.includes(targets.dataDir));
    assert.ok(lines[1].payload.input[2].text.includes(targets.projects[f.project.id]));
    assert.equal(lines[1].payload.input[4].text, f.store.queueRows()[0].input[3].text);
    assert.match(
      await fs.readFile(path.join(targets.codexHome, 'config.toml'), 'utf8'),
      /new-project/,
    );
    assert.match(
      await fs.readFile(path.join(targets.codexHome, 'auth.json'), 'utf8'),
      /test-only-secret/,
    );
    assert.equal(
      await fs.readFile(path.join(targets.skillsHome, 'SKILL.md'), 'utf8'),
      'user skill',
    );
    const old = await fs.readFile(path.join(targets.codexHome, 'auth.json'), 'utf8');
    await fs.writeFile(path.join(targets.codexHome, 'auth.json'), 'old target');
    const second = await restoreOffline(f.archive, targets);
    assert.ok(second.backups.length >= 3);
    assert.ok(second.backups.some((p) => p.startsWith(targets.codexHome)));
    assert.equal(await fs.readFile(path.join(targets.codexHome, 'auth.json'), 'utf8'), old);
  } finally {
    f.store.close();
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test('failed installation can retry the same upload with new targets without stale native paths', async () => {
  const f = await fixture();
  try {
    const directory = path.join(f.root, 'verified-upload');
    const manifest = await unpackMigration(f.archive, directory);
    const targets = {
      dataDir: path.join(f.root, 'retry-data'),
      codexHome: path.join(f.root, 'blocked', 'codex'),
      skillsHome: path.join(f.root, 'retry-skills'),
      projects: { [f.project.id]: path.join(f.root, 'project-a') },
    };
    // A non-directory parent fails installation after the database was replaced.
    await fs.writeFile(path.join(f.root, 'blocked'), 'keep');
    let staging = '';
    await assert.rejects(
      withPreparedRestore(directory, manifest, targets, (prepared) => {
        staging = prepared;
        return installRestore(prepared, targets);
      }),
    );
    await assert.rejects(fs.stat(staging), { code: 'ENOENT' });
    await fs.unlink(path.join(f.root, 'blocked'));
    targets.projects[f.project.id] = path.join(f.root, 'project-b');
    await withPreparedRestore(directory, manifest, targets, (prepared) =>
      installRestore(prepared, targets),
    );
    const restored = new Store(targets.dataDir);
    const native = new DatabaseSync(path.join(targets.codexHome, 'state_5.sqlite'));
    const original = new DatabaseSync(path.join(directory, 'codex', 'state_5.sqlite'));
    try {
      assert.equal(restored.projects()[0].path, targets.projects[f.project.id]);
      assert.equal(restored.queueRows()[0].cwd, targets.projects[f.project.id]);
      assert.equal(
        native.prepare('SELECT cwd FROM threads').get()!.cwd,
        targets.projects[f.project.id],
      );
      assert.equal(original.prepare('SELECT cwd FROM threads').get()!.cwd, f.project.path);
      const lines = (
        await fs.readFile(path.join(targets.codexHome, 'sessions/session.jsonl'), 'utf8')
      )
        .trim()
        .split('\n')
        .map(JSON.parse);
      assert.equal(lines[0].payload.cwd, targets.projects[f.project.id]);
      assert.match(
        await fs.readFile(path.join(targets.codexHome, 'config.toml'), 'utf8'),
        /project-b/,
      );
    } finally {
      restored.close();
      native.close();
      original.close();
    }
  } finally {
    f.store.close();
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test('tampered and linked migration archives are rejected before target data changes', async () => {
  const f = await fixture();
  try {
    const extracted = path.join(f.root, 'unpacked');
    await unpackMigration(f.archive, extracted);
    await fs.writeFile(path.join(extracted, 'codex/auth.json'), 'tampered');
    const bad = path.join(f.root, 'tampered.tar.gz');
    await create({ gzip: true, file: bad, cwd: extracted }, [
      'manifest.json',
      'workbench',
      'codex',
      'agent-skills',
    ]);
    const target = path.join(f.root, 'target');
    await fs.mkdir(target);
    await fs.writeFile(path.join(target, 'keep.txt'), 'keep');
    await assert.rejects(
      restoreOffline(bad, {
        dataDir: target,
        codexHome: path.join(f.root, 'target-codex'),
        skillsHome: path.join(f.root, 'target-skills'),
        projects: { [f.project.id]: path.join(f.root, 'target-project') },
      }),
      /校验失败|文件不匹配/,
    );
    assert.equal(await fs.readFile(path.join(target, 'keep.txt'), 'utf8'), 'keep');
    const linked = path.join(f.root, 'linked');
    await fs.mkdir(linked);
    await fs.symlink('/etc/passwd', path.join(linked, 'codex'));
    const linkArchive = path.join(f.root, 'linked.tar.gz');
    await create({ gzip: true, file: linkArchive, cwd: linked }, ['codex']);
    await assert.rejects(unpackMigration(linkArchive, path.join(f.root, 'link-out')), /非法条目/);
  } finally {
    f.store.close();
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test('archives from before the rename remain importable', async () => {
  const f = await fixture();
  try {
    const extracted = path.join(f.root, 'previous-format');
    await unpackMigration(f.archive, extracted);
    const manifestFile = path.join(extracted, 'manifest.json');
    const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
    manifest.format = 'arran-wb-portable';
    await fs.writeFile(manifestFile, JSON.stringify(manifest));
    const archive = path.join(f.root, 'previous-format.tar.gz');
    await create({ gzip: true, file: archive, cwd: extracted }, [
      'manifest.json',
      'workbench',
      'codex',
      'agent-skills',
    ]);
    const old = await unpackMigration(archive, path.join(f.root, 'previous-import'));
    assert.equal(old.format, 'arran-wb-portable');
  } finally {
    f.store.close();
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test('failed install restores the original database and its journal files', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-cloud-import-rollback-'));
  try {
    const source = path.join(root, 'source');
    const dataDir = path.join(root, 'target-data');
    const codexHome = path.join(root, 'target-codex');
    await fs.mkdir(path.join(source, 'workbench'), { recursive: true });
    await fs.mkdir(path.join(source, 'codex'));
    await fs.mkdir(path.join(source, 'agent-skills'));
    await fs.mkdir(dataDir);
    await fs.writeFile(path.join(source, 'workbench', 'workbench.sqlite'), 'new database');
    await fs.writeFile(path.join(dataDir, 'workbench.sqlite'), 'old database');
    await fs.writeFile(path.join(dataDir, 'workbench.sqlite-wal'), 'old wal');
    await fs.writeFile(path.join(dataDir, 'workbench.sqlite-shm'), 'old shm');
    await fs.mkdir(codexHome);
    await fs.writeFile(path.join(codexHome, 'keep'), 'old codex');
    await fs.rm(path.join(source, 'codex'), { recursive: true });
    await assert.rejects(
      installRestore(source, { dataDir, codexHome, skillsHome: path.join(root, 'target-skills') }),
    );
    for (const [name, expected] of [
      ['workbench.sqlite', 'old database'],
      ['workbench.sqlite-wal', 'old wal'],
      ['workbench.sqlite-shm', 'old shm'],
    ])
      assert.equal(await fs.readFile(path.join(dataDir, name), 'utf8'), expected);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('path remapping distinguishes prefixes and handles Linux, Windows and macOS destinations', () => {
  assert.equal(
    remapPath('C:\\Projects\\demo\\file.ts', [['C:\\Projects\\demo', '/Users/me/demo']]),
    '/Users/me/demo/file.ts',
  );
  assert.equal(
    remapPath('C:\\Projects\\demo-other\\file.ts', [['C:\\Projects\\demo', '/srv/demo']]),
    'C:\\Projects\\demo-other\\file.ts',
  );
  assert.equal(
    remapPath('/Users/me/.codex/sessions/a.jsonl', [['/Users/me/.codex', 'D:\\Codex']]),
    'D:\\Codex\\sessions\\a.jsonl',
  );
  assert.equal(
    remapPath('/srv/demo/file.ts', [['/srv/demo', '/Users/me/demo']]),
    '/Users/me/demo/file.ts',
  );
});
