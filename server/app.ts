import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import websocket from '@fastify/websocket';
import multipart from '@fastify/multipart';
import staticFiles from '@fastify/static';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { WebSocket } from 'ws';
import { Auth } from './auth.js';
import { config } from './config.js';
import type { Store } from './store.js';
import { Workbench, fail } from './workbench.js';
import {
  gitDiff,
  listFiles,
  listProjectDirectories,
  projectPath,
  readText,
  safePath,
  resolveFileLink,
} from './files.js';
import type { WorkEvent } from '../shared/types.js';
import { clearLogs, logFiles } from './maintenance.js';
import { providerInput } from './providers.js';
import { projectContextSchema } from './project-context.js';
import { queryBalance } from './balance.js';
import { reviewTargetSchema } from '../shared/protocol.js';
import { imageMime, imagePreviewLimit } from '../shared/image-preview.js';
import { managementRoutes } from './management-api.js';
import { htmlPreviewRoutes, htmlPreviewAssetRoute } from './html-preview.js';
import { completeConversation, renderConversation } from './conversation-export.js';
import { Continuity } from './continuity.js';

const idSchema = z.string().min(1).max(200);
const threadOptions = z.object({
  model: z.string().max(200).optional(),
  approvalPolicy: z.enum(['untrusted', 'on-request', 'never']).optional(),
  sandbox: z.enum(['read-only', 'workspace-write', 'danger-full-access']).optional(),
});
const cookieName = 'codex_workbench';
export async function buildApp(
  store: Store,
  workbench: Workbench,
  options: { logger?: boolean; staticRoot?: string } = {},
) {
  const app = Fastify({
    logger: options.logger ?? true,
    bodyLimit: 1024 * 1024,
    trustProxy: config.trustProxy ? ['127.0.0.1', '::1'] : false,
  });
  const auth = new Auth(store);
  const continuity = new Continuity(store, workbench);
  workbench.continuity = continuity;
  let providerChanging = false;
  const requireProviderIdle = () => {
    if (providerChanging) throw fail('供应商正在切换，请稍后重试', 409);
  };
  const sockets = new Map<WebSocket, string>();
  let uploads = 0;
  let searches = 0;
  let exporting = false;
  await app.register(cookie);
  await app.register(websocket, { options: { maxPayload: 4096 } });
  await app.register(multipart, { limits: { fileSize: 20 * 1024 * 1024, files: 1, fields: 0 } });
  const cookieOptions = {
    path: '/',
    httpOnly: true,
    secure: config.secure,
    sameSite: 'strict' as const,
  };

  app.addHook('onRequest', async (request, reply) => {
    reply
      .header('X-Content-Type-Options', 'nosniff')
      .header('X-Frame-Options', 'DENY')
      .header('Referrer-Policy', 'no-referrer')
      .header('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet, noimageindex');
    reply.header(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    );
    const route = request.routeOptions.url || request.url.split('?')[0];
    if (!route.startsWith('/api/')) return;
    reply.header('Cache-Control', 'no-store');
    if (!['GET', 'HEAD'].includes(request.method) || route === '/api/events') {
      if (request.headers.origin !== config.origin)
        throw fail('来源校验失败，请使用配置的工作台地址访问', 403);
    }
    const publicRoute = ['/api/auth/status', '/api/auth/login', htmlPreviewAssetRoute].includes(
      route,
    );
    if (!publicRoute && !auth.valid(request.cookies[cookieName])) throw fail('请先登录工作台', 401);
    if (
      route.startsWith('/api/providers') &&
      providerChanging &&
      !['GET', 'HEAD'].includes(request.method)
    )
      throw fail('供应商正在切换，请稍后重试', 409);
  });
  app.setErrorHandler((error: Error & { statusCode?: number; code?: string }, request, reply) => {
    if (error instanceof z.ZodError)
      return reply
        .code(400)
        .send({ error: error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
    const status = error.statusCode || (error.code === 'ENOENT' ? 404 : 500);
    if (status >= 500) request.log.error({ message: error.message }, 'Request failed');
    reply.code(status).send({ error: error.message || '服务暂时不可用' });
  });
  app.get('/api/auth/status', async (request) => ({
    apiVersion: 4,
    authenticated: auth.valid(request.cookies[cookieName]),
    configured: !!store.get('passwordHash'),
  }));
  app.get('/robots.txt', async (_request, reply) =>
    reply.type('text/plain; charset=utf-8').send('User-agent: *\nDisallow: /\n'),
  );
  app.post('/api/auth/login', async (request, reply) => {
    if (!store.get('passwordHash')) throw fail('请先在服务器运行 npm run password 设置密码', 503);
    const body = z
      .object({ password: z.string().min(1).max(1024), remember: z.boolean().default(true) })
      .parse(request.body);
    const ttl = (body.remember ? config.sessionDays * 24 : 12) * 3600000;
    const token = await auth.login(body.password, request.ip, ttl);
    reply.setCookie(cookieName, token, {
      ...cookieOptions,
      ...(body.remember ? { maxAge: ttl / 1000 } : {}),
    });
    return { ok: true };
  });
  app.post('/api/auth/logout', async (request, reply) => {
    const token = request.cookies[cookieName];
    auth.logout(token);
    for (const [socket, session] of sockets)
      if (session === token) socket.close(4001, 'Logged out');
    reply.clearCookie(cookieName, cookieOptions);
    return { ok: true };
  });
  app.post('/api/auth/password', async (request, reply) => {
    const body = z
      .object({ current: z.string().max(1024), password: z.string().min(8).max(1024) })
      .parse(request.body);
    const expected = await auth.authenticate(body.current, request.ip).catch((error) => {
      if (error.statusCode === 401) throw fail('当前密码不正确', 400);
      throw error;
    });
    await auth.change(body.password, expected);
    for (const socket of sockets.keys()) socket.close(4001, 'Password changed');
    reply.clearCookie(cookieName, cookieOptions);
    return { ok: true };
  });
  app.get('/api/status', async () => ({
    ...workbench.status(),
    settings: {
      origin: config.origin,
      sessionDays: config.sessionDays,
      maxConcurrent: config.maxConcurrent,
      projectRoots: config.projectRoots,
      testedCli: '0.155.1',
    },
  }));
  const featureSchema = z
    .object({ memory: z.boolean().optional(), collaboration: z.boolean().optional() })
    .refine(
      (value) => value.memory !== undefined || value.collaboration !== undefined,
      '至少指定一个功能开关',
    );
  const memoryInput = z.object({
    projectId: idSchema.nullable(),
    content: z.string().trim().min(1).max(4000),
    sourceThreadId: idSchema.nullable().optional(),
  });
  const memberSchema = z.object({
    threadId: idSchema,
    instruction: z.string().max(4000),
    nextThreadId: idSchema.optional(),
  });
  const groupInput = z.object({
    name: z.string().trim().min(1).max(120),
    goal: z.string().trim().min(1).max(8000),
    members: z.array(memberSchema).min(2).max(8),
    maxSteps: z.number().int().min(2).max(30),
  });
  app.get('/api/features', async () => continuity.settings());
  app.put('/api/features', async (request) => {
    const body = featureSchema.parse(request.body);
    if (body.memory !== undefined) continuity.setFeature('memory', body.memory);
    if (body.collaboration !== undefined)
      continuity.setFeature('collaboration', body.collaboration);
    return continuity.settings();
  });
  app.get('/api/memories', async (request) => {
    const { projectId } = z.object({ projectId: idSchema.optional() }).parse(request.query);
    return continuity.memories(projectId);
  });
  app.post('/api/memories', async (request) => {
    continuity.requireFeature('memory');
    const body = memoryInput.parse(request.body);
    if (body.sourceThreadId) {
      const cwd = await workbench.threadDirectory(body.sourceThreadId);
      if (body.projectId !== null && body.projectId !== store.projectForDirectory(cwd)?.id)
        throw fail('来源会话与记忆项目不匹配', 400);
    }
    return continuity.addMemory(body.projectId, body.content, body.sourceThreadId);
  });
  app.patch<{ Params: { id: string } }>('/api/memories/:id', async (request) =>
    continuity.updateMemory(
      idSchema.parse(request.params.id),
      z
        .object({
          content: z.string().trim().min(1).max(4000).optional(),
          enabled: z.boolean().optional(),
          projectId: idSchema.nullable().optional(),
        })
        .parse(request.body),
    ),
  );
  app.delete<{ Params: { id: string } }>('/api/memories/:id', async (request) =>
    continuity.deleteMemory(idSchema.parse(request.params.id)),
  );
  app.get<{ Params: { id: string; turnId: string } }>(
    '/api/threads/:id/turns/:turnId/memories',
    async (request) =>
      continuity.memoryUse(
        idSchema.parse(request.params.id),
        idSchema.parse(request.params.turnId),
      ),
  );
  app.get('/api/collaborations', async () => continuity.groups());
  app.post('/api/collaborations', async (request) =>
    continuity.saveGroup(groupInput.parse(request.body)),
  );
  app.get<{ Params: { id: string } }>('/api/collaborations/:id', async (request) =>
    continuity.group(idSchema.parse(request.params.id)),
  );
  app.put<{ Params: { id: string } }>('/api/collaborations/:id', async (request) =>
    continuity.saveGroup(groupInput.parse(request.body), idSchema.parse(request.params.id)),
  );
  app.delete<{ Params: { id: string } }>('/api/collaborations/:id', async (request) =>
    continuity.deleteGroup(idSchema.parse(request.params.id)),
  );
  app.get<{ Params: { id: string } }>('/api/collaborations/:id/runs', async (request) =>
    continuity.runs(idSchema.parse(request.params.id)),
  );
  app.post<{ Params: { id: string } }>('/api/collaborations/:id/runs', async (request) => {
    const { prompt } = z.object({ prompt: z.string().trim().min(1).max(8000) }).parse(request.body);
    return continuity.start(idSchema.parse(request.params.id), prompt);
  });
  app.get<{ Params: { id: string } }>('/api/collaboration-runs/:id', async (request) =>
    continuity.run(idSchema.parse(request.params.id)),
  );
  app.get<{ Params: { id: string } }>('/api/collaboration-runs/:id/handoffs', async (request) =>
    continuity.handoffs(idSchema.parse(request.params.id)),
  );
  app.post<{ Params: { id: string } }>('/api/collaboration-runs/:id/actions', async (request) => {
    const { action } = z
      .object({ action: z.enum(['pause', 'resume', 'stop']) })
      .parse(request.body);
    return continuity.action(idSchema.parse(request.params.id), action);
  });
  app.post('/api/connect', async () => {
    await workbench.connect();
    return workbench.status();
  });
  app.get('/api/providers/access', async () => ({
    configured: true,
    unlocked: true,
    expiresAt: null,
    active: workbench.providers.summary(),
  }));
  // Compatibility for older clients; management now uses the website login session.
  app.post('/api/providers/unlock', async () => ({ ok: true }));
  app.post('/api/providers/lock', async () => ({ ok: true }));
  app.get('/api/providers', async () => ({
    profiles: workbench.providers.list(),
    activeId: workbench.providers.activeId(),
  }));
  app.get<{ Params: { id: string } }>('/api/providers/:id/balance', async (request) => {
    const id = idSchema.parse(request.params.id);
    return queryBalance(workbench.providers.runtime(id === 'default' ? null : id));
  });
  app.post<{ Params: { id: string } }>('/api/providers/:id/models/refresh', async (request) => {
    requireProviderIdle();
    const profile = await workbench.providers.refreshModels(idSchema.parse(request.params.id));
    workbench.publish('workbench/providerModelsUpdated', { providerId: profile.id });
    return profile;
  });
  app.post('/api/providers', async (request) => {
    requireProviderIdle();
    return workbench.providers.save(providerInput.parse(request.body));
  });
  app.put<{ Params: { id: string } }>('/api/providers/:id', async (request) => {
    requireProviderIdle();
    const input = providerInput.parse(request.body);
    providerChanging = true;
    try {
      return await workbench.saveProvider(input, idSchema.parse(request.params.id));
    } finally {
      providerChanging = false;
    }
  });
  app.delete<{ Params: { id: string } }>('/api/providers/:id', async (request) => {
    requireProviderIdle();
    workbench.providers.remove(idSchema.parse(request.params.id));
    return { ok: true };
  });
  app.post('/api/providers/active', async (request) => {
    requireProviderIdle();
    const { id } = z.object({ id: z.string().uuid().nullable() }).parse(request.body);
    providerChanging = true;
    try {
      return await workbench.switchProvider(id);
    } finally {
      providerChanging = false;
    }
  });
  app.get('/api/maintenance', async () => {
    const logs = await logFiles(store);
    return {
      directory: store.dir,
      events: Number(store.db.prepare('SELECT COUNT(*) AS count FROM events').get()!.count),
      logFiles: logs.length,
      logBytes: logs.reduce((sum, file) => sum + file.size, 0),
      pendingDeletions: store.db.prepare('SELECT thread_id AS id FROM thread_deletions').all(),
    };
  });
  app.post('/api/maintenance', async (request) => {
    const body = z
      .object({ action: z.enum(['cache', 'logs']), confirm: z.literal(true) })
      .parse(request.body);
    return body.action === 'cache' ? workbench.clearCache() : clearLogs(store);
  });
  app.delete<{ Params: { id: string } }>('/api/threads/:id', async (request) => {
    z.object({ confirm: z.literal(true) }).parse(request.body);
    const id = idSchema.parse(request.params.id);
    if (
      store.db
        .prepare('SELECT members FROM collaboration_groups')
        .all()
        .some((row) =>
          (JSON.parse(String(row.members)) as { threadId: string }[]).some(
            (member) => member.threadId === id,
          ),
        )
    )
      throw fail('会话已加入协作组，请先从协作组移除', 409);
    const result = await workbench.deleteThread(id);
    store.db.prepare('DELETE FROM memories WHERE source_thread_id=?').run(id);
    return result;
  });
  app.get('/api/usage', async (request) => {
    const { since, project, thread, page } = z
      .object({
        since: z.coerce.number().finite().nonnegative().default(0),
        project: z.string().max(200).optional(),
        thread: z.string().max(200).optional(),
        page: z.coerce.number().int().min(1).max(1000000).default(1),
      })
      .parse(request.query);
    return store.usageStats(since, { project, thread, page });
  });
  app.get('/api/models', async () => {
    return workbench.models();
  });
  app.get('/api/capabilities', async () => workbench.capabilities());
  app.get('/api/account', async () => {
    if (workbench.providers.activeId())
      return { requiresOpenaiAuth: false, account: { type: '自定义供应商' } };
    await workbench.connect();
    const result = await workbench.bridge.call('account/read', {});
    // Never expose authentication tokens, even if upstream adds new fields.
    return {
      requiresOpenaiAuth: result.requiresOpenaiAuth,
      account: result.account
        ? {
            type: result.account.type,
            email: result.account.email,
            planType: result.account.planType,
          }
        : null,
    };
  });
  app.get('/api/project-directories', async (request) => {
    const query = z.object({ path: z.string().min(1).max(2000) }).parse(request.query);
    return listProjectDirectories(query.path, config.projectRoots);
  });
  app.get('/api/projects', async () => store.projects());
  app.put<{ Params: { id: string } }>('/api/projects/:id/prompt', async (request) => {
    const body = z.object({ systemPrompt: z.string().max(50000) }).parse(request.body);
    const project = store.projects().find((item) => item.id === request.params.id);
    if (!project) throw fail('项目不存在', 404);
    store.set(`projectPrompt:${project.id}`, body.systemPrompt);
    workbench.publish('workbench/projectsChanged', {});
    return { ...project, systemPrompt: body.systemPrompt };
  });
  app.post('/api/projects', async (request) => {
    const body = z
      .object({
        name: z.string().trim().min(1).max(80),
        path: z.string().min(1).max(2000),
        create: z.boolean().default(false),
      })
      .extend(projectContextSchema.shape)
      .parse(request.body);
    const cwd = await projectPath(body.path, config.projectRoots, body.create);
    if (
      store
        .projects()
        .some((p) =>
          process.platform === 'win32'
            ? p.path.toLowerCase() === cwd.toLowerCase()
            : p.path === cwd,
        )
    )
      throw fail('项目目录已添加', 409);
    const result = store.addProject(body.name, cwd, body);
    workbench.publish('workbench/projectsChanged', {});
    return result;
  });
  app.delete<{ Params: { id: string } }>('/api/projects/:id', async (request) => {
    const project = store.projects().find((p) => p.id === request.params.id);
    if (!project) throw fail('项目不存在', 404);
    if (
      [...workbench.active.values()].some((r) =>
        process.platform === 'win32'
          ? r.cwd.toLowerCase() === project.path.toLowerCase()
          : r.cwd === project.path,
      )
    )
      throw fail('项目正在运行任务', 409);
    for (const row of store.db.prepare('SELECT members FROM collaboration_groups').all())
      for (const member of JSON.parse(String(row.members)) as { threadId: string }[])
        if (
          await workbench.threadDirectory(member.threadId).then(
            (cwd) => cwd === project.path,
            () => false,
          )
        )
          throw fail('项目中有会话已加入协作组，请先移除', 409);
    store.db.prepare('DELETE FROM projects WHERE id=?').run(project.id);
    store.db.prepare('DELETE FROM memories WHERE project_id=?').run(project.id);
    store.db.prepare('DELETE FROM settings WHERE key=?').run(`projectPrompt:${project.id}`);
    store.db.prepare('DELETE FROM settings WHERE key=?').run(`projectContext:${project.id}`);
    workbench.publish('workbench/projectsChanged', {});
    return { ok: true };
  });
  app.get('/api/threads', async (request) => {
    const q = z
      .object({
        cursor: z.string().optional(),
        search: z.string().max(200).optional(),
        archived: z.enum(['true', 'false']).optional(),
        project: z.string().optional(),
      })
      .parse(request.query);
    const project = q.project ? store.projects().find((p) => p.id === q.project) : undefined;
    if (q.project && !project) throw fail('项目不存在', 404);
    return workbench.list({
      cursor: q.cursor,
      archived: q.archived === 'true',
      searchTerm: q.search || undefined,
      cwd: project?.path,
    });
  });
  app.post('/api/threads', async (request) => {
    const body = threadOptions.extend({ projectId: idSchema }).parse(request.body);
    const project = store.projects().find((p) => p.id === body.projectId);
    if (!project) throw fail('请先选择一个项目');
    const { projectId, ...opts } = body;
    await projectPath(project.path, config.projectRoots, false);
    return workbench.create(project.path, { sandbox: 'danger-full-access', ...opts });
  });
  app.get<{ Params: { id: string }; Querystring: { cursor?: string } }>(
    '/api/threads/:id',
    async (request) => workbench.read(idSchema.parse(request.params.id), request.query.cursor),
  );
  app.get<{ Params: { id: string } }>('/api/threads/:id/export', async (request, reply) => {
    const id = idSchema.parse(request.params.id);
    const { format } = z
      .object({ format: z.enum(['txt', 'markdown', 'html']) })
      .parse(request.query);
    if (exporting) throw fail('已有会话正在导出，请稍后重试', 429);
    exporting = true;
    const controller = new AbortController();
    const abort = () => controller.abort();
    reply.raw.on('close', abort);
    try {
      const thread = await completeConversation(
        (cursor) => workbench.read(id, cursor, { refreshBalance: false }),
        controller.signal,
      );
      const result = renderConversation(thread, format);
      return reply
        .type(result.contentType)
        .header('Content-Disposition', `attachment; filename="${result.filename}"`)
        .send(result.content);
    } finally {
      reply.raw.off('close', abort);
      exporting = false;
    }
  });
  app.post<{ Params: { id: string } }>('/api/threads/:id/action', async (request) => {
    const body = z
      .object({
        action: z.enum(['archive', 'unarchive', 'fork', 'rename', 'pin']),
        name: z.string().trim().min(1).max(120).optional(),
        pinned: z.boolean().optional(),
      })
      .parse(request.body);
    if (body.action === 'pin') {
      return workbench.exclusive(request.params.id, async () => {
        if (store.deletion(request.params.id)) throw fail('此会话正在删除，请先完成清理', 409);
        await workbench.connect();
        await workbench.bridge.call('thread/read', {
          threadId: request.params.id,
          includeTurns: false,
        });
        store.pin(request.params.id, !!body.pinned);
        workbench.publish('workbench/threadsChanged', {});
        return { ok: true };
      });
    }
    if (body.action === 'rename' && !body.name) throw fail('请输入名称');
    return workbench.action(request.params.id, body.action, body.name);
  });
  app.post<{ Params: { id: string } }>('/api/threads/:id/native-task', async (request) => {
    const body = z
      .discriminatedUnion('type', [
        z.object({ type: z.literal('review'), target: reviewTargetSchema }),
        z.object({ type: z.literal('compact') }),
      ])
      .parse(request.body);
    try {
      return await workbench.send(
        idSchema.parse(request.params.id),
        [],
        {},
        false,
        false,
        undefined,
        body,
      );
    } catch (error) {
      if ((error as { rpcCode?: number }).rpcCode === -32601)
        throw fail('当前 CLI 不支持此原生功能，请检查版本', 501);
      throw error;
    }
  });
  app.get('/api/file-search', async (request) => {
    const q = z
      .object({
        query: z.string().trim().min(1).max(200),
        thread: idSchema.optional(),
        project: idSchema.optional(),
      })
      .refine((v) => Boolean(v.thread) !== Boolean(v.project), '请选择一个项目或会话')
      .parse(request.query);
    if (searches >= 4) throw fail('搜索请求过多，请稍后重试', 429);
    searches++;
    try {
      const directory = q.thread
        ? await workbench.threadDirectory(q.thread)
        : store.projects().find((p) => p.id === q.project)?.path;
      if (!directory) throw fail('项目不存在', 404);
      const cwd = await projectPath(directory, config.projectRoots, false);
      const result = await workbench.searchFiles(cwd, q.query);
      const files: { path: string; name: string }[] = [];
      const seen = new Set<string>();
      for (const entry of result.files.slice(0, 200)) {
        if (entry.match_type !== 'file') continue;
        try {
          if ((await fs.realpath(entry.root)) !== cwd) continue;
          const file = await safePath(cwd, entry.path);
          if (!(await fs.stat(file)).isFile()) continue;
          const relative = path.relative(cwd, file).split(path.sep).join('/');
          if (!seen.has(relative)) files.push({ path: relative, name: path.basename(file) });
          seen.add(relative);
          if (files.length >= 50) break;
        } catch {
          /* Ignore stale, escaped or inaccessible matches. */
        }
      }
      return { files };
    } catch (error) {
      if ((error as { rpcCode?: number }).rpcCode === -32601)
        throw fail('当前 CLI 不支持文件搜索，请检查版本', 501);
      throw error;
    } finally {
      searches--;
    }
  });
  app.post<{ Params: { id: string } }>('/api/threads/:id/messages', async (request) => {
    const body = z
      .object({
        text: z.string().max(100000),
        attachments: z.array(idSchema).max(10).default([]),
        steer: z.boolean().default(false),
        enqueue: z.boolean().default(false),
        references: z.array(z.string().min(1).max(100000)).max(5).default([]),
        fileReferences: z.array(z.string().min(1).max(3000)).max(10).default([]),
        model: z.string().max(200).optional(),
        effort: z
          .enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
          .optional(),
      })
      .parse(request.body);
    const input: Record<string, unknown>[] = [];
    if (!body.text.trim() && !body.attachments.length) throw fail('请输入消息或添加附件');
    if (body.steer && body.enqueue) throw fail('不能同时加入队列和补充当前任务');
    if (body.fileReferences.length) {
      const cwd = await projectPath(
        await workbench.threadDirectory(request.params.id),
        config.projectRoots,
        false,
      );
      for (const relative of new Set(body.fileReferences)) {
        const file = await safePath(cwd, relative);
        if (!(await fs.stat(file)).isFile()) throw fail('引用路径不是文件');
        input.push({
          type: 'text',
          text: `用户引用的项目文件（按需读取）：\n${file}`,
          text_elements: [],
        });
      }
    }
    for (const reference of body.references)
      input.push({
        type: 'text',
        text: `引用的对话内容（供本次提问参考）：\n${reference}`,
        text_elements: [],
      });
    const textIndex = body.text.trim() ? input.length : -1;
    if (body.text.trim()) input.push({ type: 'text', text: body.text, text_elements: [] });
    for (const id of body.attachments) {
      const file = store.db
        .prepare('SELECT * FROM attachments WHERE id=? AND thread_id=?')
        .get(id, request.params.id);
      if (!file || file.state === 'deleting') throw fail('附件不存在、正在移除或不属于此会话');
      if (
        String(file.mime).startsWith('image/') &&
        ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(String(file.mime))
      )
        input.push({ type: 'localImage', path: file.path });
      else
        input.push({
          type: 'text',
          text: `用户上传的文件：${file.name}\n服务器绝对路径：${file.path}\n请根据任务需要读取该文件。`,
          text_elements: [],
        });
    }
    if (!input.length) throw fail('请输入消息或添加附件');
    // Claim synchronously at the actual submission boundary, after directory,
    // capacity and queue checks. Failed validation leaves drafts removable.
    const claimAttachments = () => {
      for (const id of body.attachments) {
        const row = store.db
          .prepare('SELECT state FROM attachments WHERE id=? AND thread_id=?')
          .get(id, request.params.id);
        if (!row || row.state === 'deleting') throw fail('附件已被移除，请重新上传', 409);
      }
      for (const id of body.attachments)
        store.db
          .prepare("UPDATE attachments SET state='used' WHERE id=? AND thread_id=?")
          .run(id, request.params.id);
    };
    if (body.enqueue)
      return workbench.enqueue(
        request.params.id,
        input,
        { model: body.model, effort: body.effort },
        body.text || '附件消息',
        claimAttachments,
        textIndex,
      );
    return workbench.send(
      request.params.id,
      input,
      { model: body.model, effort: body.effort },
      body.steer,
      false,
      claimAttachments,
      undefined,
      body.text || '附件消息',
      textIndex,
    );
  });
  app.post<{ Params: { id: string } }>('/api/threads/:id/interrupt', async (request) =>
    workbench.interrupt(request.params.id),
  );
  app.get<{ Params: { id: string } }>('/api/queue/:id', async (request) =>
    workbench.queueMessage(idSchema.parse(request.params.id)),
  );
  app.patch<{ Params: { id: string } }>('/api/queue/:id', async (request) => {
    const body = z
      .object({ text: z.string().max(100000), revision: z.string().regex(/^[a-f0-9]{64}$/) })
      .parse(request.body);
    return workbench.editQueue(idSchema.parse(request.params.id), body.text, body.revision);
  });
  app.post<{ Params: { id: string } }>('/api/queue/:id', async (request) => {
    const body = z.object({ action: z.enum(['cancel', 'resume']) }).parse(request.body);
    return workbench.queueAction(request.params.id, body.action);
  });
  app.post('/api/runtime/force-stop', async () => workbench.forceStop());
  app.post<{ Params: { id: string } }>('/api/requests/:id', async (request) => {
    const body = z
      .object({
        decision: z.string().optional(),
        answers: z.record(z.string(), z.string().max(16000)).optional(),
        content: z.unknown().optional(),
      })
      .parse(request.body);
    workbench.answer(request.params.id, body);
    return { ok: true };
  });
  app.post<{ Params: { id: string } }>('/api/threads/:id/attachments', async (request) => {
    if (uploads >= 4) throw fail('正在上传的文件过多，请稍后重试', 429);
    uploads++;
    try {
      return await workbench.exclusive(request.params.id, async () => {
        if (store.deletion(request.params.id)) throw fail('此会话正在删除，请先完成清理', 409);
        await workbench.connect();
        await workbench.bridge.call('thread/read', {
          threadId: request.params.id,
          includeTurns: false,
        });
        const part = await request.file();
        if (!part) throw fail('请选择文件');
        const usage = store.db
          .prepare('SELECT COUNT(*) AS count,COALESCE(SUM(size),0) AS bytes FROM attachments')
          .get()!;
        const pending = store.db
          .prepare(
            "SELECT COUNT(*) AS count FROM attachments WHERE thread_id=? AND state='pending'",
          )
          .get(request.params.id)!;
        if (Number(pending.count) >= 10)
          throw fail('待发送附件最多 10 个，请先发送或移除附件', 409);
        if (Number(usage.count) >= 10000 || Number(usage.bytes) >= 1024 * 1024 * 1024)
          throw fail('附件存储已达上限，请清理不再需要的会话或待发送附件', 413);
        const data = await part.toBuffer();
        const id = randomUUID();
        const name =
          path.basename(part.filename.replaceAll('\\', '/')).slice(0, 180) || 'attachment';
        const dir = path.join(store.dir, 'uploads', id);
        await fs.mkdir(dir, { recursive: true });
        const file = path.join(dir, name.replace(/[<>:"|?*\x00-\x1f]/g, '_'));
        try {
          await fs.writeFile(file, data);
          // Recheck after I/O, then insert without yielding so concurrent uploads
          // cannot jointly exceed the global storage budget.
          const current = store.db
            .prepare('SELECT COUNT(*) AS count,COALESCE(SUM(size),0) AS bytes FROM attachments')
            .get()!;
          if (
            Number(current.count) >= 10000 ||
            Number(current.bytes) + data.length > 1024 * 1024 * 1024
          )
            throw fail('附件存储已达上限，请清理不再需要的会话或待发送附件', 413);
          store.db
            .prepare(
              "INSERT INTO attachments(id,thread_id,name,mime,size,path,state) VALUES(?,?,?,?,?,?,'pending')",
            )
            .run(id, request.params.id, name, part.mimetype, data.length, file);
        } catch (error) {
          await fs.rm(dir, { recursive: true, force: true });
          throw error;
        }
        return { id, name, mime: part.mimetype, size: data.length };
      });
    } finally {
      uploads--;
    }
  });
  app.get<{ Params: { id: string } }>('/api/threads/:id/attachments', async (request) =>
    store.db
      .prepare("SELECT id,name,mime,size FROM attachments WHERE thread_id=? AND state='pending'")
      .all(request.params.id),
  );
  app.delete<{ Params: { id: string; attachmentId: string } }>(
    '/api/threads/:id/attachments/:attachmentId',
    async (request) =>
      workbench.exclusive(request.params.id, async () => {
        const row = store.db
          .prepare('SELECT * FROM attachments WHERE id=? AND thread_id=?')
          .get(request.params.attachmentId, request.params.id);
        if (!row) throw fail('附件不存在', 404);
        if (row.state !== 'pending') throw fail('此附件已提交，需随会话历史保留', 409);
        const directories = await import('./maintenance.js').then((m) =>
          m.attachmentDirectories(store, request.params.id),
        );
        const directory = directories.find((d) => path.basename(d) === String(row.id));
        if (!directory) throw fail('附件目录校验失败', 409);
        // Recheck after awaits: a message may have claimed the file meanwhile.
        if (
          store.db.prepare('SELECT state FROM attachments WHERE id=?').get(row.id)?.state !==
          'pending'
        )
          throw fail('此附件已经提交', 409);
        // Claim removal synchronously so message submission cannot acquire it.
        store.db.prepare("UPDATE attachments SET state='deleting' WHERE id=?").run(row.id);
        try {
          await fs.rm(directory, { recursive: true, force: true });
        } catch (error) {
          store.db.prepare("UPDATE attachments SET state='pending' WHERE id=?").run(row.id);
          throw error;
        }
        store.db.prepare('DELETE FROM attachments WHERE id=?').run(row.id);
        return { ok: true };
      }),
  );
  app.get('/api/file-link', async (request) => {
    const q = z
      .object({
        target: z.string().min(1).max(4000),
        thread: idSchema.optional(),
        project: idSchema.optional(),
      })
      .refine((v) => Boolean(v.thread) !== Boolean(v.project), '请选择一个项目或会话')
      .parse(request.query);
    const directory = q.thread
      ? await workbench.threadDirectory(q.thread)
      : store.projects().find((p) => p.id === q.project)?.path;
    if (!directory) throw fail('项目不存在', 404);
    const cwd = await projectPath(directory, config.projectRoots, false);
    try {
      return await resolveFileLink(cwd, q.target);
    } catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code || ''))
        throw fail('链接指向的文件或目录不存在，可能已移动或删除', 404);
      throw error;
    }
  });
  htmlPreviewRoutes(app, auth, async (scope) => {
    const directory = scope.project
      ? store.projects().find((project) => project.id === scope.project)?.path
      : scope.thread
        ? await workbench.threadDirectory(scope.thread)
        : undefined;
    if (!directory) throw fail('请选择项目或会话', 404);
    return projectPath(directory, config.projectRoots, false);
  });
  app.get('/api/files', async (request, reply) => {
    const q = z
      .object({
        thread: idSchema.optional(),
        project: idSchema.optional(),
        path: z.string().max(3000).default(''),
        mode: z.enum(['list', 'read', 'preview', 'download', 'diff']).default('list'),
        offset: z.coerce.number().int().min(0).default(0),
      })
      .parse(request.query);
    let cwd = q.project ? store.projects().find((p) => p.id === q.project)?.path : undefined;
    if (!cwd && q.thread) {
      cwd = await workbench.threadDirectory(q.thread);
    }
    if (!cwd) throw fail('请选择项目或会话');
    if (q.mode === 'diff') return gitDiff(cwd);
    if (q.mode === 'read') return readText(cwd, q.path);
    if (q.mode === 'preview') {
      const file = await safePath(cwd, q.path);
      const stat = await fs.stat(file);
      if (!stat.isFile()) throw fail('只能预览普通文件');
      const mime = imageMime(q.path);
      if (!mime) throw fail('不支持此图片格式，请下载查看', 415);
      if (stat.size > imagePreviewLimit) throw fail('图片超过 20 MB，请下载查看', 413);
      reply
        .type(mime)
        .header('Cache-Control', 'no-store')
        .header('Content-Security-Policy', "sandbox; default-src 'none'; style-src 'unsafe-inline'")
        .header(
          'Content-Disposition',
          `inline; filename*=UTF-8''${encodeURIComponent(path.basename(file))}`,
        );
      return reply.send(createReadStream(file));
    }
    if (q.mode === 'download') {
      const file = await safePath(cwd, q.path);
      if (!(await fs.stat(file)).isFile()) throw fail('只能下载文件');
      reply
        .header(
          'Content-Disposition',
          `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(file))}`,
        )
        .type('application/octet-stream');
      return reply.send(createReadStream(file));
    }
    return listFiles(cwd, q.path, q.offset);
  });
  app.get('/api/events', { websocket: true }, (socket, request) => {
    const token = request.cookies[cookieName]!;
    sockets.set(socket, token);
    const send = (data: unknown) => {
      if (socket.readyState !== 1) return;
      if (socket.bufferedAmount > 4 * 1024 * 1024) {
        socket.close(1013, 'Reconnect to resync');
        return;
      }
      socket.send(JSON.stringify(data));
    };
    const after = Number((request.query as { after?: string }).after || 0);
    const events = Number.isSafeInteger(after) && after > 0 ? store.replay(after, 2001) : [];
    const reset =
      !after ||
      after > store.cursor() ||
      events.length > 2000 ||
      events.some((event, index) => event.seq !== after + index + 1) ||
      (after < store.cursor() && events.at(-1)?.seq !== store.cursor());
    send({ type: 'hello', reset, cursor: store.cursor(), status: workbench.status() });
    if (!reset) for (const event of events) send({ type: 'event', event });
    send({ type: 'synced', cursor: store.cursor() });
    const listener = (event: WorkEvent) => send({ type: 'event', event });
    workbench.on('event', listener);
    let alive = true;
    socket.on('pong', () => {
      alive = true;
    });
    const timer = setInterval(() => {
      if (!auth.valid(token)) {
        socket.close(4001, 'Session expired');
        return;
      }
      if (!alive) {
        socket.terminate();
        return;
      }
      alive = false;
      socket.ping();
    }, 25000);
    socket.on('error', () => {});
    socket.on('close', () => {
      clearInterval(timer);
      sockets.delete(socket);
      workbench.off('event', listener);
    });
  });
  managementRoutes(app, store, workbench, () => {
    for (const socket of sockets.keys()) socket.close(1008, '数据已导入，请重新登录');
  });
  const staticRoot = options.staticRoot || path.resolve('dist/client');
  if (existsSync(staticRoot)) {
    await app.register(staticFiles, {
      root: staticRoot,
      setHeaders(response, filePath) {
        const asset = path.relative(staticRoot, filePath).split(path.sep)[0] === 'assets';
        response.header(
          'Cache-Control',
          asset ? 'public, max-age=31536000, immutable' : 'no-cache',
        );
      },
    });
    app.setNotFoundHandler((request, reply) =>
      request.url.startsWith('/api/')
        ? reply.code(404).send({ error: '接口不存在' })
        : reply.sendFile('index.html'),
    );
  }
  app.addHook('onClose', async () => {
    continuity.dispose();
    workbench.dispose();
    for (const socket of sockets.keys()) socket.terminate();
  });
  return app;
}
