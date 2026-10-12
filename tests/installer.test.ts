import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  supportedNode,
  osRelease,
  validDomain,
  nginxConfig,
  renderEnv,
  mirrorLock,
  systemdUnit,
  nginxIncludesSite,
} from '../scripts/install/core.mjs';
const exec = promisify(execFile);

test('installer detects supported Node and Linux release without executing release contents', () => {
  assert.equal(supportedNode('v22.10.0'), false);
  assert.equal(supportedNode('v24.21.0'), true);
  assert.equal(supportedNode('nonsense'), false);
  assert.deepEqual(osRelease('ID=ubuntu\nVERSION_ID="24.04"\nPRETTY_NAME="Ubuntu Linux"'), {
    ID: 'ubuntu',
    VERSION_ID: '24.04',
    PRETTY_NAME: 'Ubuntu Linux',
  });
  assert.equal(osRelease('ID="$(touch injected)"').ID, '$(touch injected)');
});

test('installer validates domains and renders SSL/WebSocket proxy with safe paths', () => {
  assert.equal(validDomain('CODEX.example.com'), 'codex.example.com');
  for (const input of [
    'https://example.com',
    'example.com:443',
    'example.com/path',
    'example.com;\nreturn 200;',
    '127.0.0.1',
  ])
    assert.throws(() => validDomain(input));
  const config = nginxConfig({
    domain: 'codex.example.com',
    port: 18474,
    challengeDir: '/var/www/acme',
    cert: '/tmp/my cert/fullchain.pem',
    key: '/tmp/my cert/key.pem',
  });
  assert.match(config, /listen 443 ssl/);
  assert.match(config, /return 301 https:\/\/\$host\$request_uri/);
  assert.match(config, /proxy_set_header Upgrade \$http_upgrade/);
  assert.match(config, /proxy_buffering off/);
  assert.match(config, /ssl_certificate "\/tmp\/my cert\/fullchain.pem"/);
  assert.throws(() =>
    nginxConfig({ domain: 'example.com', port: 18474, challengeDir: '/tmp/";bad' }),
  );
  assert.throws(() => nginxConfig({ domain: 'example.com', port: 80, challengeDir: '/tmp/acme' }));
});

test('npm acceleration rewrites only public registry URLs and retains package integrity', () => {
  const input = JSON.stringify({
    packages: {
      a: {
        resolved: 'https://registry.npmjs.org/@scope/name/-/name-1.tgz',
        integrity: 'sha512-unchanged',
      },
      b: { resolved: 'https://private.example/pkg.tgz', integrity: 'secret' },
    },
  });
  const result = JSON.parse(mirrorLock(input, 'https://registry.npmmirror.com'));
  assert.equal(
    result.packages.a.resolved,
    'https://registry.npmmirror.com/@scope/name/-/name-1.tgz',
  );
  assert.equal(result.packages.a.integrity, 'sha512-unchanged');
  assert.equal(result.packages.b.resolved, 'https://private.example/pkg.tgz');
});

test('local install remains loopback-only and domain install enables secure proxy configuration', () => {
  const common = {
    port: 18474,
    data: '/tmp/private data',
    codex: '/tmp/codex.js',
    projectRoot: '/',
  };
  const local = renderEnv(common);
  assert.match(local, /PUBLIC_ORIGIN=http:\/\/127.0.0.1:18474/);
  assert.match(local, /COOKIE_SECURE=false/);
  assert.match(local, /PROJECT_ROOTS="\/"/);
  const publicEnv = renderEnv({ ...common, domain: 'codex.example.com' });
  assert.match(publicEnv, /COOKIE_SECURE=true/);
  assert.match(publicEnv, /TRUST_PROXY=true/);
  const unit = systemdUnit({
    prefix: '/tmp/project space',
    node: '/tmp/node',
    data: common.data,
    user: 'codexcloud',
    home: '/home/codexcloud',
    runtimePath: '/tmp/bin:/usr/bin',
  });
  assert.match(unit, /User=codexcloud/);
  assert.match(unit, /WorkingDirectory="\/tmp\/project space"/);
  assert.match(unit, /KillMode=control-group/);
  assert.throws(() =>
    systemdUnit({ prefix: '/tmp/project', node: '/tmp/node', user: 'root\nExecStart=bad' }),
  );
});

test('installer check mode does not create destination directories or mutate configuration', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-cloud-install-check-'));
  try {
    const dest = path.join(dir, 'must-not-exist');
    const { stdout } = await exec(
      process.execPath,
      ['scripts/install/setup.mjs', '--check', `--prefix=${dest}`],
      { cwd: path.resolve('.') },
    );
    assert.match(stdout, /未安装软件、未修改配置、未启动服务/);
    await assert.rejects(fs.stat(dest), { code: 'ENOENT' });
    if (process.platform !== 'win32') await exec('bash', ['-n', 'install.sh']);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('generated HTTPS site passes the real Nginx configuration parser', async (t) => {
  const candidates = ['/usr/sbin/nginx', '/usr/bin/nginx', '/www/server/nginx/sbin/nginx'];
  let nginx: string | undefined;
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      nginx = candidate;
      break;
    } catch {}
  }
  if (!nginx || process.platform === 'win32') {
    t.skip('Nginx unavailable on this test host');
    return;
  }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-cloud-nginx-config-'));
  try {
    const cert = path.join(dir, 'fullchain.pem'),
      key = path.join(dir, 'privkey.pem');
    await exec('openssl', [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-subj',
      '/CN=codex.example.com',
      '-keyout',
      key,
      '-out',
      cert,
    ]);
    await fs.mkdir(path.join(dir, 'logs'));
    const site = nginxConfig({
      domain: 'codex.example.com',
      port: 18474,
      challengeDir: path.join(dir, 'challenge'),
      cert,
      key,
    });
    const config = path.join(dir, 'nginx.conf');
    await fs.writeFile(
      config,
      `error_log stderr;\npid "${dir}/nginx.pid";\nevents {}\nhttp { access_log off;\n${site.replace('listen 80;', 'listen 19080;').replace('listen 443 ssl;', 'listen 19443 ssl;')}\n}\n`,
    );
    const result = await exec(nginx, ['-t', '-e', 'stderr', '-p', dir + '/', '-c', config]);
    assert.match(result.stderr, /test is successful/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('Nginx include detection ignores commented directives and handles relative config paths', () => {
  assert.equal(
    nginxIncludesSite(
      '# include /etc/nginx/conf.d/*.conf;',
      '/etc/nginx/conf.d',
      '/etc/nginx/nginx.conf',
    ),
    false,
  );
  assert.equal(
    nginxIncludesSite('  include conf.d/*.conf;', '/etc/nginx/conf.d', '/etc/nginx/nginx.conf'),
    true,
  );
  assert.equal(
    nginxIncludesSite(
      '  include "/custom/sites/*.conf";',
      '/custom/sites',
      '/etc/nginx/nginx.conf',
    ),
    true,
  );
  assert.equal(
    nginxIncludesSite('  root /etc/nginx/conf.d;', '/etc/nginx/conf.d', '/etc/nginx/nginx.conf'),
    false,
  );
});

test('Windows Nginx include paths match forward slashes, spaces and drive letter casing', () => {
  assert.equal(
    nginxIncludesSite(
      ' include "c:/Program Files/nginx/conf/conf.d/*.conf";',
      'C:\\Program Files\\nginx\\conf\\conf.d',
      'C:\\Program Files\\nginx\\conf\\nginx.conf',
      path.win32,
    ),
    true,
  );
});
