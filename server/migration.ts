import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createReadStream } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync, backup } from 'node:sqlite';
import { pipeline } from 'node:stream/promises';
import { create, extract, list } from 'tar';
import { z } from 'zod';
import { parse, stringify } from 'smol-toml';
import { Store } from './store.js';
import { Providers } from './providers.js';
import { acquireDataLock } from './data-lock.js';
import { contains } from './files.js';

const fileSchema = z.object({
  path: z.string(),
  size: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  executable: z.boolean().default(false),
});
const manifestSchema = z.object({
  // Archives created before the rename keep their original format identifier.
  format: z.union([z.literal('codex-cloud-portable'), z.literal('arran-wb-portable')]),
  version: z.literal(1),
  createdAt: z.string(),
  platform: z.string(),
  source: z.object({ dataDir: z.string(), codexHome: z.string(), skillsHome: z.string() }),
  projects: z.array(z.object({ id: z.string(), name: z.string(), path: z.string() })),
  files: z.array(fileSchema).max(100000),
});
export type MigrationManifest = z.output<typeof manifestSchema>;
const maxBytes = 8 * 1024 ** 3;
const skipped = new Set([
  'owner.sqlite',
  'server.lock',
  'logs',
  'tmp',
  '.tmp',
  'shell_snapshots',
  'node_modules',
]);
const portablePath = (name: string) => {
  if (
    !name ||
    name.includes('\\') ||
    name.startsWith('/') ||
    name
      .split('/')
      .some(
        (part) =>
          !part ||
          part === '.' ||
          part === '..' ||
          /[:\x00-\x1f<>"|?*]/.test(part) ||
          /[. ]$/.test(part) ||
          /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
      )
  )
    throw new Error('迁移包包含不安全或不兼容 Windows 的路径：' + name);
  return name;
};
async function digest(file: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
async function sqliteFile(file: string) {
  const handle = await fs.open(file, 'r');
  try {
    const header = Buffer.alloc(16);
    await handle.read(header, 0, 16, 0);
    return header.toString() === 'SQLite format 3\0';
  } finally {
    await handle.close();
  }
}
async function snapshotFile(source: string, target: string) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  if (await sqliteFile(source)) {
    const db = new DatabaseSync(source, { readOnly: true });
    try {
      await backup(db, target);
    } finally {
      db.close();
    }
    const snapshot = new DatabaseSync(target);
    try {
      snapshot.exec('PRAGMA journal_mode=DELETE');
    } finally {
      snapshot.close();
    }
  } else await fs.copyFile(source, target);
  await fs.chmod(target, (await fs.stat(source)).mode & 0o111 ? 0o700 : 0o600);
}
async function copyTree(source: string, target: string, warnings: string[], prefix = '') {
  const stat = await fs.lstat(source).catch((e: NodeJS.ErrnoException) => {
    if (e.code === 'ENOENT') return null;
    throw e;
  });
  if (!stat) {
    await fs.mkdir(target, { recursive: true });
    return;
  }
  if (stat.isSymbolicLink()) {
    warnings.push('未复制链接：' + source);
    return;
  }
  if (stat.isDirectory()) {
    await fs.mkdir(target, { recursive: true, mode: 0o700 });
    for (const entry of await fs.readdir(source)) {
      if (
        skipped.has(entry) ||
        /(?:-wal|-shm|-journal)$/.test(entry) ||
        /\.tmp-|\.backup-/.test(entry)
      )
        continue;
      await copyTree(
        path.join(source, entry),
        path.join(target, entry),
        warnings,
        prefix ? prefix + '/' + entry : entry,
      );
    }
  } else if (stat.isFile()) {
    portablePath(prefix);
    await snapshotFile(source, target);
  } else warnings.push('未复制运行时文件：' + source);
}
async function inventory(root: string, prefix = ''): Promise<z.output<typeof fileSchema>[]> {
  const files: z.output<typeof fileSchema>[] = [];
  for (const entry of await fs.readdir(path.join(root, prefix), { withFileTypes: true })) {
    const relative = prefix ? prefix + '/' + entry.name : entry.name;
    if (entry.isDirectory()) files.push(...(await inventory(root, relative)));
    else if (entry.isFile()) {
      const file = path.join(root, relative);
      files.push({
        path: portablePath(relative),
        size: (await fs.stat(file)).size,
        sha256: await digest(file),
        executable: !!((await fs.stat(file)).mode & 0o111),
      });
    } else throw new Error('迁移包不能包含链接或特殊文件');
  }
  return files;
}
export async function exportMigration(
  store: Store,
  homes: { codexHome: string; skillsHome: string },
  destination: string,
) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-cloud-export-'));
  const warnings: string[] = [];
  try {
    const dbTarget = path.join(temp, 'workbench', 'workbench.sqlite');
    await fs.mkdir(path.dirname(dbTarget), { recursive: true });
    await backup(store.db, dbTarget);
    const db = new DatabaseSync(dbTarget);
    try {
      db.exec(
        'DELETE FROM sessions; DELETE FROM runs; DELETE FROM events; PRAGMA journal_mode=DELETE;',
      );
    } finally {
      db.close();
    }
    for (const name of ['uploads', 'providers.key']) {
      const source = path.join(store.dir, name);
      if (
        await fs.lstat(source).then(
          () => true,
          () => false,
        )
      )
        await copyTree(source, path.join(temp, 'workbench', name), warnings, 'workbench/' + name);
    }
    await copyTree(homes.codexHome, path.join(temp, 'codex'), warnings, 'codex');
    await copyTree(homes.skillsHome, path.join(temp, 'agent-skills'), warnings, 'agent-skills');
    const snapshot = new DatabaseSync(dbTarget, { readOnly: true });
    try {
      for (const row of snapshot.prepare('SELECT id,path,size FROM attachments').all()) {
        const id = String(row.id);
        const source = path.resolve(String(row.path));
        if (!/^[a-f0-9-]{36}$/i.test(id) || !contains(path.join(store.dir, 'uploads', id), source))
          throw new Error('附件路径无效');
        const copied = path.join(temp, 'workbench', 'uploads', id, path.basename(source));
        if (
          (await fs.stat(copied)).size !== Number(row.size) ||
          (await digest(copied)) !== (await digest(source))
        )
          throw new Error('附件备份校验失败');
      }
      const profiles = snapshot
        .prepare("SELECT value FROM settings WHERE key='providerProfiles'")
        .get();
      if (
        profiles &&
        JSON.parse(String(profiles.value)).length &&
        (await fs.stat(path.join(temp, 'workbench', 'providers.key'))).size !== 32
      )
        throw new Error('供应商密钥文件无效');
    } finally {
      snapshot.close();
    }
    const files = await inventory(temp);
    const unique = new Set<string>();
    let size = 0;
    for (const file of files) {
      const key = file.path.toLowerCase();
      if (unique.has(key)) throw new Error('文件路径大小写冲突，无法跨平台迁移');
      unique.add(key);
      size += file.size;
    }
    if (size > maxBytes) throw new Error('迁移数据超过 8 GiB');
    const manifest: MigrationManifest = {
      format: 'codex-cloud-portable',
      version: 1,
      createdAt: new Date().toISOString(),
      platform: process.platform,
      source: {
        dataDir: path.resolve(store.dir),
        codexHome: path.resolve(homes.codexHome),
        skillsHome: path.resolve(homes.skillsHome),
      },
      projects: store
        .projects()
        .map(({ id, name, path: projectPath }) => ({ id, name, path: projectPath })),
      files,
    };
    await fs.writeFile(path.join(temp, 'manifest.json'), JSON.stringify(manifest, null, 2), {
      mode: 0o600,
    });
    await create({ gzip: true, file: destination, cwd: temp, portable: true }, [
      'manifest.json',
      'workbench',
      'codex',
      'agent-skills',
    ]);
    return { manifest, warnings };
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
}
export async function unpackMigration(archive: string, directory: string) {
  let total = 0;
  let count = 0;
  const seen = new Set<string>();
  let validationError: Error | undefined;
  await list({
    file: archive,
    strict: true,
    onReadEntry: (entry) => {
      try {
        const name = portablePath(entry.path.replace(/\/$/, ''));
        if (
          !['File', 'Directory'].includes(entry.type) ||
          !['manifest.json', 'workbench', 'codex', 'agent-skills'].includes(name.split('/')[0])
        )
          throw new Error('迁移包包含非法条目');
        const key = name.toLowerCase();
        if (seen.has(key)) throw new Error('迁移包包含重复路径');
        seen.add(key);
        total += entry.size;
        count++;
        if (total > maxBytes || count > 100000) throw new Error('迁移包超过限制');
      } catch (error) {
        validationError ||= error as Error;
      }
    },
  });
  if (validationError) throw validationError;
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await extract({
    file: archive,
    cwd: directory,
    strict: true,
    preservePaths: false,
    noChmod: true,
  });
  const manifestFile = path.join(directory, 'manifest.json');
  if ((await fs.stat(manifestFile)).size > 16 * 1024 * 1024) throw new Error('迁移清单过大');
  const manifest = manifestSchema.parse(JSON.parse(await fs.readFile(manifestFile, 'utf8')));
  const expected = new Map(manifest.files.map((file) => [portablePath(file.path), file]));
  const actual = (await inventory(directory)).filter((file) => file.path !== 'manifest.json');
  if (actual.length !== expected.size || expected.size !== manifest.files.length)
    throw new Error('迁移清单与文件不匹配');
  for (const file of actual) {
    const recorded = expected.get(file.path);
    if (!recorded || recorded.size !== file.size || recorded.sha256 !== file.sha256)
      throw new Error('迁移文件校验失败：' + file.path);
    await fs.chmod(path.join(directory, file.path), recorded.executable ? 0o700 : 0o600);
  }
  const db = new DatabaseSync(path.join(directory, 'workbench/workbench.sqlite'), {
    readOnly: true,
  });
  try {
    if (db.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok')
      throw new Error('工作台数据库损坏');
    const projects = db.prepare('SELECT id,path FROM projects').all();
    if (
      projects.length !== manifest.projects.length ||
      projects.some(
        (row) =>
          !manifest.projects.some((project) => project.id === row.id && project.path === row.path),
      )
    )
      throw new Error('项目清单与数据库不匹配');
    for (const row of db.prepare('SELECT id,path FROM attachments').all()) {
      const id = String(row.id);
      if (!/^[a-f0-9-]{36}$/i.test(id)) throw new Error('附件 ID 无效');
      const relative =
        'workbench/uploads/' +
        id +
        '/' +
        path.posix.basename(String(row.path).replaceAll('\\', '/'));
      if (!expected.has(relative)) throw new Error('附件缺失：' + id);
    }
  } finally {
    db.close();
  }
  return manifest;
}
export function remapPath(value: string, mappings: [string, string][]) {
  for (const [old, next] of [...mappings].sort((a, b) => b[0].length - a[0].length)) {
    const windows = /^[A-Za-z]:[\\/]|^\\\\/.test(old);
    const normalized = value.replaceAll('\\', '/');
    const original = old.replaceAll('\\', '/').replace(/\/$/, '');
    const a = windows ? normalized.toLowerCase() : normalized;
    const b = windows ? original.toLowerCase() : original;
    if (a === b || a.startsWith(b + '/'))
      return (/^[A-Za-z]:[\\/]|^\\\\/.test(next) ? path.win32 : path).join(
        next,
        ...normalized.slice(original.length).split('/').filter(Boolean),
      );
  }
  return value;
}
function remapValue(value: unknown, mappings: [string, string][]): unknown {
  if (typeof value === 'string') {
    // Legacy queue entries and native history contain paths inside workbench-generated
    // text parts. Rewrite only these templates, never arbitrary quoted/user prose.
    const attachment = value.match(
      /^(用户上传的文件：[\s\S]*\n服务器绝对路径：)([^\r\n]+)(\n请根据任务需要读取该文件。)$/,
    );
    if (attachment) return attachment[1] + remapPath(attachment[2], mappings) + attachment[3];
    const reference = value.match(/^(用户引用的项目文件（按需读取）：\n)([^\r\n]+)$/);
    if (reference) return reference[1] + remapPath(reference[2], mappings);
    return remapPath(value, mappings);
  }
  if (Array.isArray(value)) return value.map((item) => remapValue(item, mappings));
  if (
    value &&
    typeof value === 'object' &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  )
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        remapPath(key, mappings),
        remapValue(item, mappings),
      ]),
    );
  return value;
}
async function remapSqlite(file: string, mappings: [string, string][]) {
  const db = new DatabaseSync(file);
  const quote = (name: string) => '"' + name.replaceAll('"', '""') + '"';
  try {
    db.exec('BEGIN IMMEDIATE');
    for (const table of db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all()) {
      const name = String(table.name);
      let rows;
      try {
        rows = db.prepare(`SELECT rowid AS __migration_rowid, * FROM ${quote(name)}`).all();
      } catch {
        continue;
      }
      for (const row of rows) {
        for (const [column, value] of Object.entries(row)) {
          if (typeof value !== 'string' || column === '__migration_rowid') continue;
          let next = remapPath(value, mappings);
          if (/^[\[{]/.test(value)) {
            try {
              const mapped = remapValue(JSON.parse(value), mappings);
              if (JSON.stringify(mapped) !== JSON.stringify(JSON.parse(value)))
                next = JSON.stringify(mapped);
            } catch {
              /* Not JSON. */
            }
          }
          if (next !== value)
            db.prepare(`UPDATE ${quote(name)} SET ${quote(column)}=? WHERE rowid=?`).run(
              next,
              row.__migration_rowid,
            );
        }
      }
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  } finally {
    db.close();
  }
}
async function prepareRestore(
  directory: string,
  manifest: MigrationManifest,
  targets: {
    dataDir: string;
    codexHome: string;
    skillsHome: string;
    projects: Record<string, string>;
  },
) {
  for (const project of manifest.projects)
    if (!targets.projects[project.id] || !path.isAbsolute(targets.projects[project.id]))
      throw new Error('请为每个项目指定目标绝对路径');
  const mappings: [string, string][] = [
    [manifest.source.dataDir, targets.dataDir],
    [manifest.source.codexHome, targets.codexHome],
    [manifest.source.skillsHome, targets.skillsHome],
    ...manifest.projects.map((p): [string, string] => [p.path, targets.projects[p.id]]),
  ];
  for (const file of manifest.files) {
    const target = path.join(directory, file.path);
    if (await sqliteFile(target)) await remapSqlite(target, mappings);
    else if (file.path.endsWith('.jsonl') || file.path.endsWith('.json')) {
      const stat = await fs.stat(target);
      if (stat.size > 256 * 1024 * 1024)
        throw new Error('会话文件过大，无法安全迁移：' + file.path);
      const text = await fs.readFile(target, 'utf8');
      if (file.path.endsWith('.jsonl')) {
        const lines = text.split('\n').map((line) => {
          if (!line.trim()) return line;
          return JSON.stringify(remapValue(JSON.parse(line), mappings));
        });
        await fs.writeFile(target, lines.join('\n'), { mode: 0o600 });
      } else {
        try {
          await fs.writeFile(
            target,
            JSON.stringify(remapValue(JSON.parse(text), mappings), null, 2),
            { mode: 0o600 },
          );
        } catch (e) {
          if (!(e instanceof SyntaxError)) throw e;
        }
      }
    } else if (file.path.endsWith('.toml')) {
      const text = await fs.readFile(target, 'utf8');
      await fs.writeFile(
        target,
        stringify(remapValue(parse(text), mappings) as ReturnType<typeof parse>),
        { mode: 0o600 },
      );
    }
  }
  const db = new DatabaseSync(path.join(directory, 'workbench/workbench.sqlite'));
  try {
    db.exec(
      "DELETE FROM sessions; DELETE FROM runs; DELETE FROM events; UPDATE message_queue SET state='paused', error='迁移后请核对历史再继续';",
    );
    for (const project of manifest.projects)
      db.prepare('UPDATE projects SET path=? WHERE id=?').run(
        targets.projects[project.id],
        project.id,
      );
    for (const row of db.prepare('SELECT id,path FROM attachments').all())
      db.prepare('UPDATE attachments SET path=? WHERE id=?').run(
        path.join(
          targets.dataDir,
          'uploads',
          String(row.id),
          path.posix.basename(String(row.path).replaceAll('\\', '/')),
        ),
        row.id,
      );
  } finally {
    db.close();
  }
  const validated = new Store(path.join(directory, 'workbench'), true);
  try {
    new Providers(validated).runtime();
  } finally {
    validated.close();
  }
}
// Keep the verified upload pristine: preparation rewrites paths and may fail midway.
// A retry (possibly with different targets) must always start from the original data.
export async function withPreparedRestore<T>(
  directory: string,
  manifest: MigrationManifest,
  targets: Parameters<typeof prepareRestore>[2],
  install: (prepared: string) => Promise<T>,
) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-cloud-prepare-'));
  const prepared = path.join(temp, 'payload');
  try {
    await fs.cp(directory, prepared, { recursive: true, errorOnExist: true, force: false });
    await prepareRestore(prepared, manifest, targets);
    return await install(prepared);
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
}
export async function installRestore(
  directory: string,
  targets: { dataDir: string; codexHome: string; skillsHome: string },
) {
  const journal: { target: string; saved?: string }[] = [];
  const stamp = '.pre-import-' + randomUUID();
  const replace = async (source: string, target: string) => {
    const stat = await fs.lstat(target).catch((e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT') return null;
      throw e;
    });
    if (stat?.isSymbolicLink()) throw new Error('导入目标不能是链接');
    const saved = stat ? target + stamp : undefined;
    if (saved) await fs.rename(target, saved);
    journal.push({ target, saved });
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.cp(source, target, { recursive: true, force: false, errorOnExist: true });
  };
  try {
    await fs.mkdir(targets.dataDir, { recursive: true });
    for (const name of ['workbench.sqlite', 'uploads', 'providers.key']) {
      const source = path.join(directory, 'workbench', name);
      if (
        await fs.lstat(source).then(
          () => true,
          () => false,
        )
      )
        await replace(source, path.join(targets.dataDir, name));
      else if (name === 'uploads') {
        await fs.mkdir(source);
        await replace(source, path.join(targets.dataDir, name));
      }
    }
    // Keep the old journal files in the rollback set until every replacement succeeds.
    // They must not be replayed into the imported database, but a failed import
    // still needs them to recover the original database.
    for (const suffix of ['-wal', '-shm']) {
      const target = path.join(targets.dataDir, 'workbench.sqlite' + suffix);
      const stat = await fs.lstat(target).catch((e: NodeJS.ErrnoException) => {
        if (e.code === 'ENOENT') return null;
        throw e;
      });
      if (!stat) continue;
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('数据库日志文件无效');
      const saved = target + stamp;
      await fs.rename(target, saved);
      journal.push({ target, saved });
    }
    await replace(path.join(directory, 'codex'), targets.codexHome);
    await replace(path.join(directory, 'agent-skills'), targets.skillsHome);
    return journal.filter((entry) => entry.saved).map((entry) => entry.saved!);
  } catch (error) {
    for (const entry of journal.reverse()) {
      await fs.rm(entry.target, { recursive: true, force: true });
      if (entry.saved) await fs.rename(entry.saved, entry.target);
    }
    throw error;
  }
}
export async function restoreOffline(
  archive: string,
  targets: {
    dataDir: string;
    codexHome: string;
    skillsHome: string;
    projects: Record<string, string>;
  },
) {
  const locations = [targets.dataDir, targets.codexHome, targets.skillsHome].map((item) =>
    path.resolve(item),
  );
  if (
    locations.some((a, i) =>
      locations.some((b, j) => i !== j && (contains(a, b) || contains(b, a))),
    )
  )
    throw new Error('数据目录、Codex 目录和 Skill 目录不能相互包含');
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-cloud-import-'));
  const release = acquireDataLock(targets.dataDir);
  try {
    const manifest = await unpackMigration(archive, temp);
    const backups = await withPreparedRestore(temp, manifest, targets, (prepared) =>
      installRestore(prepared, targets),
    );
    return { manifest, backups };
  } finally {
    release();
    await fs.rm(temp, { recursive: true, force: true });
  }
}
export async function receiveArchive(stream: NodeJS.ReadableStream, destination: string) {
  await pipeline(stream, (await import('node:fs')).createWriteStream(destination, { mode: 0o600 }));
}
