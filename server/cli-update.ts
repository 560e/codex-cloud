import fs from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { fail } from './workbench.js';
const execute = promisify(execFile);
const versionPattern = /^\d+\.\d+\.\d+$/;
export function validCliVersion(value: unknown): string {
  if (typeof value !== 'string' || !versionPattern.test(value)) throw fail('CLI 版本格式不正确');
  return value;
}
export function managedCli(dataDir: string): string | undefined {
  try {
    const version = validCliVersion(
      JSON.parse(readFileSync(path.join(dataDir, 'cli', 'active.json'), 'utf8')).version,
    );
    const binary = path.join(
      dataDir,
      'cli',
      version,
      'node_modules',
      '@openai',
      'codex',
      'bin',
      'codex.js',
    );
    return existsSync(binary) ? binary : undefined;
  } catch {
    return undefined;
  }
}
export async function latestCliVersion() {
  const response = await fetch('https://registry.npmjs.org/@openai%2fcodex/latest', {
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw fail('无法查询 Codex CLI 最新版本，请稍后重试', 502);
  const data = (await response.json()) as { version?: unknown; name?: unknown };
  if (data.name !== '@openai/codex') throw fail('CLI 版本来源不正确', 502);
  return validCliVersion(data.version);
}
function npmScript() {
  const candidates = [
    path.resolve(path.dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js'),
    path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
  ];
  try {
    candidates.push(createRequire(import.meta.url).resolve('npm/bin/npm-cli.js'));
  } catch {
    /* Standalone Node installations may lack npm. */
  }
  const script = candidates.find((file) => existsSync(file));
  if (!script) throw fail('当前 Node 环境未安装 npm，无法在线更新 CLI');
  return script;
}
export async function installCli(dataDir: string, version: string) {
  validCliVersion(version);
  const directory = path.join(dataDir, 'cli', version);
  await fs.mkdir(directory, { recursive: true });
  try {
    await execute(
      process.execPath,
      [
        npmScript(),
        'install',
        '--prefix',
        directory,
        '--no-audit',
        '--no-fund',
        '--ignore-scripts',
        '--registry=https://registry.npmjs.org',
        '@openai/codex@' + version,
      ],
      { timeout: 240000, maxBuffer: 1024 * 1024, windowsHide: true },
    );
    const binary = path.join(directory, 'node_modules/@openai/codex/bin/codex.js');
    const result = await execute(process.execPath, [binary, '--version'], {
      timeout: 20000,
      windowsHide: true,
    });
    if (!result.stdout.trim().endsWith(' ' + version)) throw fail('新 CLI 版本验证失败');
    return binary;
  } catch {
    throw fail('CLI 下载或验证失败，原版本保留。请检查服务器网络、npm 和目录写入权限。', 502);
  }
}
export async function activateCli(dataDir: string, version: string) {
  validCliVersion(version);
  const target = path.join(dataDir, 'cli', 'active.json');
  const temporary = target + '.new';
  await fs.writeFile(temporary, JSON.stringify({ version }) + '\n', { mode: 0o600 });
  await fs.rename(temporary, target);
}
