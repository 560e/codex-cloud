import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { parse, stringify } from 'smol-toml';
import type { Workbench } from './workbench.js';
import { fail } from './workbench.js';

export const codexHome = () =>
  path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
export const userSkillsHome = () =>
  path.resolve(
    process.env.CODEX_CLOUD_SKILLS_HOME ||
      process.env.ARRAN_SKILLS_HOME ||
      path.join(os.homedir(), '.agents', 'skills'),
  );
const nameSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/);
export const skillInput = z.object({
  name: nameSchema,
  content: z.string().min(1).max(200000),
  replace: z.boolean().default(false),
});
export const mcpInput = z
  .object({
    name: nameSchema,
    enabled: z.boolean().default(true),
    transport: z.enum(['stdio', 'http']),
    command: z.string().trim().max(2000).default(''),
    args: z.array(z.string().max(4000)).max(100).default([]),
    env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string().max(10000)).default({}),
    url: z.string().trim().max(4000).default(''),
    bearerTokenEnvVar: z
      .string()
      .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
      .or(z.literal(''))
      .default(''),
  })
  .superRefine((value, ctx) => {
    if (value.transport === 'stdio' && !value.command)
      ctx.addIssue({ code: 'custom', message: '请填写 MCP 启动命令' });
    if (value.transport === 'http') {
      try {
        if (!['https:', 'http:'].includes(new URL(value.url).protocol)) throw new Error();
      } catch {
        ctx.addIssue({ code: 'custom', message: 'MCP 地址必须为 HTTP/HTTPS URL' });
      }
    }
  });

export async function readCodexConfig() {
  const file = path.join(codexHome(), 'config.toml');
  const text = await fs.readFile(file, 'utf8').catch((e: NodeJS.ErrnoException) => {
    if (e.code === 'ENOENT') return '';
    throw e;
  });
  return { file, text, config: parse(text) };
}
export async function writeCodexConfig(config: Record<string, unknown>) {
  const file = path.join(codexHome(), 'config.toml');
  await fs.mkdir(path.dirname(file), { recursive: true });
  const backup = file + '.backup-' + Date.now();
  await fs.copyFile(file, backup).catch((e: NodeJS.ErrnoException) => {
    if (e.code !== 'ENOENT') throw e;
  });
  const temp = file + '.tmp-' + randomUUID();
  try {
    await fs.writeFile(temp, stringify(config), { mode: 0o600 });
    await fs.rename(temp, file);
  } finally {
    await fs.rm(temp, { force: true });
  }
}
const skillSchema = z.object({
  name: z.string(),
  description: z.string(),
  path: z.string(),
  scope: z.string(),
  enabled: z.boolean(),
});
export async function listSkills(wb: Workbench, cwd: string) {
  await wb.connect();
  const result = z
    .object({
      data: z.array(
        z.object({ cwd: z.string(), skills: z.array(skillSchema), errors: z.array(z.unknown()) }),
      ),
    })
    .parse(await wb.bridge.call('skills/list', { cwds: [cwd], forceReload: true }));
  const managed = path.join(codexHome(), 'skills');
  return result.data.flatMap((entry) =>
    entry.skills.map((skill) => ({
      ...skill,
      editable:
        path.dirname(path.dirname(skill.path)) === managed &&
        path.basename(skill.path) === 'SKILL.md' &&
        !path.relative(managed, skill.path).startsWith('.system'),
    })),
  );
}
async function ownedSkill(name: string, create = false) {
  nameSchema.parse(name);
  const root = path.join(codexHome(), 'skills');
  await fs.mkdir(root, { recursive: true });
  if ((await fs.lstat(root)).isSymbolicLink()) throw fail('Skill 管理目录不能是链接');
  const directory = path.join(root, name);
  const stat = await fs.lstat(directory).catch((e: NodeJS.ErrnoException) => {
    if (e.code === 'ENOENT') return null;
    throw e;
  });
  if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw fail('Skill 目录无效');
  if (!stat && create) await fs.mkdir(directory);
  const file = path.join(directory, 'SKILL.md');
  const existing = await fs.lstat(file).catch((e: NodeJS.ErrnoException) => {
    if (e.code === 'ENOENT') return null;
    throw e;
  });
  if (existing && (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1))
    throw fail('Skill 文件无效');
  return { directory, file };
}
export async function readSkill(name: string) {
  return fs.readFile((await ownedSkill(name)).file, 'utf8');
}
export async function saveSkill(input: z.output<typeof skillInput>) {
  if (
    !/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.test(input.content) ||
    !/^name:\s*\S/m.test(input.content) ||
    !/^description:\s*\S/m.test(input.content)
  )
    throw fail('SKILL.md 需要包含 name 和 description 的 YAML 头部');
  const { file } = await ownedSkill(input.name, true);
  if (
    !input.replace &&
    (await fs.stat(file).then(
      () => true,
      () => false,
    ))
  )
    throw fail('同名 Skill 已存在，请使用编辑入口', 409);
  const temp = file + '.tmp-' + randomUUID();
  try {
    await fs.writeFile(temp, input.content, { mode: 0o600 });
    await fs.rename(temp, file);
  } finally {
    await fs.rm(temp, { force: true });
  }
}
export async function deleteSkill(name: string) {
  await fs.rm((await ownedSkill(name)).directory, { recursive: true });
}
export async function listMcp(wb: Workbench) {
  const { config } = await readCodexConfig();
  const servers = (config.mcp_servers || {}) as Record<string, Record<string, unknown>>;
  let statuses: {
    name: string;
    authStatus?: string;
    tools?: Record<string, unknown>;
    runtimeStatus?: unknown;
  }[] = [];
  let statusError = '';
  try {
    await wb.connect();
    let cursor: string | null = null;
    const seen = new Set<string>();
    do {
      const page = z
        .object({
          data: z.array(
            z.object({
              name: z.string(),
              authStatus: z.string().optional(),
              tools: z.record(z.string(), z.unknown()).optional(),
              runtimeStatus: z.unknown().optional(),
            }),
          ),
          nextCursor: z.string().nullish(),
        })
        .parse(await wb.bridge.call('mcpServerStatus/list', { cursor, limit: 100 }));
      statuses.push(...page.data);
      cursor = page.nextCursor || null;
      if (cursor && seen.has(cursor)) throw fail('MCP 状态分页重复');
      if (cursor) seen.add(cursor);
    } while (cursor);
  } catch (e) {
    statusError = (e as Error).message;
  }
  return {
    servers: Object.entries(servers).map(([name, value]) => ({
      name,
      enabled: value.enabled !== false,
      transport: typeof value.url === 'string' ? 'http' : 'stdio',
      command: value.command || '',
      args: value.args || [],
      env: value.env || {},
      url: value.url || '',
      bearerTokenEnvVar: value.bearer_token_env_var || '',
      status: statuses.find((entry) => entry.name === name) || null,
    })),
    statusError,
  };
}
export async function saveMcp(input: z.output<typeof mcpInput> | { name: string; remove: true }) {
  nameSchema.parse(input.name);
  const { config } = await readCodexConfig();
  const servers = (config.mcp_servers || {}) as Record<string, Record<string, unknown>>;
  if ('remove' in input) delete servers[input.name];
  else {
    const next: Record<string, unknown> = {
      ...(servers[input.name] || {}),
      enabled: input.enabled,
    };
    if (input.transport === 'stdio') {
      delete next.url;
      delete next.bearer_token_env_var;
      delete next.http_headers;
      delete next.env_http_headers;
      Object.assign(next, { command: input.command, args: input.args, env: input.env });
    } else {
      delete next.command;
      delete next.args;
      delete next.env;
      Object.assign(next, { url: input.url });
      if (input.bearerTokenEnvVar) next.bearer_token_env_var = input.bearerTokenEnvVar;
      else delete next.bearer_token_env_var;
    }
    servers[input.name] = next;
  }
  config.mcp_servers = servers as typeof config;
  await writeCodexConfig(config);
}
