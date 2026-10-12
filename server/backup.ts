import { DatabaseSync, backup } from 'node:sqlite';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { acquireDataLock } from './data-lock.js';
import { contains } from './files.js';
import { providerKeyFile } from './providers.js';

async function digest(file: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

export async function backupWorkbench(dataDir: string, destination: string) {
  dataDir = path.resolve(dataDir);
  destination = path.resolve(destination);
  if (contains(dataDir, destination)) throw new Error('备份目标不能位于数据目录内');
  const release = acquireDataLock(dataDir);
  const staging = destination + '.partial-' + randomUUID();
  try {
    if (
      await fs.stat(destination).then(
        () => true,
        () => false,
      )
    )
      throw new Error('备份目标已存在，请选择新的目录');
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.mkdir(staging);
    const source = new DatabaseSync(path.join(dataDir, 'workbench.sqlite'), { readOnly: true });
    try {
      await backup(source, path.join(staging, 'workbench.sqlite'));
    } finally {
      source.close();
    }
    const snapshot = new DatabaseSync(path.join(staging, 'workbench.sqlite'), { readOnly: true });
    const files: { path: string; size: number; sha256: string }[] = [];
    let credentialFile: { path: string; size: number; sha256: string } | undefined;
    try {
      const profiles = snapshot
        .prepare("SELECT value FROM settings WHERE key='providerProfiles'")
        .get();
      if (profiles && JSON.parse(String(profiles.value)).length) {
        const sourceKey = path.join(dataDir, providerKeyFile);
        const stat = await fs.lstat(sourceKey);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size !== 32)
          throw new Error('供应商密钥文件无效，备份已停止');
        const keyTarget = path.join(staging, providerKeyFile);
        await fs.copyFile(sourceKey, keyTarget);
        const sha256 = await digest(keyTarget);
        if (sha256 !== (await digest(sourceKey))) throw new Error('供应商密钥备份校验失败');
        credentialFile = { path: providerKeyFile, size: stat.size, sha256 };
      }
      const uploadRoot = path.join(await fs.realpath(dataDir), 'uploads');
      for (const row of snapshot.prepare('SELECT id,path,size FROM attachments').all()) {
        const id = String(row.id);
        if (!/^[a-f0-9-]{36}$/i.test(id)) throw new Error('附件 ID 无效');
        const real = await fs.realpath(String(row.path));
        const expected = path.join(uploadRoot, id);
        if (!contains(expected, real) || path.relative(expected, real).includes(path.sep))
          throw new Error('附件路径超出上传目录');
        const relative = path.join('uploads', id, path.basename(real));
        const target = path.join(staging, relative);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.copyFile(real, target);
        const stat = await fs.stat(target);
        const sha256 = await digest(target);
        if (stat.size !== Number(row.size) || sha256 !== (await digest(real)))
          throw new Error('附件校验失败：' + id);
        files.push({ path: relative, size: stat.size, sha256 });
      }
    } finally {
      snapshot.close();
    }
    await fs.mkdir(path.join(staging, 'uploads'), { recursive: true });
    await fs.writeFile(
      path.join(staging, 'manifest.json'),
      JSON.stringify(
        {
          createdAt: new Date().toISOString(),
          version: '1.0.0',
          includes: ['workbench.sqlite', 'uploads', ...(credentialFile ? [providerKeyFile] : [])],
          files,
          credentialFile,
          excludes: ['Codex home', 'project files', '.env', 'TLS private key'],
          note: 'Verified offline snapshot. Restore to the original data path and revoke sessions.',
        },
        null,
        2,
      ),
    );
    await fs.rename(staging, destination);
    return { destination, attachments: files.length };
  } finally {
    try {
      await fs.rm(staging, { recursive: true, force: true });
    } finally {
      release();
    }
  }
}
