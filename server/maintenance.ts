import fs from 'node:fs/promises';
import path from 'node:path';
import type { Store } from './store.js';
import { fail } from './workbench.js';
const samePath = (a: string, b: string) =>
  process.platform === 'win32'
    ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
    : path.resolve(a) === path.resolve(b);

async function ownedDirectory(store: Store, name: 'logs' | 'uploads') {
  const root = await fs.realpath(store.dir);
  const dir = path.join(root, name);
  try {
    const stat = await fs.lstat(dir);
    if (stat.isSymbolicLink() || !stat.isDirectory() || !samePath(await fs.realpath(dir), dir))
      throw fail(`拒绝清理指向其他位置的 ${name} 目录`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return dir;
}

export async function logFiles(store: Store) {
  const dir = await ownedDirectory(store, 'logs');
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch((error) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const files: { name: string; path: string; size: number }[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.log')) continue;
    const file = path.join(dir, entry.name);
    const stat = await fs.lstat(file);
    if (stat.isSymbolicLink() || stat.nlink !== 1) throw fail('日志含链接文件，已停止清理');
    files.push({ name: entry.name, path: file, size: stat.size });
  }
  return files;
}

export async function clearLogs(store: Store) {
  const files = await logFiles(store);
  let bytes = 0,
    cleared = 0;
  const failed: string[] = [];
  for (const file of files) {
    try {
      // Truncate in place so open log handles keep working, including on Windows.
      const handle = await fs.open(file.path, 'r+');
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.nlink !== 1) throw fail('日志文件类型已变化');
        await handle.truncate(0);
        bytes += stat.size;
        cleared++;
      } finally {
        await handle.close();
      }
    } catch {
      failed.push(file.name);
    }
  }
  return { cleared, bytes, failed };
}

export async function attachmentDirectories(store: Store, id: string) {
  const root = await ownedDirectory(store, 'uploads');
  const rows = store.db.prepare('SELECT id,path FROM attachments WHERE thread_id=?').all(id);
  const directories: string[] = [];
  for (const row of rows) {
    if (!/^[a-f0-9-]{36}$/i.test(String(row.id))) throw fail('附件路径校验失败，未删除会话');
    const dir = path.join(root, String(row.id));
    const parent = path.dirname(path.resolve(String(row.path)));
    if (
      !samePath(parent, dir) &&
      !samePath(parent, path.join(store.dir, 'uploads', String(row.id)))
    )
      throw fail('附件记录超出上传目录，未删除会话');
    try {
      const stat = await fs.lstat(dir);
      if (stat.isSymbolicLink() || !stat.isDirectory() || !samePath(await fs.realpath(dir), dir))
        throw fail('附件目录指向其他位置，已停止删除');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    directories.push(dir);
  }
  return directories;
}

export async function removeAttachments(store: Store, id: string) {
  // Resolve and validate every target before any recursive operation.
  const directories = await attachmentDirectories(store, id);
  for (const dir of directories) await fs.rm(dir, { recursive: true, force: true });
  return directories.length;
}
