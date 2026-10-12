import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { rotatingLog } from '../../dist/server/logging.js';
const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
process.chdir(config.prefix);
process.env.PATH = config.runtimePath;
if (config.nginx) {
  const common = ['-c', config.nginxConfig, '-p', config.nginxPrefix];
  const check = spawnSync(config.nginx, ['-t', ...common], { stdio: 'inherit', windowsHide: true });
  if (check.status !== 0) throw new Error('Nginx 配置检查失败');
  const reload = spawnSync(config.nginx, ['-s', 'reload', ...common], {
    stdio: 'ignore',
    windowsHide: true,
  });
  if (reload.status !== 0) {
    const nginx = spawn(config.nginx, common, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    nginx.on('error', (error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
    nginx.unref();
  }
}
const logs = path.join(config.data, 'logs');
const child = spawn(config.node, [path.join(config.prefix, 'dist/server/index.js')], {
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});
for (const stream of ['stdout', 'stderr']) {
  const write = rotatingLog(logs, `server.${stream === 'stdout' ? 'out' : 'err'}`);
  child[stream].on('data', write);
}
child.on('error', (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on('exit', (code) => {
  process.exitCode = code || 1;
});
// Nginx may serve other sites; shutting down this task only stops its backend.
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    if (child.pid)
      spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
  });
