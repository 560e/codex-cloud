import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// A separate SQLite exclusive transaction is an OS-backed process lease. The
// kernel releases it on crashes; server.lock remains a diagnostic/legacy marker.
export function acquireDataLock(directory: string) {
  fs.mkdirSync(directory, { recursive: true });
  const marker = path.join(directory, 'server.lock');
  const lease = new DatabaseSync(path.join(directory, 'owner.sqlite'));
  try {
    lease.exec(
      'PRAGMA busy_timeout=0; CREATE TABLE IF NOT EXISTS owner(id INTEGER); BEGIN EXCLUSIVE',
    );
    if (fs.existsSync(marker)) {
      const pid = Number(fs.readFileSync(marker, 'utf8'));
      if (Number.isSafeInteger(pid) && pid > 0) {
        let running = true;
        try {
          process.kill(pid, 0);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ESRCH') running = false;
        }
        if (running) throw new Error('已有服务进程');
      }
    }
    fs.writeFileSync(marker, String(process.pid));
  } catch {
    lease.close();
    throw new Error('数据目录已被服务或备份占用，请先停止服务再备份。');
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      if (fs.existsSync(marker) && fs.readFileSync(marker, 'utf8') === String(process.pid))
        fs.unlinkSync(marker);
    } finally {
      lease.close();
    }
  };
}
