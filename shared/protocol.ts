import { z } from 'zod';
import type {
  EventParams,
  Thread,
  Turn,
  Item,
  Model,
  AccountInfo,
  RequestParams,
} from './types.js';

const text = z.string();
const optionalText = text.nullish().transform((value) => value ?? undefined);
const id = text.min(1);
const record = z.record(text, z.unknown());
export const reviewTargetSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('uncommittedChanges') }),
  z.object({ type: z.literal('baseBranch'), branch: text.trim().min(1).max(200) }),
  z.object({
    type: z.literal('commit'),
    sha: text.regex(/^[a-fA-F0-9]{7,64}$/),
    title: text.max(200).nullable().default(null),
  }),
  z.object({ type: z.literal('custom'), instructions: text.trim().min(1).max(10000) }),
]);
export type ReviewTarget = z.output<typeof reviewTargetSchema>;
const plan = z.array(z.object({ step: text, status: text }).passthrough());
const changes = z.array(
  z
    .object({
      path: text,
      diff: text.optional(),
      kind: z.object({ type: text, move_path: text.nullish() }).passthrough().optional(),
    })
    .passthrough(),
);
const tokens = z
  .object({
    cachedInputTokens: z.number().finite().nonnegative().optional(),
    totalTokens: z.number().finite().nonnegative().optional(),
    inputTokens: z.number().finite().nonnegative().optional(),
    outputTokens: z.number().finite().nonnegative().optional(),
    reasoningOutputTokens: z.number().finite().nonnegative().optional(),
  })
  .passthrough();
const tokenUsage = z
  .object({
    total: tokens.optional(),
    last: tokens.optional(),
    modelContextWindow: z.number().nullish(),
  })
  .passthrough();
export const itemSchema: z.ZodType<Item> = z
  .object({
    id,
    type: text,
    text: text.optional(),
    review: text.optional(),
    phase: optionalText,
    status: text.optional(),
    workbenchStatus: text.optional(),
    content: z
      .union([
        z.array(text),
        z.array(
          z.object({ type: text, text: text.optional(), path: text.optional() }).passthrough(),
        ),
      ])
      .optional(),
    summary: z.array(text).optional(),
    command: text.optional(),
    cwd: text.optional(),
    durationMs: z.number().nullish(),
    exitCode: z.number().nullish(),
    aggregatedOutput: text.nullish(),
    terminalInput: text.optional(),
    processId: optionalText,
    changes: changes.optional(),
    questions: z
      .array(
        z.object({
          title: text,
          options: z
            .array(text)
            .nullish()
            .transform((value) => value ?? undefined),
        }),
      )
      .nullish()
      .transform((value) => value ?? undefined),
    query: text.optional(),
    action: z
      .object({ query: optionalText })
      .passthrough()
      .nullish()
      .transform((value) => value ?? undefined),
    tool: text.optional(),
  })
  .passthrough();
const balanceSchema = z.object({
  errorCode: z.enum(['timeout', 'network', 'http', 'invalid_response']).optional(),
  httpStatus: z.number().int().min(100).max(599).optional(),
  attempts: z.number().int().min(1).max(3).optional(),
  source: z.enum(['opened', 'completion']).optional(),
  status: z.enum(['loading', 'available', 'unavailable', 'error']),
  checkedAt: z.number().nonnegative(),
  providerName: z.string().max(80).optional(),
  remaining: z.number().finite().optional(),
  beforeRemaining: z.number().finite().optional(),
  spent: z.number().finite().nonnegative().optional(),
  unit: z.string().max(32).optional(),
  isValid: z.boolean().optional(),
});
export const turnSchema: z.ZodType<Turn> = z
  .object({
    model: z.string().min(1).max(200).optional(),
    tokenUsage: tokens.optional(),
    tokenUsagePartial: z.boolean().optional(),
    upstreamBalance: balanceSchema.optional(),
    startedAt: z.number().nonnegative().nullish(),
    completedAt: z.number().nonnegative().nullish(),
    durationMs: z.number().nonnegative().nullish(),
    id,
    status: text,
    items: z.array(itemSchema).default([]),
    error: z.object({ message: text }).passthrough().nullish(),
    plan: plan.optional(),
    planExplanation: text.nullish(),
    diff: text.optional(),
  })
  .passthrough();
export const threadSchema: z.ZodType<Thread> = z
  .object({
    id,
    cwd: text,
    preview: text.default(''),
    name: text.nullish(),
    createdAt: z.number().default(0),
    updatedAt: z.number().default(0),
    turns: z.array(turnSchema).default([]),
    status: z.object({ type: text, activeFlags: z.array(text).optional() }).passthrough(),
    model: text.nullish(),
    reasoningEffort: text.nullish(),
    historyMode: text.optional(),
    pinned: z.boolean().optional(),
    interrupted: z.boolean().optional(),
    tokenUsage: tokenUsage.optional(),
    latestDiff: text.optional(),
    plan: plan.optional(),
    renderCursor: z.number().optional(),
  })
  .passthrough();
export const modelSchema: z.ZodType<Model> = z
  .object({
    id,
    model: id,
    displayName: text,
    isDefault: z.boolean(),
    supportedReasoningEfforts: z.array(
      z.object({ reasoningEffort: text, description: text.optional() }),
    ),
    defaultReasoningEffort: text,
    hidden: z.boolean().optional(),
  })
  .passthrough();
export const accountSchema: z.ZodType<AccountInfo> = z.object({
  requiresOpenaiAuth: z.boolean().optional(),
  account: z.object({ type: text, email: optionalText, planType: text.optional() }).nullable(),
});
export const requestParamsSchema: z.ZodType<RequestParams> = z
  .object({
    threadId: id.optional(),
    turnId: id.nullish().transform((value) => value ?? undefined),
    reason: text.nullish(),
    message: text.optional(),
    command: text.nullish(),
    cwd: optionalText,
    grantRoot: text.nullish(),
    permissions: record.optional(),
    questions: z
      .array(
        z.object({
          id,
          question: text,
          header: text.optional(),
          isSecret: z.boolean().optional(),
          options: z
            .array(z.object({ label: text, description: text.optional() }))
            .nullish()
            .transform((value) => value ?? undefined),
        }),
      )
      .optional(),
    request: z.unknown().optional(),
  })
  .passthrough();
export const pendingSchema = z.object({
  id,
  rpcId: z.union([text, z.number()]),
  method: text,
  params: requestParamsSchema,
  createdAt: z.number(),
});
const queuedSchema = z.object({
  id,
  threadId: id,
  preview: text,
  state: z.enum(['queued', 'sending', 'paused']),
  createdAt: z.number(),
  error: text.nullish().transform((v) => v ?? undefined),
});
export const statusSchema = z
  .object({
    provider: z.object({ id: id.nullable(), name: text, model: text.nullable() }).optional(),
    connected: z.boolean(),
    testMode: z.boolean().optional(),
    version: text.optional(),
    error: text.optional(),
    active: z.array(z.object({ threadId: id, turnId: id, cwd: text })),
    pending: z.array(pendingSchema),
    queued: z.array(queuedSchema).optional(),
  })
  .passthrough();
const eventParamsSchema: z.ZodType<EventParams> = z
  .object({
    threadId: id.optional(),
    thread: threadSchema.optional(),
    turnId: id.optional(),
    turn: turnSchema.optional(),
    item: itemSchema.optional(),
    itemId: id.optional(),
    status: z.object({ type: text, activeFlags: z.array(text).optional() }).optional(),
    threadName: text.optional(),
    name: text.optional(),
    tokenUsage: tokenUsage.optional(),
    turnTokenUsage: tokens.optional(),
    tokenUsagePartial: z.boolean().optional(),
    upstreamBalance: balanceSchema.optional(),
    delta: text.optional(),
    changes: changes.optional(),
    summaryIndex: z.number().int().min(0).max(10000).optional(),
    contentIndex: z.number().int().min(0).max(10000).optional(),
    processId: text.optional(),
    stdin: text.optional(),
    error: z.object({ message: text }).passthrough().nullish(),
    diff: text.optional(),
    plan: plan.optional(),
    explanation: text.nullish(),
    requestId: z.union([text, z.number()]).optional(),
    id: id.optional(),
    rpcId: z.union([text, z.number()]).optional(),
    method: text.optional(),
    params: requestParamsSchema.optional(),
    createdAt: z.number().optional(),
    queued: z.array(queuedSchema).optional(),
    message: text.optional(),
  })
  .passthrough();
export function parseEventParams(method: string, value: unknown): EventParams {
  const p = eventParamsSchema.parse(value);
  if (['turn/started', 'turn/completed'].includes(method) && (!p.threadId || !p.turn))
    throw new Error('Invalid turn event');
  if (['item/started', 'item/completed'].includes(method) && (!p.threadId || !p.turnId || !p.item))
    throw new Error('Invalid item event');
  if (method === 'thread/started' && !p.thread) throw new Error('Invalid thread event');
  if (method === 'workbench/request') pendingSchema.parse(p);
  return p;
}
export const wireSchema = z.object({
  id: z.union([text, z.number()]).optional(),
  method: text.optional(),
  params: z.unknown().optional(),
  result: z.unknown().optional(),
  error: z.object({ message: text, code: z.number().optional() }).optional(),
});
const threadResult = z.object({ thread: threadSchema }).passthrough();
const cursor = text.nullish();
export const rpcSchemas = {
  'review/start': z.object({ turn: turnSchema, reviewThreadId: id }),
  'thread/compact/start': z.object({}),
  fuzzyFileSearch: z.object({
    files: z.array(
      z.object({
        root: text,
        path: text,
        match_type: z.enum(['file', 'directory']),
        file_name: text,
        score: z.number(),
        indices: z.array(z.number()).nullable(),
      }),
    ),
  }),
  'modelProvider/capabilities/read': z.object({
    namespaceTools: z.boolean(),
    imageGeneration: z.boolean(),
    webSearch: z.boolean(),
  }),
  'config/read': z
    .object({
      config: z.object({ model_provider: text.nullish(), model: text.nullish() }).passthrough(),
    })
    .passthrough(),
  initialize: z.object({ userAgent: text }).passthrough(),
  'thread/start': threadResult,
  'thread/read': threadResult,
  'thread/resume': threadResult,
  'thread/fork': threadResult,
  'thread/list': z.object({ data: z.array(threadSchema), nextCursor: cursor }).passthrough(),
  'thread/turns/list': z.object({ data: z.array(turnSchema), nextCursor: cursor }).passthrough(),
  'model/list': z.object({ data: z.array(modelSchema), nextCursor: cursor }).passthrough(),
  'account/read': accountSchema,
  'turn/start': z.object({ turn: turnSchema }).passthrough(),
  'turn/steer': z.object({ turnId: id }).passthrough(),
};
export type RpcMethod = keyof typeof rpcSchemas;
export type RpcResult<M extends RpcMethod> = z.output<(typeof rpcSchemas)[M]>;
export function parseRpcResult(method: string, value: unknown): unknown {
  return method in rpcSchemas ? rpcSchemas[method as RpcMethod].parse(value) : value;
}

const projectSchema = z.object({
  id,
  name: text,
  path: text,
  createdAt: z.number(),
  systemPrompt: text.optional(),
});
const attachmentSchema = z.object({ id, name: text, mime: text, size: z.number() });
const providerSchema = z.object({
  id,
  name: text,
  baseUrl: text,
  model: text,
  hasKey: z.boolean(),
  models: z.array(text).optional(),
  modelsFetchedAt: z.number().nonnegative().optional(),
});
const providerSummarySchema = z.object({ id: id.nullable(), name: text, model: text.nullable() });
export function parseApiResult(url: string, method: string, value: unknown): unknown {
  const [route, query] = url.split('?');
  if (route === '/usage')
    return z
      .object({
        totals: tokens,
        cache: z.object({
          inputTokens: z.number().finite().nonnegative().optional(),
          cachedInputTokens: z.number().finite().nonnegative().optional(),
          turns: z.number().int().nonnegative(),
        }),
        records: z.array(
          z.object({
            threadId: id,
            turnId: id,
            turnNumber: z.number().int().positive(),
            name: text,
            cwd: text,
            projectId: id.optional(),
            projectName: text,
            prompt: text,
            status: text,
            startedAt: z.number().optional(),
            completedAt: z.number().optional(),
            updatedAt: z.number(),
            counts: tokens,
            partial: z.boolean(),
            balance: balanceSchema.optional(),
          }),
        ),
        page: z.number().int().positive(),
        pageSize: z.number().int().positive(),
        pages: z.number().int().positive(),
        expenses: z.array(
          z.object({
            unit: text,
            spent: z.number().finite().nonnegative(),
            turns: z.number().int().nonnegative(),
          }),
        ),
        filters: z.object({
          projects: z.array(z.object({ id, name: text })),
          threads: z.array(z.object({ id, name: text, projectId: id.optional() })),
        }),
        turns: z.number().int().nonnegative(),
        threads: z.array(
          z.object({
            threadId: id,
            name: text,
            cwd: text,
            counts: tokens,
            turns: z.number().int().nonnegative(),
            updatedAt: z.number(),
            partial: z.boolean(),
          }),
        ),
      })
      .parse(value);
  if (route === '/file-link')
    return z
      .object({
        path: text,
        directory: z.boolean(),
        line: z.number().int().positive().optional(),
        column: z.number().int().positive().optional(),
      })
      .parse(value);
  if (route === '/file-search')
    return z.object({ files: z.array(z.object({ path: text, name: text })) }).parse(value);
  if (route === '/capabilities')
    return z
      .discriminatedUnion('available', [
        z.object({
          available: z.literal(true),
          capabilities: rpcSchemas['modelProvider/capabilities/read'],
        }),
        z.object({ available: z.literal(false), reason: text }),
      ])
      .parse(value);
  if (route === '/providers/access')
    return z
      .object({
        configured: z.boolean(),
        unlocked: z.boolean(),
        expiresAt: z.number().nullable(),
        active: providerSummarySchema,
      })
      .parse(value);
  if (route === '/providers')
    return (
      method === 'GET'
        ? z.object({ profiles: z.array(providerSchema), activeId: id.nullable() })
        : providerSchema
    ).parse(value);
  if (route === '/providers/active') return providerSummarySchema.parse(value);
  if (/^\/providers\/[^/]+\/balance$/.test(route) && method === 'GET')
    return balanceSchema.parse(value);
  if (/^\/providers\/[^/]+\/models\/refresh$/.test(route) && method === 'POST')
    return providerSchema.parse(value);
  if (/^\/providers\/[^/]+$/.test(route) && method === 'PUT') return providerSchema.parse(value);
  if (route === '/auth/status')
    return z
      .object({
        configured: z.boolean(),
        authenticated: z.boolean(),
        apiVersion: z.number().optional(),
      })
      .parse(value);
  if (route === '/models') return rpcSchemas['model/list'].parse(value);
  if (route === '/status' || route === '/connect') return statusSchema.parse(value);
  if (route === '/account') return accountSchema.parse(value);
  if (route === '/projects')
    return (method === 'GET' ? z.array(projectSchema) : projectSchema).parse(value);
  if (route === '/threads')
    return (method === 'GET' ? rpcSchemas['thread/list'] : threadResult).parse(value);
  if (/^\/threads\/[^/]+$/.test(route) && method === 'GET')
    return threadResult.extend({ cursor: z.number(), nextCursor: cursor }).parse(value);
  if (/^\/threads\/[^/]+\/attachments$/.test(route))
    return (method === 'GET' ? z.array(attachmentSchema) : attachmentSchema).parse(value);
  if (route === '/files') {
    const mode = new URLSearchParams(query).get('mode') || 'list';
    if (mode === 'list')
      return z
        .object({
          entries: z.array(z.object({ name: text, path: text, directory: z.boolean() })),
          total: z.number(),
          nextOffset: z.number().nullable(),
        })
        .parse(value);
    if (mode === 'read') return z.object({ content: text, size: z.number() }).parse(value);
    return z
      .union([
        z.object({ kind: z.literal('git'), staged: text, unstaged: text, status: text }),
        z.object({ kind: z.enum(['folder', 'unavailable']), message: text }),
      ])
      .parse(value);
  }
  return value;
}

const eventSchema = z
  .object({ seq: z.number().int(), method: text, params: z.unknown(), at: z.number() })
  .transform((e) => ({ ...e, params: parseEventParams(e.method, e.params) }));
const socketSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('hello'),
    reset: z.boolean(),
    cursor: z.number().int(),
    status: statusSchema,
  }),
  z.object({ type: z.literal('synced'), cursor: z.number().int() }),
  z.object({ type: z.literal('event'), event: eventSchema }),
]);
export function parseSocketMessage(value: string) {
  return socketSchema.parse(JSON.parse(value) as unknown);
}
