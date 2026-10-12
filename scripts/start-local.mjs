import 'dotenv/config';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

process.chdir(fileURLToPath(new URL('../', import.meta.url)));
if (!existsSync('dist/server/index.js')) throw new Error('请先运行 npm run build');
// A loopback-only production build for everyday use on this machine.
process.env.HOST = '127.0.0.1';
process.env.PORT = '18473';
process.env.PUBLIC_ORIGIN = 'http://127.0.0.1:18473';
process.env.COOKIE_SECURE = 'false';
process.env.TRUST_PROXY = 'false';
await import('../dist/server/index.js');
