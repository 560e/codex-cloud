import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { X509Certificate, createPrivateKey } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import {
  detectSystem,
  supportedNode,
  mirrors,
  CODEX_VERSION,
  ACME_VERSION,
  validDomain,
  safePath,
  nginxPath,
  nginxIncludesSite,
  nginxConfig,
  renderEnv,
  mirrorLock,
  systemdUnit,
} from './core.mjs';
import { issueCertificate } from './acme.mjs';

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const flags = new Map(
  args.map((arg) => {
    const i = arg.indexOf('=');
    return i < 0 ? [arg, true] : [arg.slice(0, i), arg.slice(i + 1)];
  }),
);
const allowed = new Set([
  '--check',
  '--dry-run',
  '--help',
  '--network',
  '--registry',
  '--prefix',
  '--data',
  '--port',
  '--mode',
  '--domain',
  '--email',
  '--cert',
  '--key',
  '--nginx-site-dir',
  '--no-service',
  '--noninteractive',
  '--update-config',
  '--stop-existing',
  '--acme-staging',
  '--replace-site',
  '--accept-acme-terms',
]);
for (const key of flags.keys())
  if (!allowed.has(key)) throw new Error(`未知参数：${key}；查看 --help`);
const dry = flags.has('--check') || flags.has('--dry-run');
const sys = detectSystem();
const interactive = process.stdin.isTTY && !flags.has('--noninteractive');
let logFile,
  stateFile,
  state = {},
  npm,
  prefix,
  data,
  registry;
const log = (message) => {
  console.log(message);
  if (logFile) fs.appendFileSync(logFile, new Date().toISOString() + ' ' + message + '\n');
};
const stage = (name) => {
  log('\n▶ ' + name);
  state = { ...state, stage: name, updatedAt: new Date().toISOString(), error: null };
  if (stateFile) fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), { mode: 0o600 });
};
async function ask(prompt, fallback = '') {
  if (!interactive) {
    if (fallback !== '') return fallback;
    throw new Error(`非交互运行需要提供：${prompt}`);
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(`${prompt}${fallback ? ` [${fallback}]` : ''}：`)).trim() || fallback;
  } finally {
    rl.close();
  }
}
async function yes(prompt, fallback = false) {
  return /^(y|yes|是|1)$/i.test(await ask(prompt + '（y/n）', fallback ? 'y' : 'n'));
}
function command(name) {
  const result = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', [name], {
    encoding: 'utf8',
    windowsHide: true,
  });
  return result.status === 0 ? result.stdout.trim().split(/\r?\n/)[0] : null;
}
async function run(program, argv, options = {}) {
  log('执行：' + [program, ...argv].join(' '));
  const { env: extraEnv, ...spawnOptions } = options;
  const child = spawn(program, argv, {
    cwd: prefix || source,
    env: { ...process.env, ...(registry ? { npm_config_registry: registry } : {}), ...options.env },
    stdio: 'inherit',
    windowsHide: true,
    ...spawnOptions,
  });
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`${path.basename(program)} 执行失败（${code}），请检查上方输出`)),
    );
  });
}
async function admin(program, argv, options = {}) {
  if (process.platform !== 'win32' && process.getuid?.() !== 0)
    return run('sudo', [program, ...argv], options);
  return run(program, argv, options);
}
async function npmRun(argv, options = {}) {
  if (process.platform === 'win32') {
    // Invoke npm's JS entry directly; .cmd spawning otherwise requires a shell.
    const cli = path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
    if (fs.existsSync(cli)) return run(process.execPath, [cli, ...argv], options);
    const other = path.join(path.dirname(npm), 'node_modules/npm/bin/npm-cli.js');
    if (!fs.existsSync(other)) throw new Error('无法定位 npm-cli.js，请修复 Node/npm 安装');
    return run(process.execPath, [other, ...argv], options);
  }
  return run(npm, argv, options);
}
async function copySource() {
  if (source === prefix) return;
  if (source.startsWith(prefix + path.sep)) throw new Error('安装目录不能是源码目录的父目录');
  const excluded = new Set([
    'node_modules',
    'dist',
    '.git',
    '.env',
    'data',
    '.test-data',
    'test-results',
    'playwright-report',
    'artifacts',
    'backups',
    'baota',
    'deploy-backups',
    '.tools',
    '.installer',
  ]);
  const copy = async (from, to) => {
    if (from === prefix || from.startsWith(prefix + path.sep)) return;
    const stat = await fsp.lstat(from);
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      await fsp.mkdir(to, { recursive: true });
      for (const name of await fsp.readdir(from)) {
        if (from === source && excluded.has(name)) continue;
        await copy(path.join(from, name), path.join(to, name));
      }
    } else if (stat.isFile() && !from.endsWith('.log')) await fsp.copyFile(from, to);
  };
  await copy(source, prefix);
}
async function installPackages(packages) {
  if (sys.platform === 'linux') {
    if (command('apt-get')) {
      await admin('apt-get', ['update']);
      await admin('apt-get', ['install', '-y', ...packages]);
    } else if (command('dnf')) await admin('dnf', ['install', '-y', ...packages]);
    else if (command('yum')) await admin('yum', ['install', '-y', ...packages]);
    else if (command('zypper'))
      await admin('zypper', ['--non-interactive', 'install', ...packages]);
    else if (command('pacman'))
      await admin('pacman', ['-S', '--needed', '--noconfirm', ...packages]);
    else throw new Error('无法识别包管理器，请手动安装：' + packages.join(', '));
  } else if (sys.platform === 'darwin') {
    let brew =
      command('brew') || ['/opt/homebrew/bin/brew', '/usr/local/bin/brew'].find(fs.existsSync);
    if (!brew) {
      if (!(await yes('未安装 Homebrew，是否下载并运行官方安装脚本', true)))
        throw new Error('请安装 Homebrew 或手动安装 Nginx 后重试');
      const file = path.join(prefix, '.installer', 'homebrew-install.sh');
      await download('https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh', file);
      await run('/bin/bash', [file]);
      brew = ['/opt/homebrew/bin/brew', '/usr/local/bin/brew'].find(fs.existsSync);
      if (!brew) throw new Error('Homebrew 安装后未找到，请检查安装输出');
      process.env.PATH = path.dirname(brew) + path.delimiter + process.env.PATH;
    }
    await run(brew, ['install', ...packages]);
  } else throw new Error('此平台不支持系统包管理安装');
}
async function download(url, file) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password)
    throw new Error('下载地址必须是无内嵌凭据的 HTTPS 地址');
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
      if (!response.ok) throw new Error('下载失败 HTTP ' + response.status);
      await fsp.writeFile(file, Buffer.from(await response.arrayBuffer()));
      return;
    } catch (error) {
      if (attempt === 2) throw error;
    }
  }
}
async function systemMirror(network) {
  if (network !== 'cn' || sys.platform !== 'linux') return;
  if (!['ubuntu', 'debian'].includes(sys.distro)) {
    log('系统软件包复用已有发行版源；Node/npm 使用国内镜像。需要更换 RPM 软件源时参见安装文档。');
    return;
  }
  if (!(await yes('是否将 apt 的官方源切换为华为云镜像（先备份，不修改第三方源）'))) return;
  const candidates = [
    '/etc/apt/sources.list',
    ...fs
      .readdirSync('/etc/apt/sources.list.d')
      .filter((name) => /\.(list|sources)$/.test(name))
      .map((name) => '/etc/apt/sources.list.d/' + name),
  ];
  for (const file of candidates.filter(fs.existsSync)) {
    const original = fs.readFileSync(file, 'utf8');
    const updated = original
      .replace(
        /https?:\/\/(?:[\w.-]+\.)?archive\.ubuntu\.com\/ubuntu\/?/g,
        'https://repo.huaweicloud.com/ubuntu/',
      )
      .replace(
        /https?:\/\/security\.ubuntu\.com\/ubuntu\/?/g,
        'https://repo.huaweicloud.com/ubuntu/',
      )
      .replace(
        /https?:\/\/ports\.ubuntu\.com\/ubuntu-ports\/?/g,
        'https://repo.huaweicloud.com/ubuntu-ports/',
      )
      .replace(
        /https?:\/\/deb\.debian\.org\/debian(?=\/|\s|$)/g,
        'https://repo.huaweicloud.com/debian',
      )
      .replace(
        /https?:\/\/security\.debian\.org\/debian-security\/?/g,
        'https://repo.huaweicloud.com/debian-security/',
      );
    if (updated === original) continue;
    const temp = path.join(prefix, '.installer', path.basename(file) + '.mirror');
    fs.writeFileSync(temp, updated);
    await admin('cp', [file, file + '.codex-cloud-backup-' + Date.now()]);
    await admin('cp', [temp, file]);
  }
}
function parseEnv(file) {
  if (!fs.existsSync(file)) return {};
  return Object.fromEntries(
    fs
      .readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .flatMap((line) => {
        const match = /^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/.exec(line);
        if (!match) return [];
        let value = match[2];
        if (/^".*"$/.test(value)) {
          try {
            value = JSON.parse(value);
          } catch {
            value = value.slice(1, -1);
          }
        } else if (/^'.*'$/.test(value)) value = value.slice(1, -1);
        else value = value.replace(/\s+#.*$/, '');
        return [[match[1], value]];
      }),
  );
}
function hasPassword(key) {
  const dbPath = path.join(data, 'workbench.sqlite');
  if (!fs.existsSync(dbPath)) return false;
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return !!db.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value;
  } finally {
    db.close();
  }
}
async function assertIdle() {
  const dbPath = path.join(data, 'workbench.sqlite');
  if (!fs.existsSync(dbPath)) return;
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const exists = (name) =>
      db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
    if (exists('runs') && db.prepare('SELECT COUNT(*) n FROM runs').get().n)
      throw new Error('现有项目还有执行中的任务，请等待任务完成后重试安装/更新');
    if (
      exists('message_queue') &&
      db.prepare("SELECT COUNT(*) n FROM message_queue WHERE state IN ('queued','sending')").get().n
    )
      throw new Error('现有项目有待执行消息，请先完成队列');
  } finally {
    db.close();
  }
}
async function installTool(name, version) {
  const tool = path.join(prefix, '.tools', name === '@openai/codex' ? 'codex' : 'acme');
  await fsp.mkdir(tool, { recursive: true });
  if (!fs.existsSync(path.join(tool, 'package.json')))
    fs.writeFileSync(path.join(tool, 'package.json'), JSON.stringify({ private: true }));
  await npmRun([
    'install',
    '--prefix',
    tool,
    '--save-exact',
    `${name}@${version}`,
    '--registry',
    registry,
    '--no-audit',
    '--no-fund',
  ]);
  const packageRoot = path.join(tool, 'node_modules', ...name.split('/'));
  if (name === '@openai/codex') return path.join(packageRoot, 'bin/codex.js');
  const metadata = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
  return path.join(packageRoot, metadata.main || 'index.js');
}
async function checkPort(port) {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', (error) => reject(new Error(`本机端口 ${port} 不可用：${error.message}`)));
    server.listen(port, '127.0.0.1', resolve);
  });
  await new Promise((resolve) => server.close(resolve));
}
async function findNginx() {
  let binary =
    command('nginx') ||
    [
      '/www/server/nginx/sbin/nginx',
      '/usr/sbin/nginx',
      '/opt/homebrew/bin/nginx',
      '/usr/local/bin/nginx',
      path.join(prefix, '.tools/nginx/nginx.exe'),
    ].find(fs.existsSync);
  if (!binary) {
    log('未找到 Nginx，准备安装。');
    if (sys.platform === 'win32') {
      const file = path.join(prefix, '.installer/nginx.zip');
      await download('https://nginx.org/download/nginx-1.28.0.zip', file);
      const dest = path.join(prefix, '.tools');
      await run('powershell.exe', [
        '-NoProfile',
        '-File',
        path.join(prefix, 'scripts/install/windows-tasks.ps1'),
        '-Action',
        'Extract',
        '-Archive',
        file,
        '-Destination',
        dest,
      ]);
      const extracted = path.join(dest, 'nginx-1.28.0');
      fs.renameSync(extracted, path.join(dest, 'nginx'));
      binary = path.join(dest, 'nginx/nginx.exe');
    } else {
      await installPackages(['nginx']);
      binary = command('nginx') || '/usr/sbin/nginx';
    }
  }
  binary = fs.realpathSync(binary);
  const version = spawnSync(binary, ['-V'], { encoding: 'utf8', windowsHide: true });
  if (version.error || version.status !== 0)
    throw new Error('Nginx 无法运行，请检查依赖或手动安装');
  const detail = version.stderr + version.stdout;
  const home =
    /--prefix=(\S+)/.exec(detail)?.[1]?.replace(/^['"]|['"]$/g, '') || path.dirname(binary);
  const confValue =
    /--conf-path=(\S+)/.exec(detail)?.[1]?.replace(/^['"]|['"]$/g, '') ||
    path.join(home, 'conf/nginx.conf');
  const conf = path.isAbsolute(confValue) ? confValue : path.resolve(home, confValue);
  if (!fs.existsSync(conf))
    throw new Error('无法找到 Nginx 主配置，请检查 nginx -V 的 --conf-path');
  log('复用 Nginx：' + binary + '\n主配置：' + conf);
  const siteDir =
    flags.get('--nginx-site-dir') ||
    (binary.startsWith('/www/server/')
      ? '/www/server/panel/vhost/nginx'
      : sys.platform === 'linux'
        ? '/etc/nginx/conf.d'
        : path.join(path.dirname(conf), 'conf.d'));
  return { binary, home, conf, siteDir: safePath(siteDir) };
}
async function writePrivileged(dest, text) {
  const temp = path.join(prefix, '.installer', 'config-' + Date.now() + '.tmp');
  fs.writeFileSync(temp, text, { mode: 0o600 });
  if (sys.platform === 'win32') {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(temp, dest);
  } else {
    await admin('mkdir', ['-p', path.dirname(dest)]);
    await admin('install', ['-m', '0644', temp, dest]);
  }
}
async function activateNginx(nginx, text, { start = false } = {}) {
  const site = path.join(nginx.siteDir, 'codex-cloud.conf');
  const before = fs.existsSync(site) ? fs.readFileSync(site, 'utf8') : null;
  const mainBefore = fs.readFileSync(nginx.conf, 'utf8');
  const included = nginxIncludesSite(mainBefore, nginx.siteDir, nginx.conf);
  try {
    if (before !== null) {
      if (sys.platform === 'win32') fs.copyFileSync(site, site + '.backup');
      else await admin('cp', [site, site + '.codex-cloud-backup-' + Date.now()]);
    }
    if (!included) {
      if (!/^\s*http\s*\{/m.test(mainBefore))
        throw new Error('Nginx 主配置没有可识别的 http 块，请使用生成的模板手动配置');
      const main = mainBefore.replace(
        /^(\s*http\s*\{)/m,
        `$1\n    include ${nginxPath(nginx.siteDir + '/*.conf')};`,
      );
      if (sys.platform !== 'win32')
        await admin('cp', [nginx.conf, nginx.conf + '.codex-cloud-backup-' + Date.now()]);
      else fs.copyFileSync(nginx.conf, nginx.conf + '.backup');
      await writePrivileged(nginx.conf, main);
    }
    await writePrivileged(site, text);
    await admin(nginx.binary, ['-t', '-c', nginx.conf, '-p', nginx.home]);
    if (start) {
      if (
        sys.platform === 'linux' &&
        command('systemctl') &&
        !nginx.binary.startsWith('/www/server/')
      )
        await admin('systemctl', ['enable', '--now', 'nginx']);
      else {
        try {
          await admin(nginx.binary, ['-s', 'reload', '-c', nginx.conf, '-p', nginx.home]);
        } catch {
          await admin(nginx.binary, ['-c', nginx.conf, '-p', nginx.home]);
        }
      }
    }
    await admin(nginx.binary, ['-s', 'reload', '-c', nginx.conf, '-p', nginx.home]);
  } catch (error) {
    if (before === null) {
      if (sys.platform === 'win32') fs.rmSync(site, { force: true });
      else await admin('rm', ['-f', site]);
    } else await writePrivileged(site, before);
    if (!included) await writePrivileged(nginx.conf, mainBefore);
    throw new Error(error.message + '；已恢复原 Nginx 配置，生成的模板仍保留');
  }
}
async function setupService(serviceUser, serviceHome, nginx, acmeFile) {
  const runtimePath = [
    path.dirname(process.execPath),
    path.join(prefix, '.tools/codex/node_modules/.bin'),
    process.env.PATH,
  ].join(path.delimiter);
  if (sys.platform === 'linux') {
    if (!command('systemctl') || !fs.existsSync('/run/systemd/system'))
      throw new Error('当前环境没有运行 systemd，请使用 --no-service 并按文档手动启动');
    await writePrivileged(
      '/etc/systemd/system/codex-cloud.service',
      systemdUnit({
        prefix,
        node: process.execPath,
        data,
        user: serviceUser,
        home: serviceHome,
        runtimePath,
      }),
    );
    await admin('systemctl', ['daemon-reload']);
    await admin('systemctl', ['enable', '--now', 'codex-cloud']);
    await admin('systemctl', ['restart', 'codex-cloud']);
    if (acmeFile) {
      const quote = (value) => JSON.stringify(value.replaceAll('%', '%%'));
      const trusted = (file) => {
        let current = fs.realpathSync(file);
        while (true) {
          const stat = fs.statSync(current);
          if (stat.uid !== 0 || stat.mode & 0o022) return false;
          const parent = path.dirname(current);
          if (parent === current) return true;
          current = parent;
        }
      };
      const rootReload =
        trusted(nginx.binary) &&
        trusted(nginx.conf) &&
        trusted(nginx.siteDir) &&
        fs
          .readdirSync(nginx.siteDir)
          .filter((name) => name.endsWith('.conf'))
          .every((name) => trusted(path.join(nginx.siteDir, name)));
      const after = rootReload
        ? `ExecStartPost=+${quote(nginx.binary)} -t -c ${quote(nginx.conf)} -p ${quote(nginx.home)}\nExecStartPost=+${quote(nginx.binary)} -s reload -c ${quote(nginx.conf)} -p ${quote(nginx.home)}\n`
        : '';
      if (!rootReload)
        log('Nginx 二进制或配置不由 root 独占管理；续期任务仅更新证书，管理员需手动重载 Nginx。');
      await writePrivileged(
        '/etc/systemd/system/codex-cloud-cert.service',
        `[Unit]\nDescription=Renew Codex Cloud TLS certificate\n[Service]\nType=oneshot\nUser=${serviceUser}\nExecStart=${quote(process.execPath)} ${quote(path.join(prefix, 'scripts/install/acme.mjs'))} ${quote(acmeFile)} --no-reload\n${after}`,
      );
      await writePrivileged(
        '/etc/systemd/system/codex-cloud-cert.timer',
        '[Unit]\nDescription=Codex Cloud certificate renewal timer\n[Timer]\nOnCalendar=daily\nRandomizedDelaySec=3600\nPersistent=true\n[Install]\nWantedBy=timers.target\n',
      );
      await admin('systemctl', ['daemon-reload']);
      await admin('systemctl', ['enable', '--now', 'codex-cloud-cert.timer']);
    }
  } else if (sys.platform === 'darwin') {
    if (process.getuid?.() === 0)
      throw new Error('macOS 请以登录用户运行安装器，需要权限时由 sudo 提升');
    const xml = (value) =>
      value
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;');
    const plist = path.join(os.homedir(), 'Library/LaunchAgents/com.codexcloud.workbench.plist');
    fs.mkdirSync(path.dirname(plist), { recursive: true });
    fs.writeFileSync(
      plist,
      `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>com.codexcloud.workbench</string><key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(path.join(prefix, 'dist/server/index.js'))}</string></array><key>WorkingDirectory</key><string>${xml(prefix)}</string><key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(runtimePath)}</string></dict><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>StandardOutPath</key><string>${xml(path.join(data, 'server.out.log'))}</string><key>StandardErrorPath</key><string>${xml(path.join(data, 'server.err.log'))}</string></dict></plist>`,
    );
    spawnSync('launchctl', ['bootout', `gui/${process.getuid()}`, plist], { stdio: 'ignore' });
    await run('launchctl', ['bootstrap', `gui/${process.getuid()}`, plist]);
    if (acmeFile) {
      const file = path.join(os.homedir(), 'Library/LaunchAgents/com.codexcloud.certificate.plist');
      fs.writeFileSync(
        file,
        `<?xml version="1.0"?><plist version="1.0"><dict><key>Label</key><string>com.codexcloud.certificate</string><key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(path.join(prefix, 'scripts/install/acme.mjs'))}</string><string>${xml(acmeFile)}</string></array><key>StartInterval</key><integer>86400</integer><key>StandardErrorPath</key><string>${xml(path.join(data, 'certificate.err.log'))}</string></dict></plist>`,
      );
      spawnSync('launchctl', ['bootout', `gui/${process.getuid()}`, file], { stdio: 'ignore' });
      await run('launchctl', ['bootstrap', `gui/${process.getuid()}`, file]);
      log(
        'macOS 续期以当前用户运行；若 Nginx 由 root 运行，证书更新后需管理员重载 Nginx，参见文档。',
      );
    }
  } else {
    await run('powershell.exe', [
      '-NoProfile',
      '-File',
      path.join(prefix, 'scripts/install/windows-tasks.ps1'),
      '-Action',
      'Register',
      '-Node',
      process.execPath,
      '-Prefix',
      prefix,
      '-Data',
      data,
      ...(nginx
        ? ['-Nginx', nginx.binary, '-NginxConfig', nginx.conf, '-NginxPrefix', nginx.home]
        : []),
      ...(acmeFile ? ['-AcmeConfig', acmeFile] : []),
    ]);
  }
}

async function main() {
  if (flags.has('--help')) {
    console.log(
      `Codex Cloud 安装向导\n入口：bash install.sh / powershell -File install.ps1\n只检查：--check；生成安装计划：--dry-run\n参数使用 --名称=值：\n--network=cn|global|custom --registry=https://… --prefix=/目录 --data=/目录\n--port=18474 --mode=auto|manual|skip --domain=codex.example.com\n--email=邮箱 --cert=/fullchain.pem --key=/privkey.pem --nginx-site-dir=/目录\n--no-service --update-config --stop-existing --noninteractive --acme-staging --replace-site --accept-acme-terms\n非交互密码通过 WORKBENCH_PASSWORD 环境变量传入。`,
    );
    return;
  }
  stage('1/8 检查环境');
  if (!['linux', 'darwin', 'win32'].includes(sys.platform) || !['x64', 'arm64'].includes(sys.arch))
    throw new Error('暂不支持此系统或架构');
  if (!dry && sys.platform === 'darwin' && process.getuid?.() === 0)
    throw new Error(
      'macOS 请使用登录用户运行安装器，不要 sudo bash install.sh；需要权限时安装器会调用 sudo',
    );
  log(JSON.stringify(sys, null, 2));
  npm = command(sys.platform === 'win32' ? 'npm.cmd' : 'npm');
  if (!supportedNode(process.version) || !npm)
    throw new Error('需要 Node.js >=24 和可运行的 npm，请从 install.sh / install.ps1 启动');
  const npmCli =
    sys.platform === 'win32'
      ? [
          path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
          path.join(path.dirname(npm), 'node_modules/npm/bin/npm-cli.js'),
        ].find(fs.existsSync)
      : null;
  const npmVersion = spawnSync(
    npmCli ? process.execPath : npm,
    npmCli ? [npmCli, '--version'] : ['--version'],
    { encoding: 'utf8', windowsHide: true },
  );
  if (npmVersion.error || npmVersion.status !== 0)
    throw new Error('npm 无法运行，请修复 Node/npm 安装');
  log(
    `Node ${process.version}；npm ${npmVersion.stdout.trim()}；Nginx ${command('nginx') || (fs.existsSync('/www/server/nginx/sbin/nginx') ? '宝塔已有安装' : '缺失，将安装')}`,
  );
  if (dry) {
    log('检测模式：未安装软件、未修改配置、未启动服务。');
    log(
      '安装计划：选择下载网络 → 准备 Node/npm → 检测并安装 Codex CLI → 补齐 Git/Nginx → 安装项目 → 配置域名/SSL（可跳过）→ 配置后台服务 → 健康检查。',
    );
    return;
  }
  if (
    !fs.existsSync(path.join(source, 'package.json')) ||
    !fs.existsSync(path.join(source, 'package-lock.json'))
  )
    throw new Error('请先下载并解压完整项目，再运行安装脚本');
  let network =
    flags.get('--network') ||
    process.env.CODEX_CLOUD_INSTALL_NETWORK ||
    (await ask('下载网络：cn 中国 / global 海外 / custom 自定义', 'cn'));
  if (!['cn', 'global', 'custom'].includes(network)) throw new Error('网络选项无效');
  registry =
    flags.get('--registry') ||
    (network === 'custom' ? await ask('npm 镜像 HTTPS 地址') : mirrors[network].registry);
  const registryUrl = new URL(registry);
  if (registryUrl.protocol !== 'https:' || registryUrl.username || registryUrl.password)
    throw new Error('npm 源必须为无内嵌凭据的 HTTPS 地址');
  const defaults =
    sys.platform === 'linux'
      ? process.getuid?.() === 0
        ? '/opt/codex-cloud'
        : path.join(os.homedir(), 'codex-cloud')
      : path.join(os.homedir(), 'codex-cloud');
  prefix = safePath(flags.get('--prefix') || (await ask('项目安装目录', defaults)));
  const old = parseEnv(path.join(prefix, '.env'));
  data = safePath(
    flags.get('--data') ||
      (await ask(
        '数据目录',
        old.DATA_DIR
          ? path.resolve(prefix, old.DATA_DIR)
          : sys.platform === 'linux' && process.getuid?.() === 0
            ? '/var/lib/codex-cloud/data'
            : path.join(prefix, 'data'),
      )),
  );
  let port = Number(flags.get('--port') || (await ask('后端端口', old.PORT || '18474')));
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error('后端端口需为 1024–65535');
  let mode =
    flags.get('--mode') ||
    (await ask(
      '域名配置：auto 自动配置 / manual 生成模板 / skip 跳过',
      interactive ? 'auto' : 'skip',
    ));
  if (!['auto', 'manual', 'skip'].includes(mode)) throw new Error('域名配置选项无效');
  let domain =
    mode === 'skip'
      ? ''
      : validDomain(flags.get('--domain') || (await ask('网站域名，例如 codex.example.com')));
  if (domain)
    log('公网访问必须开启 SSL；域名 A/AAAA 应解析到本机，防火墙及云安全组需开放 80/443。');
  let updateEnv = !fs.existsSync(path.join(prefix, '.env')) || flags.has('--update-config');
  if (!updateEnv)
    updateEnv = await yes('已有 .env，是否备份后更新网站/端口配置（数据目录仍使用上方选择）');
  if (!updateEnv) {
    data = safePath(path.resolve(prefix, old.DATA_DIR || 'data'));
    port = Number(old.PORT || '18474');
    const actual = old.PUBLIC_ORIGIN ? new URL(old.PUBLIC_ORIGIN) : null;
    if (domain && actual?.origin !== `https://${domain}`)
      throw new Error('保留的 .env 与所选域名不一致，请使用 --update-config 或选择跳过域名');
    log('保留现有 .env、数据及密码。');
  }
  await assertIdle();
  // Do not replace files beneath a live process unless the installer can stop it.
  const marker = path.join(data, 'server.lock');
  let live = false;
  if (fs.existsSync(marker)) {
    const pid = Number(fs.readFileSync(marker, 'utf8'));
    if (Number.isSafeInteger(pid) && pid > 0) {
      try {
        process.kill(pid, 0);
        live = true;
      } catch (error) {
        live = error.code !== 'ESRCH';
      }
    }
  }
  if (live) {
    if (sys.platform === 'linux' && command('systemctl')) {
      if (
        !flags.has('--stop-existing') &&
        !(await yes('现有服务可能正在运行，是否停止 codex-cloud 后继续更新'))
      )
        throw new Error('请先停止现有服务，或使用 --stop-existing');
      await admin('systemctl', ['stop', 'codex-cloud']);
    } else throw new Error('请先停止已有工作台，再重新运行安装器');
  }
  await checkPort(port);
  fs.mkdirSync(prefix, { recursive: true });
  fs.mkdirSync(data, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(prefix, '.installer'), { recursive: true, mode: 0o700 });
  const lease = new DatabaseSync(path.join(data, 'owner.sqlite'));
  try {
    lease.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');
  } catch {
    lease.close();
    throw new Error('数据目录被服务、备份或另一安装器占用，请停止占用后重试');
  }
  let released = false;
  const release = () => {
    if (!released) {
      released = true;
      lease.close();
    }
  };
  process.once('exit', release);
  logFile = path.join(prefix, '.installer/install.log');
  stateFile = path.join(prefix, '.installer/state.json');
  fs.closeSync(fs.openSync(logFile, 'a', 0o600));
  state = { prefix, data, port, mode, domain, network };
  stage('2/8 网络和系统依赖');
  try {
    const ping = await fetch(registry.replace(/\/$/, '') + '/react/latest', {
      signal: AbortSignal.timeout(15000),
    });
    if (!ping.ok) throw new Error('HTTP ' + ping.status);
  } catch (error) {
    log('所选 npm 镜像不可用：' + error.message);
    registry = await ask('请输入备用 npm HTTPS 源', mirrors.global.registry);
    const alternate = new URL(registry);
    if (alternate.protocol !== 'https:' || alternate.username || alternate.password)
      throw new Error('备用 npm 源无效');
  }
  await systemMirror(network);
  await copySource();
  stage('3/8 检测并安装 Codex CLI');
  let codex = old.CODEX_BIN && fs.existsSync(old.CODEX_BIN) ? old.CODEX_BIN : command('codex');
  if (codex && /\.(cmd|ps1)$/i.test(codex)) {
    const entry = path.join(path.dirname(codex), 'node_modules/@openai/codex/bin/codex.js');
    codex = fs.existsSync(entry) ? entry : null;
  }
  if (codex) {
    const version = spawnSync(
      codex.endsWith('.js') ? process.execPath : codex,
      codex.endsWith('.js') ? [codex, '--version'] : ['--version'],
      { encoding: 'utf8', windowsHide: true },
    );
    if (version.status !== 0 || !/0\.(155\.1|159\.3)\b/.test(version.stdout || '')) {
      if (!(await yes('现有 Codex 未在本项目验证版本列表，是否继续复用'))) codex = null;
    }
  }
  if (!codex) codex = await installTool('@openai/codex', CODEX_VERSION);
  log('Codex CLI 已就绪：' + codex);
  if (!command('git')) {
    if (sys.platform === 'win32') {
      if (command('winget'))
        await run('winget', [
          'install',
          '--id',
          'Git.Git',
          '--exact',
          '--accept-package-agreements',
          '--accept-source-agreements',
        ]);
      else
        log(
          '未安装 Git 且没有 winget；工作台可用于普通目录项目。Git 仓库功能需要稍后安装 https://git-scm.com/download/win。',
        );
    } else await installPackages(['git']);
  }
  const nginx = await findNginx();
  if (domain && mode === 'auto' && fs.existsSync(nginx.siteDir)) {
    for (const name of fs
      .readdirSync(nginx.siteDir)
      .filter((name) => name.endsWith('.conf') && name !== 'codex-cloud.conf')) {
      const content = fs.readFileSync(path.join(nginx.siteDir, name), 'utf8');
      if (
        [...content.matchAll(/^[ \t]*server_name\s+([^;]+);/gm)].some((match) =>
          match[1].split(/\s+/).includes(domain),
        )
      ) {
        throw new Error(
          `域名已在 ${path.join(nginx.siteDir, name)} 配置，请使用 --mode=manual 接入已有站点`,
        );
      }
    }
  }
  stage('4/8 安装项目依赖并构建');
  const lockFile = path.join(prefix, 'package-lock.json');
  const originalLock = fs.readFileSync(lockFile, 'utf8');
  try {
    fs.writeFileSync(lockFile, mirrorLock(originalLock, registry));
    await npmRun(['ci', '--include=dev', '--registry', registry, '--no-audit', '--no-fund']);
  } finally {
    fs.writeFileSync(lockFile, originalLock);
  }
  await npmRun(['run', 'build']);
  stage('5/8 网站和密码配置');
  if (updateEnv) {
    const envFile = path.join(prefix, '.env');
    const fresh = renderEnv({ domain, port, data, codex, projectRoot: path.parse(prefix).root });
    if (fs.existsSync(envFile)) {
      fs.copyFileSync(envFile, path.join(prefix, '.installer/env-backup-' + Date.now()));
      const keys = new Set([
        'HOST',
        'PORT',
        'PUBLIC_ORIGIN',
        'COOKIE_SECURE',
        'TRUST_PROXY',
        'DATA_DIR',
        'CODEX_BIN',
      ]);
      const existing = fs.readFileSync(envFile, 'utf8');
      const lines = existing
        .split(/\r?\n/)
        .filter((line) => !keys.has(/^\s*([A-Z_]+)\s*=/.exec(line)?.[1]));
      const updated = fresh.split('\n').filter((line) => keys.has(line.split('=')[0]));
      fs.writeFileSync(envFile, [...lines, ...updated].join('\n') + '\n', { mode: 0o600 });
    } else fs.writeFileSync(envFile, fresh, { mode: 0o600 });
  }
  const codexHome = parseEnv(path.join(prefix, '.env')).CODEX_HOME;
  if (codexHome) fs.mkdirSync(path.resolve(prefix, codexHome), { recursive: true, mode: 0o700 });
  if (hasPassword('passwordHash')) log('已有登录密码，保留。');
  else await npmRun(['run', 'password'], { env: parseEnv(path.join(prefix, '.env')) });
  stage('6/8 Nginx、域名与 SSL');
  let acmeFile = null,
    httpsReady = false;
  const challengeDir =
    sys.platform === 'linux'
      ? '/var/www/codex-cloud-acme'
      : path.join(prefix, '.installer/acme-webroot');
  const certDir = path.join(data, 'certificates');
  const cert = flags.get('--cert')
    ? safePath(flags.get('--cert'))
    : path.join(certDir, 'fullchain.pem');
  const key = flags.get('--key') ? safePath(flags.get('--key')) : path.join(certDir, 'privkey.pem');
  const templateDomain = domain || 'codex.example.com';
  fs.writeFileSync(
    path.join(prefix, 'deploy/nginx-codex-cloud.conf'),
    nginxConfig({ domain: templateDomain, port, challengeDir, cert, key }),
  );
  fs.writeFileSync(
    path.join(prefix, 'deploy/nginx-acme-http.conf'),
    nginxConfig({ domain: templateDomain, port, challengeDir }),
  );
  if (mode === 'auto') {
    if (
      fs.existsSync(path.join(nginx.siteDir, 'codex-cloud.conf')) &&
      !flags.has('--replace-site') &&
      !(await yes('已有 codex-cloud.conf，是否备份后更新', false))
    )
      throw new Error('保留现有 Nginx 配置；请按生成的模板自行配置');
    if (flags.has('--cert') !== flags.has('--key')) throw new Error('请同时提供 --cert 和 --key');
    // Privileged nginx -t validates explicitly provided keys that the installer user cannot read.
    let usableCertificate = flags.has('--cert') && flags.has('--key');
    if (fs.existsSync(cert) && fs.existsSync(key)) {
      try {
        const existing = new X509Certificate(fs.readFileSync(cert));
        usableCertificate =
          !!existing.checkHost(domain) &&
          Date.parse(existing.validTo) > Date.now() &&
          existing.checkPrivateKey(createPrivateKey(fs.readFileSync(key)));
      } catch (error) {
        if (error.code !== 'EACCES' || !flags.has('--cert')) usableCertificate = false;
      }
      if (!usableCertificate && (flags.has('--cert') || flags.has('--key')))
        throw new Error('证书已过期、域名不匹配或私钥不匹配，请提供有效证书');
    }
    if (usableCertificate) {
      await activateNginx(nginx, nginxConfig({ domain, port, challengeDir, cert, key }), {
        start: true,
      });
      httpsReady = true;
      const existingAcme = path.join(data, 'acme.json');
      if (
        !flags.has('--cert') &&
        fs.existsSync(existingAcme) &&
        JSON.parse(fs.readFileSync(existingAcme, 'utf8')).domain === domain
      )
        acmeFile = existingAcme;
      log('使用已有 SSL 证书；续期由原证书管理方式负责。');
    } else if (flags.has('--cert') || flags.has('--key'))
      throw new Error('提供的证书/私钥文件不存在或不成对');
    else {
      log('自动申请使用 Let’s Encrypt HTTP-01，必须先解析域名并开放 80/443；将配置每日续期。');
      const email = flags.get('--email') || (await ask('证书到期通知邮箱'));
      if (
        (!interactive && !flags.has('--accept-acme-terms')) ||
        (!flags.has('--accept-acme-terms') &&
          !(await yes(
            '是否同意 Let’s Encrypt 服务条款 https://letsencrypt.org/repository/ 并申请证书',
            false,
          )))
      )
        throw new Error('未申请证书；请使用 --mode=manual 自行配置 SSL');
      if (sys.platform === 'linux')
        await admin('install', [
          '-d',
          '-m',
          '0755',
          challengeDir,
          path.join(challengeDir, '.well-known'),
          path.join(challengeDir, '.well-known/acme-challenge'),
        ]);
      else fs.mkdirSync(challengeDir, { recursive: true });
      // Challenge files must be writable by the interactive installer user.
      if (sys.platform === 'linux' && process.getuid?.() !== 0)
        await admin('chown', [sys.user, path.join(challengeDir, '.well-known/acme-challenge')]);
      const modulePath = await installTool('acme-client', ACME_VERSION);
      const config = {
        domain,
        email,
        directory: certDir,
        challengeDir,
        modulePath,
        nginx: nginx.binary,
        nginxConfig: nginx.conf,
        nginxPrefix: nginx.home,
        staging: flags.has('--acme-staging'),
      };
      acmeFile = path.join(data, 'acme.json');
      fs.writeFileSync(acmeFile, JSON.stringify(config, null, 2), { mode: 0o600 });
      // Use a challenge-only temporary site: do not expose the application on HTTP.
      const http = nginxConfig({ domain, port, challengeDir }).replace(
        /    client_max_body_size[\s\S]*?\n    }\n}/,
        '    location / { return 503; }\n}',
      );
      await activateNginx(nginx, http, { start: true });
      try {
        await issueCertificate(config);
        await activateNginx(nginx, nginxConfig({ domain, port, challengeDir, cert, key }));
        httpsReady = true;
      } catch (error) {
        log(
          'SSL 尚未就绪：' + error.message + '。项目安装已保留，可修复 DNS/端口后重新执行安装器。',
        );
        mode = 'manual';
        acmeFile = null;
      }
    }
  } else log('未启用网站；反代模板已写入 deploy/nginx-codex-cloud.conf，参见 docs/INSTALL.md。');
  stage('7/8 后台服务');
  let serviceUser = sys.user,
    serviceHome = os.homedir();
  if (sys.platform === 'linux' && process.getuid?.() === 0) {
    serviceUser = 'codexcloud';
    serviceHome = '/var/lib/codex-cloud';
    if (spawnSync('id', ['-u', serviceUser], { stdio: 'ignore' }).status !== 0)
      await run('useradd', [
        '--system',
        '--create-home',
        '--home-dir',
        serviceHome,
        '--shell',
        '/bin/bash',
        serviceUser,
      ]);
    serviceHome =
      spawnSync('getent', ['passwd', serviceUser], { encoding: 'utf8' })
        .stdout.trim()
        .split(':')[5] || serviceHome;
    await run('chown', ['-R', serviceUser + ':' + serviceUser, prefix, data]);
    if (acmeFile)
      await run('chown', [
        serviceUser + ':' + serviceUser,
        path.join(challengeDir, '.well-known/acme-challenge'),
      ]);
    // Root's private Node path cannot be traversed by the service user.
    if (process.execPath.startsWith('/root/'))
      throw new Error(
        'Node 位于 /root，codexcloud 服务账户无法访问；请使用 CODEX_CLOUD_RUNTIME_DIR=/var/lib/codex-cloud/runtime 重新安装 Node',
      );
  }
  release();
  if (!flags.has('--no-service'))
    await setupService(
      serviceUser,
      serviceHome,
      mode === 'auto' || acmeFile ? nginx : null,
      acmeFile,
    );
  else
    log(
      `未注册后台服务。手动启动：cd ${JSON.stringify(prefix)} && ${JSON.stringify(process.execPath)} dist/server/index.js`,
    );
  stage('8/8 验收');
  let codexReady = true;
  try {
    const env = { ...parseEnv(path.join(prefix, '.env')), HOME: serviceHome };
    if (sys.platform === 'linux' && process.getuid?.() === 0) {
      await run(
        'runuser',
        [
          '-u',
          serviceUser,
          '--',
          process.execPath,
          path.join(prefix, 'node_modules/tsx/dist/cli.mjs'),
          path.join(prefix, 'scripts/doctor.ts'),
        ],
        { env },
      );
    } else await npmRun(['run', 'doctor'], { env });
  } catch (error) {
    codexReady = false;
    log('Codex 诊断尚未通过：' + error.message + '；可稍后运行 npm run doctor 检查。');
  }
  if (flags.has('--no-service') && acmeFile)
    log('未注册自动续期；请按 docs/INSTALL.md 定期运行证书续期命令。');
  let httpsVerified = false;
  if (httpsReady && !flags.has('--acme-staging') && !flags.has('--no-service')) {
    try {
      const response = await fetch('https://' + domain + '/api/auth/status', {
        signal: AbortSignal.timeout(10000),
      });
      httpsVerified = response.ok && (await response.json()).configured;
    } catch (error) {
      log('外部 HTTPS 验收未通过：' + error.message + '；请检查域名解析、安全组、SSL 证书及反代。');
    }
  }
  if (!flags.has('--no-service')) {
    let healthy = false;
    for (let attempt = 0; attempt < 15; attempt++) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/auth/status`, {
          signal: AbortSignal.timeout(3000),
        });
        if (response.ok && (await response.json()).configured) {
          healthy = true;
          break;
        }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    if (!healthy) throw new Error('项目已安装，但后端健康检查未通过，请查看服务日志后重试');
  }
  log(
    `\n项目安装完成。\n网站状态：${httpsReady ? 'HTTPS 已配置' : '域名/SSL 待自行配置'}\n地址：${httpsReady ? 'https://' + domain : domain ? '等待域名 HTTPS 配置；后端监听 127.0.0.1:' + port : 'http://127.0.0.1:' + port + '（仅本机）'}\n安装目录：${prefix}\n数据目录：${data}\n反代模板：${path.join(prefix, 'deploy/nginx-codex-cloud.conf')}\n安装日志：${logFile}\n后续配置：${path.join(prefix, 'docs/INSTALL.md')}`,
  );
  if (flags.has('--acme-staging'))
    log('使用的是 ACME 测试证书，浏览器不会信任；生产部署请去掉 --acme-staging 后重新申请。');
  log('供应商可在网页设置中添加；使用自定义供应商无需预先登录官方账号。');
  state = {
    ...state,
    stage: 'complete',
    httpsReady,
    httpsVerified,
    codexReady,
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), { mode: 0o600 });
}
main().catch((error) => {
  log('\n安装未完成：' + error.message);
  if (stateFile)
    fs.writeFileSync(
      stateFile,
      JSON.stringify(
        { ...state, error: error.message, updatedAt: new Date().toISOString() },
        null,
        2,
      ),
      { mode: 0o600 },
    );
  if (logFile) log('日志：' + logFile + '；修复后可重新运行入口脚本，已有数据和密码会保留。');
  process.exitCode = 1;
});
