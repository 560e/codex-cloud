import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { domainToASCII } from 'node:url';

export const NODE_VERSION = '24.21.0';
export const CODEX_VERSION = '0.159.3';
export const ACME_VERSION = '5.4.0';
export const mirrors = {
  cn: {
    registry: 'https://registry.npmmirror.com',
    node: 'https://registry.npmmirror.com/-/binary/node',
  },
  global: { registry: 'https://registry.npmjs.org', node: 'https://nodejs.org/dist' },
};
export function supportedNode(version) {
  return /^v?(\d+)\./.test(version) && Number(version.replace(/^v/, '').split('.')[0]) >= 24;
}
export function osRelease(text) {
  return Object.fromEntries(
    text.split('\n').flatMap((line) => {
      const match = /^([A-Z_]+)=(.*)$/.exec(line);
      return match ? [[match[1], match[2].replace(/^['"]|['"]$/g, '')]] : [];
    }),
  );
}
export function detectSystem() {
  const release =
    process.platform === 'linux' && fs.existsSync('/etc/os-release')
      ? osRelease(fs.readFileSync('/etc/os-release', 'utf8'))
      : {};
  return {
    platform: process.platform,
    arch: process.arch,
    name: release.PRETTY_NAME || `${os.type()} ${os.release()}`,
    distro: release.ID || '',
    version: release.VERSION_ID || '',
    home: os.homedir(),
    user: os.userInfo().username,
  };
}
export function validDomain(input) {
  const entered = input.trim().toLowerCase();
  if (/[\s\/:?#@\\]/.test(entered)) throw new Error('请输入纯域名，不要包含协议、端口或路径');
  const domain = domainToASCII(entered);
  if (
    domain.length > 253 ||
    !domain.includes('.') ||
    !domain.split('.').every((part) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(part)) ||
    /^\d+(\.\d+){3}$/.test(domain)
  )
    throw new Error('请输入域名，例如 codex.example.com，不要包含协议、端口或路径');
  return domain;
}
export function safePath(value) {
  if (!value || /[\x00-\x1f]/.test(value)) throw new Error('目录或文件路径含无效字符');
  return path.resolve(value);
}
export function nginxPath(value) {
  if (/[\x00-\x1f"$;]/.test(value)) throw new Error('Nginx 路径不能包含换行、双引号、$ 或分号');
  return '"' + value.replaceAll('\\', '/') + '"';
}
export function nginxConfig({ domain, port, challengeDir, cert, key }) {
  domain = validDomain(domain);
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error('后端端口需在 1024–65535 之间');
  const proxy = `    client_max_body_size 32m;
    location / {
        proxy_pass http://127.0.0.1:${port};
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        proxy_buffering off;
        proxy_cache off;
    }`;
  return `# Managed by Codex Cloud installer; keep this as a separate site configuration.
server {
    listen 80;
    server_name ${domain};
    location ^~ /.well-known/acme-challenge/ {
        root ${nginxPath(challengeDir)};
        default_type text/plain;
        try_files $uri =404;
    }
${cert ? '    location / { return 301 https://$host$request_uri; }' : proxy}
}
${
  cert
    ? `server {
    listen 443 ssl;
    server_name ${domain};
    ssl_certificate ${nginxPath(cert)};
    ssl_certificate_key ${nginxPath(key)};
    ssl_protocols TLSv1.2 TLSv1.3;
${proxy}
}
`
    : ''
}`;
}
export function renderEnv({ domain, port, data, codex, projectRoot }) {
  const quote = (value) => JSON.stringify(value.replaceAll('\\', '/'));
  return `# 安装向导生成的运行配置；修改后重启后端，服务中同名环境变量优先。
# 请勿提交本文件到 Git。网站密码通过 npm run password 设置，供应商 Key 在网页中管理。

# 后端监听地址：同机反向代理或仅本机访问时使用回环地址。
HOST=127.0.0.1
# 后端端口（1～65535），须与反向代理转发端口一致。
PORT=${port}
# 浏览器访问的来源地址（协议、主机及非默认端口），不包含子路径。
PUBLIC_ORIGIN=${domain ? `https://${domain}` : `http://127.0.0.1:${port}`}
# HTTPS 时必须为 true；仅本机 HTTP 时设 false。
COOKIE_SECURE=${domain ? 'true' : 'false'}
# 同机反向代理设 true，直连设 false；与供应商出站代理无关。
TRUST_PROXY=${domain ? 'true' : 'false'}

# 工作台数据库、附件、供应商密钥与日志目录；升级时保留并备份。
DATA_DIR=${quote(data)}
# CLI 配置、认证及原生会话目录；复用既有 CLI 时按需调整。
CODEX_HOME=${quote(path.join(data, 'codex'))}
# CLI 启动文件绝对路径；通过网页安装的受管理版本可优先使用。
CODEX_BIN=${quote(codex)}
# 允许添加项目的父目录，多个路径用英文分号分隔；空值允许任意目录。
PROJECT_ROOTS=${quote(projectRoot)}
# 全实例最大并发任务数，整数 1～16。
MAX_CONCURRENT_TURNS=3
# 登录会话有效天数，整数 1～90；未勾选“记住登录”时为 12 小时。
SESSION_DAYS=7
# 事件记录保留天数，整数 1～30，不影响 CLI 原生会话正文。
EVENT_RETENTION_DAYS=7

# 可选出站代理；HTTP 目标使用 HTTP_PROXY，HTTPS 目标使用 HTTPS_PROXY。
# HTTP CONNECT 代理两项均填写 http://；建议同时配置两项。
# HTTP_PROXY=http://proxy.example.com:3128
# HTTPS_PROXY=http://proxy.example.com:3128
# 不经代理的主机/IP，逗号分隔；内网供应商按需追加。
# NO_PROXY=localhost,127.0.0.1,::1,[::1]
# 无需额外设置 NODE_USE_ENV_PROXY；避免大小写代理变量相互冲突。
`;
}
export function mirrorLock(text, registry) {
  const lock = JSON.parse(text);
  for (const pkg of Object.values(lock.packages || {})) {
    if (typeof pkg.resolved === 'string') {
      const url = new URL(pkg.resolved, 'https://registry.npmjs.org');
      if (url.hostname === 'registry.npmjs.org')
        pkg.resolved = registry.replace(/\/$/, '') + url.pathname;
    }
  }
  return JSON.stringify(lock, null, 2) + '\n';
}
export function systemdUnit({ prefix, node, data, user, home, runtimePath }) {
  const quoted = (value) => JSON.stringify(value.replaceAll('%', '%%'));
  if (!/^[a-z_][a-z0-9_-]*\$?$/i.test(user)) throw new Error('服务账户名称无效');
  return `[Unit]\nDescription=Codex Cloud\nWants=network-online.target\nAfter=network-online.target\n\n[Service]\nType=simple\nUser=${user}\nWorkingDirectory=${quoted(prefix)}\nEnvironment=${quoted('NODE_ENV=production')}\nEnvironment=${quoted('HOME=' + home)}\nEnvironment=${quoted('PATH=' + runtimePath)}\nExecStart=${quoted(node)} ${quoted(path.join(prefix, 'dist/server/index.js'))}\nRestart=on-failure\nRestartSec=5\nUMask=0077\nKillMode=control-group\nTimeoutStopSec=20\n\n[Install]\nWantedBy=multi-user.target\n`;
}

export function nginxIncludesSite(text, siteDir, confFile, paths = path) {
  const normalize = (value) => (paths.sep === '\\' ? value.toLowerCase() : value);
  const expected = normalize(paths.resolve(siteDir));
  return [...text.matchAll(/^[ \t]*include\s+("[^"]+"|'[^']+'|[^;\s]+)\s*;/gm)].some((match) => {
    const input = match[1].replace(/^['"]|['"]$/g, '');
    const resolved = paths.resolve(paths.dirname(confFile), input);
    return (
      normalize(paths.dirname(resolved)) === expected &&
      ['*.conf', '*', 'codex-cloud.conf'].includes(paths.basename(resolved))
    );
  });
}
