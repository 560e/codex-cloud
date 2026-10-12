import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fail } from './workbench.js';
import type { GitChanges } from '../shared/types.js';
import { parseFileLink, type ResolvedFileLink } from '../shared/file-links.js';
const exec = promisify(execFile);
export function contains(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))
  );
}
export async function projectPath(input: string, roots: string[], create: boolean) {
  if (!path.isAbsolute(input)) throw fail('请输入服务器上的绝对路径');
  if (create) {
    const target = path.resolve(input);
    let ancestor = target;
    while (true) {
      try {
        ancestor = await fs.realpath(ancestor);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        const parent = path.dirname(ancestor);
        if (parent === ancestor) throw error;
        ancestor = parent;
      }
    }
    if (
      roots.length &&
      !(await Promise.all(roots.map((r) => fs.realpath(r)))).some((r) => contains(r, ancestor))
    )
      throw fail('目录不在允许的项目根目录下', 403);
    await fs.mkdir(target, { recursive: true });
  }
  const real = await fs.realpath(input);
  if (!(await fs.stat(real)).isDirectory()) throw fail('请选择目录');
  if (
    roots.length &&
    !(await Promise.all(roots.map((r) => fs.realpath(r)))).some((r) => contains(r, real))
  )
    throw fail('目录不在允许的项目根目录下', 403);
  return real;
}
export async function safePath(root: string, relative: string) {
  if (relative.includes('\0') || path.isAbsolute(relative) || relative.includes(':'))
    throw fail('无效文件路径');
  const realRoot = await fs.realpath(root);
  const candidate = path.resolve(realRoot, relative || '.');
  if (!contains(realRoot, candidate)) throw fail('不能访问项目外的文件', 403);
  const real = await fs.realpath(candidate);
  if (!contains(realRoot, real)) throw fail('符号链接指向项目之外', 403);
  if (
    path
      .relative(realRoot, real)
      .split(path.sep)
      .some((part) => (process.platform === 'win32' ? part.toLowerCase() : part) === '.git')
  )
    throw fail('不能直接读取 Git 内部文件', 403);
  return real;
}
export async function resolveFileLink(root: string, href: string): Promise<ResolvedFileLink> {
  const link = parseFileLink(href);
  if (!link) throw fail('无效或不支持的文件链接');
  const realRoot = await fs.realpath(root);
  const relative = path.isAbsolute(link.path)
    ? path.relative(realRoot, await fs.realpath(link.path))
    : link.path;
  const file = await safePath(realRoot, relative);
  const stat = await fs.stat(file);
  if (!stat.isFile() && !stat.isDirectory()) throw fail('链接不是普通文件或目录');
  return {
    ...link,
    path: path.relative(realRoot, file).split(path.sep).join('/'),
    directory: stat.isDirectory(),
  };
}
export async function listFiles(root: string, relative: string, offset = 0) {
  const dir = await safePath(root, relative);
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const visible = entries
    .filter(
      (e) =>
        !['.git', 'node_modules'].includes(
          process.platform === 'win32' ? e.name.toLowerCase() : e.name,
        ) && !e.isSymbolicLink(),
    )
    .sort(
      (a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name),
    );
  return {
    total: visible.length,
    nextOffset: offset + 1000 < visible.length ? offset + 1000 : null,
    entries: visible.slice(offset, offset + 1000).map((e) => ({
      name: e.name,
      directory: e.isDirectory(),
      path: path.posix.join(relative.replaceAll('\\', '/'), e.name),
    })),
  };
}
export async function readText(root: string, relative: string) {
  const file = await safePath(root, relative);
  const stat = await fs.stat(file);
  if (!stat.isFile()) throw fail('不是文件');
  if (stat.size > 2 * 1024 * 1024) throw fail('文件超过 2 MB，请下载查看');
  const data = await fs.readFile(file);
  if (data.includes(0)) throw fail('二进制文件，请下载查看');
  return { content: data.toString('utf8'), size: stat.size };
}
export async function gitDiff(cwd: string): Promise<GitChanges> {
  const opts = { cwd, windowsHide: true, maxBuffer: 4 * 1024 * 1024, timeout: 15000 };
  try {
    const probe = await exec('git', ['rev-parse', '--is-inside-work-tree'], opts);
    if (probe.stdout.trim() !== 'true')
      return { kind: 'folder', message: '此目录没有 Git 工作区，将展示对话中的本地文件改动记录。' };
  } catch (error) {
    const e = error as NodeJS.ErrnoException & { stderr?: string };
    if (/not a git repository/i.test(e.stderr || ''))
      return { kind: 'folder', message: '这是普通文件夹项目，将展示对话中的本地文件改动记录。' };
    if (e.code === 'ENOENT')
      return {
        kind: 'unavailable',
        message: '无法启动 Git，请确认服务器已安装 Git 且项目目录存在。对话改动记录仍可查看。',
      };
    return {
      kind: 'unavailable',
      message: '无法检查本地 Git 仓库，请检查目录权限、仓库配置或稍后刷新。对话改动记录仍可查看。',
    };
  }
  try {
    const [unstaged, staged, status] = await Promise.all([
      exec('git', ['--no-pager', 'diff', '--no-ext-diff', '--no-textconv', '--', '.'], opts),
      exec(
        'git',
        ['--no-pager', 'diff', '--cached', '--no-ext-diff', '--no-textconv', '--', '.'],
        opts,
      ),
      exec('git', ['status', '--short', '--untracked-files=normal', '--', '.'], opts),
    ]);
    return { kind: 'git', unstaged: unstaged.stdout, staged: staged.stdout, status: status.stdout };
  } catch (e) {
    return {
      kind: 'unavailable',
      message: '本地 Git 差异读取失败，可能是仓库权限、差异过大或命令超时。对话改动记录仍可查看。',
    };
  }
}

export async function listProjectDirectories(input: string, roots: string[]) {
  const cwd = await projectPath(input, roots, false);
  const entries = await fs.readdir(cwd, { withFileTypes: true });
  const directories = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map(async (entry) => {
        const candidate = path.join(cwd, entry.name);
        try {
          await projectPath(candidate, roots, false);
          return { name: entry.name, path: candidate };
        } catch {
          return null;
        }
      }),
  );
  let parent: string | null = null;
  if (path.dirname(cwd) !== cwd) {
    try {
      parent = await projectPath(path.dirname(cwd), roots, false);
    } catch {
      /* At an allowed root. */
    }
  }
  return {
    path: cwd,
    parent,
    entries: directories
      .filter((entry) => entry !== null)
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}
