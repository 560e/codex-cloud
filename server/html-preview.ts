import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Auth } from './auth.js';
import { safePath } from './files.js';
import { fail } from './workbench.js';
import { config } from './config.js';

export const htmlPreviewAssetRoute = '/api/html-preview/:token/*';
const types: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
};

export function htmlPreviewRoutes(
  app: FastifyInstance,
  auth: Auth,
  resolve: (scope: { project?: string; thread?: string }) => Promise<string>,
) {
  // Short-lived capabilities let opaque-origin sandbox frames load assets without session cookies.
  // Every asset request also verifies the originating login session, including after logout.
  const grants = new Map<string, { cwd: string; session: string; expires: number }>();
  app.post('/api/html-preview', async (request) => {
    const body = z
      .object({
        project: z.string().max(200).optional(),
        thread: z.string().max(200).optional(),
        path: z.string().min(1).max(3000),
      })
      .parse(request.body);
    if (!/\.html?$/i.test(body.path)) throw fail('请选择 HTML 文件');
    const cwd = await resolve(body);
    const file = await safePath(cwd, body.path);
    const stat = await fs.stat(file);
    if (!stat.isFile()) throw fail('只能预览普通文件');
    if (stat.size > 2 * 1024 * 1024) throw fail('HTML 文件超过 2 MB，请下载查看', 413);
    for (const [key, value] of grants)
      if (value.expires < Date.now() || !auth.valid(value.session)) grants.delete(key);
    while (grants.size >= 64) grants.delete(grants.keys().next().value!);
    const session = request.cookies.codex_workbench;
    if (!session || !auth.valid(session)) throw fail('请先登录工作台', 401);
    const token = randomBytes(32).toString('hex');
    grants.set(token, {
      cwd,
      session,
      expires: Date.now() + 60 * 60_000,
    });
    const relative = path
      .relative(await fs.realpath(cwd), file)
      .split(path.sep)
      .map(encodeURIComponent)
      .join('/');
    return { url: `/api/html-preview/${token}/${relative}` };
  });
  app.get<{ Params: { token: string; '*': string } }>(
    htmlPreviewAssetRoute,
    async (request, reply) => {
      const grant = grants.get(request.params.token);
      if (!grant || grant.expires < Date.now() || !auth.valid(grant.session)) {
        grants.delete(request.params.token);
        throw fail('预览已过期，请刷新预览或重新登录', 401);
      }
      const relative = request.params['*'];
      if (
        relative
          .split(/[\\/]/)
          .some((part) => part.startsWith('.') && part !== '..' && part !== '.')
      )
        throw fail('预览不能读取隐藏文件', 403);
      const mime = types[path.extname(relative).toLowerCase()];
      if (!mime) throw fail('预览只提供 HTML、样式、脚本、图片、字体和音视频文件', 415);
      const file = await safePath(grant.cwd, relative);
      const realRelative = path.relative(await fs.realpath(grant.cwd), file);
      if (
        realRelative.split(path.sep).some((part) => part.startsWith('.')) ||
        types[path.extname(file).toLowerCase()] !== mime
      )
        throw fail('预览不能读取此文件', 403);
      const stat = await fs.stat(file);
      if (!stat.isFile()) throw fail('只能预览普通文件');
      if (stat.size > (mime.startsWith('text/html') ? 2 : 20) * 1024 * 1024)
        throw fail('预览资源过大，请下载查看', 413);
      const base = `${config.origin}/api/html-preview/${request.params.token}/`;
      reply
        .type(mime)
        .header('Cache-Control', 'no-store')
        .header('X-Frame-Options', 'SAMEORIGIN')
        .header('Access-Control-Allow-Origin', 'null')
        .header(
          'Content-Security-Policy',
          `sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' ${base} https:; style-src 'unsafe-inline' ${base} https:; img-src ${base} https: data: blob:; font-src ${base} https: data:; media-src ${base} blob:; connect-src ${base}; frame-src 'none'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'`,
        );
      return reply.send(createReadStream(file));
    },
  );
  app.addHook('onClose', async () => {
    grants.clear();
  });
}
