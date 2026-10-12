import 'dotenv/config';
import path from 'node:path';
import { z } from 'zod';
import { EnvHttpProxyAgent, setGlobalDispatcher } from 'undici';

// dotenv runs after Node startup, so NODE_USE_ENV_PROXY alone cannot enable
// proxies loaded from .env. Configure fetch here before any upstream requests.
// CodexBridge passes the same environment to the provider process.
const httpProxy = process.env.http_proxy ?? process.env.HTTP_PROXY;
const httpsProxy = process.env.https_proxy ?? process.env.HTTPS_PROXY;
if (httpProxy || httpsProxy) {
  try {
    for (const proxy of [httpProxy, httpsProxy]) {
      if (proxy && !['http:', 'https:'].includes(new URL(proxy).protocol))
        throw new Error('Unsupported proxy protocol');
    }
    setGlobalDispatcher(new EnvHttpProxyAgent());
  } catch {
    // Proxy URLs may contain credentials; do not echo them in startup errors.
    throw new Error('Invalid HTTP_PROXY or HTTPS_PROXY: expected an HTTP(S) proxy URL');
  }
}

const env = z
  .object({
    HOST: z.string().default('127.0.0.1'),
    PORT: z.coerce.number().int().min(1).max(65535).default(18474),
    DATA_DIR: z.string().default('./data'),
    PUBLIC_ORIGIN: z.string().url().default('http://127.0.0.1:18473'),
    COOKIE_SECURE: z.enum(['true', 'false']).default('false'),
    TRUST_PROXY: z.enum(['true', 'false']).default('false'),
    SESSION_DAYS: z.coerce.number().int().min(1).max(90).default(7),
    MAX_CONCURRENT_TURNS: z.coerce.number().int().min(1).max(16).default(3),
    EVENT_RETENTION_DAYS: z.coerce.number().int().min(1).max(30).default(7),
    CODEX_BIN: z.string().optional(),
    PROJECT_ROOTS: z.string().default(path.parse(process.cwd()).root),
  })
  .parse(process.env);
export const config = {
  host: env.HOST,
  port: env.PORT,
  dataDir: path.resolve(env.DATA_DIR),
  origin: new URL(env.PUBLIC_ORIGIN).origin,
  secure: env.COOKIE_SECURE === 'true',
  trustProxy: env.TRUST_PROXY === 'true',
  sessionDays: env.SESSION_DAYS,
  maxConcurrent: env.MAX_CONCURRENT_TURNS,
  eventDays: env.EVENT_RETENTION_DAYS,
  codexBin: env.CODEX_BIN,
  projectRoots: env.PROJECT_ROOTS.split(';')
    .filter(Boolean)
    .map((p) => path.resolve(p)),
};
if (new URL(config.origin).protocol === 'https:' && !config.secure)
  throw new Error('HTTPS requires COOKIE_SECURE=true');
if (!['http:', 'https:'].includes(new URL(config.origin).protocol))
  throw new Error('PUBLIC_ORIGIN must use HTTP or HTTPS');
if (
  !['localhost', '127.0.0.1', '[::1]'].includes(new URL(config.origin).hostname) &&
  (new URL(config.origin).protocol !== 'https:' || !config.secure)
) {
  throw new Error('Public access requires HTTPS and COOKIE_SECURE=true');
}
