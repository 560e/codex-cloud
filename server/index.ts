import fs from 'node:fs';
import path from 'node:path';
import { managedCli } from './cli-update.js';
import { config } from './config.js';
import { Store } from './store.js';
import { CodexBridge } from './codex.js';
import { Workbench } from './workbench.js';
import { buildApp } from './app.js';
import { acquireDataLock } from './data-lock.js';
import { rotatingLog, pruneLogs } from './logging.js';

const releaseDataLock = acquireDataLock(config.dataDir);
process.on('exit', releaseDataLock);
const store = new Store(config.dataDir, true);
const bridge = new CodexBridge(managedCli(config.dataDir) || config.codexBin);
const workbench = new Workbench(bridge, store, config.maxConcurrent);
const app = await buildApp(store, workbench);
const logDir = path.join(config.dataDir, 'logs');
fs.mkdirSync(logDir, { recursive: true });
const diagnosticLog = rotatingLog(logDir, 'codex-diagnostic');
bridge.on('diagnostic', (text) => diagnosticLog(text));
let stopping = false;
let retry: NodeJS.Timeout | undefined;
let backoff = 1000;
const connect = async () => {
  if (stopping) return;
  try {
    await workbench.connect();
    backoff = 1000;
  } catch (e) {
    bridge.error = (e as Error).message;
    app.log.warn({ message: bridge.error }, 'Codex connection failed');
    schedule();
  }
};
function schedule() {
  if (stopping || retry) return;
  retry = setTimeout(() => {
    retry = undefined;
    void connect();
  }, backoff);
  backoff = Math.min(backoff * 2, 30000);
}
bridge.on('disconnect', schedule);
const clean = () => {
  store.prune(config.eventDays);
  try {
    pruneLogs(logDir);
  } catch (error) {
    app.log.warn({ message: (error as Error).message }, 'Log cleanup failed');
  }
};
clean();
const maintenance = setInterval(clean, 60000);
maintenance.unref();
async function shutdown() {
  if (stopping) return;
  stopping = true;
  clearTimeout(retry);
  clearInterval(maintenance);
  bridge.removeListener('disconnect', schedule);
  await app.close();
  bridge.stop();
  if (bridge.child)
    await Promise.race([
      new Promise((resolve) => bridge.child!.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 2500)),
    ]);
  store.interruptRuns();
  bridge.removeAllListeners();
  store.close();
  releaseDataLock();
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
await app.listen({ host: config.host, port: config.port });
if (!store.get('passwordHash')) app.log.warn('No password configured. Run: npm run password');
void connect();
