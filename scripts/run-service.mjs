import { spawn } from 'node:child_process';
import { rotatingLog, pruneLogs } from '../dist/server/logging.js';
const [caddy, logDir] = process.argv.slice(2);
if (!caddy || !logDir) throw new Error('Expected Caddy executable and log directory');
const children = [];
let stopping = false;
function stop(code = 1) {
  if (stopping) return;
  stopping = true;
  clearInterval(maintenance);
  for (const child of children) {
    if (!child.pid || child.exitCode !== null) continue;
    if (process.platform === 'win32')
      spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
    else child.kill('SIGTERM');
  }
  process.exitCode = code;
}
const maintenance = setInterval(() => {
  try {
    pruneLogs(logDir);
  } catch (error) {
    console.error(error.message);
  }
}, 60000);
maintenance.unref();
for (const [name, command, args] of [
  ['server', process.execPath, ['dist/server/index.js']],
  ['caddy', caddy, ['run', '--config', 'deploy/Caddyfile', '--adapter', 'caddyfile']],
]) {
  const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  for (const channel of ['stdout', 'stderr']) {
    const write = rotatingLog(logDir, `${name}.${channel === 'stdout' ? 'out' : 'err'}`);
    child[channel].on('data', (chunk) => {
      try {
        write(chunk);
      } catch (error) {
        console.error(error.message);
        stop();
      }
    });
  }
  child.on('error', (error) => {
    console.error(error.message);
    stop();
  });
  child.on('exit', () => stop());
}
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
