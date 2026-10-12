import fs from 'node:fs';
import path from 'node:path';

export function rotatingLog(
  directory: string,
  name: string,
  maxBytes = 10 * 1024 * 1024,
  copies = 4,
) {
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, name + '.log');
  return (chunk: string | Buffer) => {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let offset = 0;
    while (offset < data.length) {
      let size = 0;
      if (fs.existsSync(file)) {
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
          throw new Error('日志文件不是独立普通文件');
        size = stat.size;
      }
      if (size >= maxBytes) {
        for (let i = copies; i >= 1; i--) {
          const previous = i === 1 ? file : path.join(directory, `${name}.${i - 1}.log`);
          const next = path.join(directory, `${name}.${i}.log`);
          if (fs.existsSync(next)) fs.unlinkSync(next);
          if (fs.existsSync(previous)) fs.renameSync(previous, next);
        }
        size = 0;
      }
      const end = Math.min(data.length, offset + maxBytes - size);
      fs.appendFileSync(file, data.subarray(offset, end));
      offset = end;
    }
  };
}

export function pruneLogs(directory: string, now = Date.now(), budget = 256 * 1024 * 1024) {
  const files = fs
    .readdirSync(directory)
    .filter((name) => /^(server|caddy|codex)[-.].*\.log$/.test(name))
    .map((name) => ({
      file: path.join(directory, name),
      stat: fs.lstatSync(path.join(directory, name)),
    }))
    .filter(({ stat }) => stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1)
    .sort((a, b) => a.stat.mtimeMs - b.stat.mtimeMs);
  let bytes = files.reduce((n, f) => n + f.stat.size, 0);
  for (const { file, stat } of files) {
    if (stat.mtimeMs < now - 14 * 86400000 || bytes > budget) {
      // In-place truncation also supports old PowerShell redirect handles.
      fs.truncateSync(file, 0);
      bytes -= stat.size;
      if (stat.mtimeMs < now - 14 * 86400000) {
        try {
          fs.unlinkSync(file);
        } catch {
          /* A legacy handle may still own it. */
        }
      }
    }
  }
}
