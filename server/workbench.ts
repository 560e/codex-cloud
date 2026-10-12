import { EventEmitter } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import type { CodexBridge } from './codex.js';
import type { Store } from './store.js';
import type {
  Json,
  PendingRequest,
  RuntimeStatus,
  Thread,
  WorkEvent,
  EventParams,
  Model,
  UpstreamBalance,
} from '../shared/types.js';
import { parseEventParams, requestParamsSchema, type ReviewTarget } from '../shared/protocol.js';
import { applyThreadEvent, overlayLive } from '../shared/events.js';
import { attachmentDirectories, removeAttachments } from './maintenance.js';
import { BoundedCache } from './cache.js';
import { threadExecution, legacyThreadExecution } from './thread-execution.js';
import {
  Providers,
  managedProviderId,
  type RuntimeProvider,
  type providerInput,
} from './providers.js';
import type { z } from 'zod';
import { balanceDifference } from '../shared/money.js';
import { queryBalance, queryBalanceAfterTurn } from './balance.js';
import { modelName, nativeTurnModels } from './turn-models.js';
import { nativeProjectContext, projectContextSchema } from './project-context.js';
import type { Continuity } from './continuity.js';

export const fail = (message: string, statusCode = 400) =>
  Object.assign(new Error(message), { statusCode });
export class Workbench extends EventEmitter {
  continuity?: Continuity;
  readonly providers: Providers;
  pending = new Map<string, PendingRequest>();
  active = new Map<string, { threadId: string; turnId: string; cwd: string }>();
  private loaded = new BoundedCache<string>();
  private appliedProjectSettings = new BoundedCache<string>();
  private reservations = new Map<string, string>();
  private busy = new Set<string>();
  private live = new BoundedCache<Thread>(100);
  private pendingBalances = new Map<string, UpstreamBalance>();
  private pendingModels = new Map<string, string>();
  private turnProviders = new Map<string, RuntimeProvider | null>();
  private balanceJobs = new Map<string, { threadId: string; controller: AbortController }>();
  private completed = new BoundedCache<boolean>(500);
  private directories = new Map<string, { cwd: string; until: number }>();
  private draining = false;
  private disposed = false;
  private terminating = false;
  private drainTimer?: NodeJS.Immediate;
  private generation = 0;
  private revision = 0;
  private starts = new Map<string, { stopped: boolean }>();
  private compactions = new Map<string, { stopped: boolean; timer: NodeJS.Timeout }>();
  private titleThreads = new Map<string, (title: string | null) => void>();
  private titleJobs = new Set<string>();
  private clearCompaction(id: string) {
    clearTimeout(this.compactions.get(id)?.timer);
    this.compactions.delete(id);
  }
  constructor(
    public bridge: CodexBridge,
    public store: Store,
    private maxConcurrent: number,
    private balanceQuery: typeof queryBalance = bridge.isTest
      ? async () => ({ status: 'unavailable', checkedAt: Date.now() })
      : queryBalance,
  ) {
    super();
    this.providers = new Providers(store);
    bridge.configureProvider(this.providers.runtime());
    bridge.on('notification', (message: { method: string; params: unknown }) => {
      // Remote control is not integrated. Its string status is not a thread
      // status object, and its remote identity fields need not reach the UI.
      if (
        message.method.startsWith('codex/') ||
        message.method.startsWith('rawResponse') ||
        message.method === 'remoteControl/status/changed'
      )
        return;
      let params: EventParams;
      try {
        params = parseEventParams(message.method, message.params);
      } catch {
        this.publish('workbench/warning', {
          message: `无法读取 Codex 通知：${message.method}，请检查 CLI 版本。`,
        });
        return;
      }
      this.notification(message.method, params);
    });
    bridge.on('request', (message: { id: string | number; method: string; params: unknown }) => {
      if (this.disposed) return;
      const supported = [
        'item/commandExecution/requestApproval',
        'item/fileChange/requestApproval',
        'item/permissions/requestApproval',
        'item/tool/requestUserInput',
        'mcpServer/elicitation/request',
      ];
      if (!supported.includes(message.method)) {
        bridge.rejectRequest(message.id, `Workbench does not support ${message.method}`);
        this.publish('workbench/warning', {
          message: `不支持的 Codex 交互：${message.method}，已明确返回错误。`,
        });
        return;
      }
      const parsed = requestParamsSchema.safeParse(message.params);
      if (
        !parsed.success ||
        (message.method === 'item/tool/requestUserInput' && !parsed.data.questions?.length) ||
        (message.method === 'item/permissions/requestApproval' && !parsed.data.permissions)
      ) {
        bridge.rejectRequest(message.id, 'Invalid interaction parameters');
        this.publish('workbench/warning', { message: 'Codex 交互参数不兼容，已拒绝此请求。' });
        return;
      }
      const request = {
        id: randomUUID(),
        rpcId: message.id,
        method: message.method,
        params: parsed.data,
        createdAt: Date.now(),
      };
      this.pending.set(request.id, request);
      this.publish('workbench/request', request);
    });
    bridge.on('disconnect', (message) => {
      if (this.disposed) return;
      this.generation++;
      for (const resolve of this.titleThreads.values()) resolve(null);
      this.titleThreads.clear();
      for (const id of this.compactions.keys()) this.clearCompaction(id);
      store.pauseQueue(
        undefined,
        'Codex 连接已断开，请核对历史后继续；提交状态未知的消息不会自动重发。',
      );
      store.interruptRuns();
      this.active.clear();
      this.pendingBalances.clear();
      this.turnProviders.clear();
      this.reservations.clear();
      this.loaded.clear();
      this.pending.clear();
      this.live.clear();
      this.completed.clear();
      this.directories.clear();
      this.publish('workbench/disconnected', { message });
      this.queueChanged();
    });
    bridge.on('connected', () => {
      if (!this.disposed) {
        this.publish('workbench/connected', {});
        this.scheduleQueue();
      }
    });
  }
  publish(method: string, params: EventParams): WorkEvent {
    const event = this.store.event(method, params ?? {});
    this.emit('event', event);
    return event;
  }
  status(): RuntimeStatus {
    return {
      provider: this.providers.summary(),
      connected: this.bridge.ready,
      testMode: this.bridge.isTest,
      version: this.bridge.version,
      error: this.bridge.error,
      active: [...this.active.values()],
      pending: [...this.pending.values()],
      queued: this.store.publicQueue(),
    };
  }
  private notification(method: string, params: EventParams) {
    if (this.disposed) return;
    const threadId = params.threadId || params.thread?.id;
    if (threadId && this.titleThreads.has(threadId)) {
      if (method === 'turn/completed') {
        const answer = params.turn?.items
          .filter((item) => item.type === 'agentMessage' && typeof item.text === 'string')
          .at(-1)?.text;
        this.titleThreads.get(threadId)?.(
          params.turn?.status === 'completed' ? answer || null : null,
        );
      }
      return;
    }
    if (threadId && params.turn && (method === 'turn/started' || method === 'turn/completed')) {
      const model =
        modelName(params.turn.model) ||
        this.store.threadModels(threadId).get(params.turn.id) ||
        (method === 'turn/started' ? this.pendingModels.get(threadId) : undefined);
      if (model) {
        params.turn.model = model;
        this.store.saveTurnModel(threadId, params.turn.id, model);
      }
    }
    if (method === 'turn/started' && params.turn) {
      this.turnProviders.set(params.turn.id, this.providers.runtime());
      if (threadId) this.recordBalanceStart(threadId, params.turn.id);
    }
    if (method === 'turn/completed' && params.turn && threadId) {
      this.recordBalanceStart(threadId, params.turn.id);
      if (!this.completed.get(params.turn.id)) {
        const provider = this.turnProviders.has(params.turn.id)
          ? this.turnProviders.get(params.turn.id)!
          : this.providers.runtime();
        this.turnProviders.delete(params.turn.id);
        params.turn.upstreamBalance = {
          ...this.store.threadBalances(threadId).get(params.turn.id),
          status: 'loading',
          checkedAt: Date.now(),
          providerName: provider?.name,
        };
        this.store.saveBalance(threadId, params.turn.id, params.turn.upstreamBalance);
        void this.refreshBalance(threadId, params.turn.id, provider);
      } else {
        params.turn.upstreamBalance = this.store.threadBalances(threadId).get(params.turn.id);
      }
    }
    if (threadId) {
      const previous = this.live.get(threadId) || {
        id: threadId,
        cwd: '',
        preview: '',
        createdAt: 0,
        updatedAt: 0,
        turns: [],
        status: { type: 'idle' },
      };
      const isIncremental =
        method.startsWith('item/') && method !== 'item/started' && method !== 'item/completed';
      const hasItem = previous.turns.some(
        (turn) => turn.id === params.turnId && turn.items.some((item) => item.id === params.itemId),
      );
      // After eviction, never overlay a suffix onto a complete native item.
      // The next canonical item/completed or turn/completed restores the cache.
      const next =
        isIncremental && !hasItem
          ? previous
          : applyThreadEvent(previous, { seq: 0, method, params, at: Date.now() });
      // Retain a bounded live overlay; Codex owns complete historical turns.
      if (next.turns.length > 30) next.turns = next.turns.slice(-30);
      this.live.set(threadId, next);
    }
    if (method === 'thread/started' && params.thread)
      this.loaded.set(params.thread.id, params.thread.cwd);
    if (method === 'thread/closed' && params.threadId) {
      this.loaded.delete(params.threadId);
      this.live.delete(params.threadId);
    }
    if (method === 'turn/started' && params.threadId && params.turn) {
      const cwd = this.reservations.get(params.threadId) || this.loaded.get(params.threadId) || '';
      const run = { threadId: params.threadId, turnId: params.turn.id, cwd };
      this.active.set(params.threadId, run);
      this.store.run(run.threadId, run.turnId, cwd);
      if (this.compactions.get(params.threadId)?.stopped)
        void this.bridge
          .call('turn/interrupt', { threadId: run.threadId, turnId: run.turnId })
          .catch(() => {
            this.publish('workbench/warning', {
              message: '压缩中断未确认，请重试停止或强制终止执行器。',
            });
          });
    }
    if (method === 'turn/completed' && params.threadId && params.turn) {
      this.completed.set(params.turn.id, true);
      this.clearCompaction(params.threadId);
      this.active.delete(params.threadId);
      this.store.finish(params.threadId);
      if (params.turn.status !== 'completed') {
        this.store.pauseQueue(params.threadId, '上一轮已停止或失败，请核对结果后继续队列。');
        this.queueChanged();
      }
      for (const [id, request] of this.pending)
        if (
          request.params.threadId === params.threadId &&
          request.params.turnId === params.turn.id
        ) {
          this.pending.delete(id);
          this.publish('workbench/requestResolved', { id });
        }
    }
    if (method === 'serverRequest/resolved') {
      for (const [id, request] of this.pending)
        if (request.rpcId === params.requestId) {
          this.pending.delete(id);
          this.publish('workbench/requestResolved', { id });
        }
    }
    // Do not relay raw upstream response bodies or duplicate legacy events.
    if (method.startsWith('codex/') || method.startsWith('rawResponse')) return;
    this.publish(method, params);
    if (method === 'turn/completed' && threadId && params.turn?.status === 'completed') {
      const current = this.live.get(threadId);
      if (current?.turns.length === 1 && !current.name && !this.titleJobs.has(threadId)) {
        const firstMessage = current.turns[0].items.find((item) => item.type === 'userMessage');
        const prompt = Array.isArray(firstMessage?.content)
          ? firstMessage.content
              .filter(
                (part): part is { type: string; text: string } =>
                  typeof part === 'object' &&
                  part !== null &&
                  'text' in part &&
                  typeof part.text === 'string',
              )
              .map((part) => part.text)
              .join('\n')
          : '';
        if (prompt.trim()) {
          this.titleJobs.add(threadId);
          void this.generateTitle(threadId, current.cwd, prompt)
            .catch(() => {})
            .finally(() => this.titleJobs.delete(threadId));
        }
      }
    }
    if (method === 'turn/completed') this.scheduleQueue();
  }
  private async generateTitle(id: string, cwd: string, prompt: string) {
    const generation = this.generation;
    let candidate = '';
    let titleId = '';
    let titleTurnId = '';
    let completed = false;
    try {
      const result = await this.bridge.call('thread/start', {
        cwd,
        ...this.providerThreadOptions(),
        sandbox: 'read-only',
        approvalPolicy: 'never',
        developerInstructions:
          '你只负责给会话起标题。根据用户的第一条消息，用相同语言概括主题。只输出标题，不要解释、引号、标点或换行；最多 10 个 Unicode 字符。不要使用工具。',
      });
      titleId = result.thread.id;
      const answer = new Promise<string | null>((resolve) => {
        const timer = setTimeout(() => resolve(null), 30000);
        timer.unref();
        this.titleThreads.set(titleId, (value) => {
          completed = true;
          clearTimeout(timer);
          resolve(value);
        });
      });
      const turn = await this.bridge.call('turn/start', {
        threadId: titleId,
        input: [
          {
            type: 'text',
            text: `请为以下会话起标题：\n${prompt.slice(0, 2000)}`,
            text_elements: [],
          },
        ],
        model: this.bridge.defaultModel,
      });
      titleTurnId = turn.turn.id;
      candidate = (await answer) || '';
    } catch {
      // Title generation is optional; the first user message remains available.
    } finally {
      if (titleId) {
        if (!completed && titleTurnId)
          await this.bridge
            .call('turn/interrupt', { threadId: titleId, turnId: titleTurnId })
            .catch(() => {});
        await this.bridge.call('thread/delete', { threadId: titleId }).then(
          () => this.store.deleteThreadData(titleId),
          () => {},
        );
        this.titleThreads.delete(titleId);
      }
    }
    if (generation !== this.generation || this.disposed) return;
    const clean = (candidate || prompt)
      .trim()
      .replace(/[\r\n]+/g, ' ')
      .replace(
        /^[\s"'“”‘’「」《》。，、：:；;!?！？]+|[\s"'“”‘’「」《》。，、：:；;!?！？]+$/g,
        '',
      );
    const title = Array.from(clean).slice(0, 10).join('');
    if (!title) return;
    await this.exclusive(id, async () => {
      if (this.store.deletion(id) || generation !== this.generation) return;
      const { thread } = await this.bridge.call('thread/read', {
        threadId: id,
        includeTurns: false,
      });
      if (!thread.name) await this.bridge.call('thread/name/set', { threadId: id, name: title });
    }).catch(() => {});
  }
  private recordBalanceStart(threadId: string, turnId: string) {
    const before = this.pendingBalances.get(threadId);
    if (!before) return;
    this.pendingBalances.delete(threadId);
    if (this.store.threadBalances(threadId).has(turnId)) return;
    this.store.saveBalance(threadId, turnId, {
      status: 'loading',
      checkedAt: before.checkedAt,
      providerName: before.providerName,
      unit: before.unit,
      beforeRemaining: before.status === 'available' ? before.remaining : undefined,
    });
  }
  private async refreshBalance(
    threadId: string,
    turnId: string,
    provider: RuntimeProvider | null,
    source: 'opened' | 'completion' = 'completion',
  ) {
    const job = { threadId, controller: new AbortController() };
    this.balanceJobs.set(turnId, job);
    let upstreamBalance;
    try {
      upstreamBalance = await queryBalanceAfterTurn(
        provider,
        this.balanceQuery,
        job.controller.signal,
      );
    } catch {
      upstreamBalance = {
        status: 'error' as const,
        checkedAt: Date.now(),
        providerName: provider?.name,
      };
    }
    if (this.disposed || this.balanceJobs.get(turnId) !== job) return;
    this.balanceJobs.delete(turnId);
    if (this.store.deletion(threadId)) return;
    const before = this.store.threadBalances(threadId).get(turnId);
    upstreamBalance = {
      ...upstreamBalance,
      source,
      beforeRemaining: before?.beforeRemaining,
      spent:
        source === 'completion' &&
        upstreamBalance.status === 'available' &&
        before?.unit?.trim().toUpperCase() === upstreamBalance.unit?.trim().toUpperCase()
          ? balanceDifference(before?.beforeRemaining, upstreamBalance.remaining)
          : undefined,
    };
    this.store.saveBalance(threadId, turnId, upstreamBalance);
    this.notification('workbench/balanceUpdated', { threadId, turnId, upstreamBalance });
  }
  async connect() {
    if (this.terminating || this.disposed) throw fail('执行器正在停止，请稍后重试', 409);
    await this.bridge.start();
  }
  async models() {
    const provider = this.providers.summary();
    const defaultModel = provider.model || this.bridge.defaultModel;
    if (provider.id)
      return {
        data: [
          ...new Set(
            [
              defaultModel,
              ...(this.providers.list().find((p) => p.id === provider.id)?.models || []),
            ].filter((value): value is string => !!value),
          ),
        ].map((model) => ({
          id: model,
          model,
          displayName: model,
          isDefault: model === defaultModel,
          supportedReasoningEfforts: [],
          defaultReasoningEffort: '',
        })),
        nextCursor: null,
      };
    await this.connect();
    const models = new Map<string, Model>();
    const seen = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await this.bridge.call('model/list', {
        includeHidden: true,
        limit: 100,
        ...(cursor ? { cursor } : {}),
      });
      for (const model of page.data) models.set(model.model || model.id, model);
      cursor = page.nextCursor || undefined;
      if (cursor && seen.has(cursor)) throw fail('模型列表分页游标重复，请刷新后重试', 502);
      if (cursor) seen.add(cursor);
    } while (cursor);
    return { data: [...models.values()], nextCursor: null };
  }
  async capabilities() {
    await this.connect();
    const generation = this.generation;
    try {
      const capabilities = await this.bridge.call('modelProvider/capabilities/read', {});
      if (generation !== this.generation || this.terminating || this.disposed)
        throw fail('供应商连接已变化，请刷新能力信息', 409);
      return { available: true as const, capabilities };
    } catch (error) {
      if (generation !== this.generation || this.terminating || this.disposed)
        throw fail('供应商连接已变化，请刷新能力信息', 409);
      if ((error as { rpcCode?: number }).rpcCode === -32601)
        return { available: false as const, reason: '当前 CLI 不支持能力查询' };
      throw error;
    }
  }
  private queueChanged() {
    this.publish('workbench/queueChanged', { queued: this.store.publicQueue() });
  }
  private scheduleQueue() {
    if (this.disposed || this.drainTimer) return;
    this.drainTimer = setImmediate(() => {
      this.drainTimer = undefined;
      void this.drainQueue().catch((error) => {
        if (!this.disposed) {
          this.store.pauseQueue(undefined, (error as Error).message);
          this.queueChanged();
        }
      });
    });
  }
  dispose() {
    this.disposed = true;
    this.pendingBalances.clear();
    this.pendingModels.clear();
    this.turnProviders.clear();
    for (const job of this.balanceJobs.values()) job.controller.abort();
    this.balanceJobs.clear();
    for (const id of this.compactions.keys()) this.clearCompaction(id);
    if (this.drainTimer) clearImmediate(this.drainTimer);
  }
  async enqueue(
    id: string,
    input: Json[],
    options: Json,
    preview: string,
    beforeSubmit: () => void = () => {},
    textIndex?: number,
  ) {
    this.continuity?.assertSubmit(id);
    const generation = this.generation;
    await this.connect();
    const cwd = await fs.realpath(await this.threadDirectory(id));
    if (this.store.deletion(id) || (this.busy.has(id) && !this.starts.has(id)))
      throw fail('此会话正在处理其他操作或删除，请稍后重试', 409);
    if (this.disposed || this.terminating || generation !== this.generation)
      throw fail('执行器连接已变化，请稍后重新加入队列', 409);
    const rows = this.store.publicQueue();
    if (rows.length >= 100 || rows.filter((r) => r.threadId === id).length >= 20)
      throw fail('队列已满：每个会话最多 20 条，总计最多 100 条', 409);
    beforeSubmit();
    const queueId = this.store.enqueue(id, cwd, input, options, preview, textIndex);
    if (rows.some((r) => r.threadId === id && r.state === 'paused'))
      this.store.pauseQueue(id, '此会话队列已暂停，请核对历史后继续。');
    this.queueChanged();
    this.scheduleQueue();
    return { queued: true, id: queueId };
  }
  private editableQueue(id: string) {
    const row = this.store.queueRows().find((item) => item.id === id);
    if (!row) throw fail('消息已发送或已取消，无法再编辑；修改内容尚未保存', 409);
    if (row.state === 'sending') throw fail('消息正在提交，无法再编辑；修改内容尚未保存', 409);
    const input = row.input as Json[];
    const inferred = input.findLastIndex(
      (part) =>
        part.type === 'text' && typeof part.text === 'string' && part.text.startsWith(row.preview),
    );
    const index =
      row.textIndex ??
      (inferred >= 0 ? inferred : row.preview === '附件消息' || !row.preview.trim() ? -1 : -2);
    if (index < -1 || index >= input.length || (index >= 0 && input[index].type !== 'text'))
      throw fail('无法识别这条旧队列消息的正文，请取消后重新发送', 409);
    const revision = createHash('sha256')
      .update(JSON.stringify([input, row.options, row.preview, row.textIndex]))
      .digest('hex');
    return { row, input, index, revision };
  }
  queueMessage(id: string) {
    const { row, input, index, revision } = this.editableQueue(id);
    return {
      id,
      threadId: row.threadId,
      text: index >= 0 ? String(input[index].text || '') : '',
      revision,
      retainedParts: input.length - (index >= 0 ? 1 : 0),
    };
  }
  editQueue(id: string, text: string, expectedRevision: string) {
    const { row, input, index, revision } = this.editableQueue(id);
    if (revision !== expectedRevision)
      throw fail('消息已在其他页面修改，请保留当前草稿并重新打开编辑', 409);
    let nextIndex = index;
    if (text.trim()) {
      const part = { type: 'text', text, text_elements: [] };
      if (index >= 0) input[index] = part;
      else {
        nextIndex = input.length;
        input.push(part);
      }
    } else if (index >= 0) {
      input.splice(index, 1);
      nextIndex = -1;
    }
    if (!input.length) throw fail('请输入消息正文');
    // No awaits between the state/revision check and write: a queue claim cannot interleave.
    this.store.db
      .prepare(
        "UPDATE message_queue SET input=?,preview=?,text_index=? WHERE id=? AND state IN ('queued','paused')",
      )
      .run(JSON.stringify(input), text.trim() ? text.slice(0, 300) : '附件消息', nextIndex, row.id);
    this.queueChanged();
    this.scheduleQueue();
    return { ok: true };
  }
  queueAction(id: string, action: 'cancel' | 'resume') {
    const row = this.store.publicQueue().find((r) => r.id === id);
    if (!row) throw fail('排队消息不存在或已开始执行', 404);
    if (row.state === 'sending') throw fail('消息正在提交，请停止任务后再操作', 409);
    if (action === 'cancel') this.store.db.prepare('DELETE FROM message_queue WHERE id=?').run(id);
    else
      this.store.db
        .prepare(
          "UPDATE message_queue SET state='queued',error=NULL WHERE thread_id=? AND state='paused'",
        )
        .run(row.threadId);
    this.queueChanged();
    this.scheduleQueue();
    return { ok: true };
  }
  private async drainQueue() {
    if (this.draining || this.disposed || this.terminating || !this.bridge.ready) return;
    this.draining = true;
    try {
      const visited = new Set<string>();
      for (const row of this.store.queueRows()) {
        if (this.disposed || this.terminating || !this.bridge.ready) break;
        if (visited.has(row.threadId)) continue;
        visited.add(row.threadId);
        // Re-read state after awaits: cancellation or stopping may have changed this row.
        const current = this.store.publicQueue().find((r) => r.id === row.id);
        if (
          current?.state !== 'queued' ||
          this.active.has(row.threadId) ||
          this.busy.has(row.threadId)
        )
          continue;
        try {
          await fs.realpath(row.cwd);
        } catch {
          this.store.pauseQueue(row.threadId, '项目目录不可访问，请修复目录后继续队列。');
          this.queueChanged();
          continue;
        }
        if (
          new Set([...this.active.keys(), ...this.reservations.keys()]).size >= this.maxConcurrent
        )
          continue;
        const latest = this.store.queueRows().find((item) => item.id === row.id);
        if (latest?.state !== 'queued') continue;
        this.store.db
          .prepare("UPDATE message_queue SET state='sending',error=NULL WHERE id=?")
          .run(row.id);
        this.queueChanged();
        try {
          await this.send(
            row.threadId,
            latest.input,
            { ...latest.options, clientUserMessageId: row.id },
            false,
            true,
          );
          if (this.disposed) break;
          this.store.db.prepare('DELETE FROM message_queue WHERE id=?').run(row.id);
        } catch (error) {
          if (this.disposed) break;
          if ((error as { queueContention?: boolean }).queueContention)
            this.store.db
              .prepare("UPDATE message_queue SET state='queued' WHERE id=? AND state='sending'")
              .run(row.id);
          else
            this.store.pauseQueue(
              row.threadId,
              `发送未确认，请先核对历史：${(error as Error).message}`,
            );
        }
        this.queueChanged();
      }
    } finally {
      this.draining = false;
    }
  }
  async forceStop() {
    if (this.terminating) throw fail('执行器正在终止', 409);
    this.terminating = true;
    this.generation++;
    this.store.pauseQueue(undefined, '已强制终止执行器，队列已暂停。请核对文件和历史后继续。');
    this.queueChanged();
    try {
      await this.bridge.forceStop();
      return { ok: true };
    } finally {
      this.terminating = false;
    }
  }
  async switchProvider(id: string | null) {
    if (id === this.providers.activeId()) return this.providers.summary();
    await this.replaceProvider(this.providers.runtime(id), () => this.providers.activate(id));
    return this.providers.summary();
  }
  async saveProvider(input: z.output<typeof providerInput>, id: string) {
    if (id !== this.providers.activeId()) return this.providers.save(input, id);
    const previous = this.providers.runtime()!;
    await this.replaceProvider(
      { ...previous, ...input, apiKey: input.apiKey || previous.apiKey },
      () => this.providers.save(input, id, true),
    );
    return this.providers.list().find((p) => p.id === id)!;
  }
  private async replaceProvider(next: RuntimeProvider | null, commit: () => void) {
    if (
      this.terminating ||
      this.disposed ||
      this.active.size ||
      this.pending.size ||
      this.busy.size ||
      this.reservations.size ||
      this.draining ||
      this.store.publicQueue().length
    )
      throw fail('请先结束运行任务、处理审批并清空排队消息，再切换供应商', 409);
    const previous = this.providers.runtime();
    this.terminating = true;
    this.generation++;
    this.revision++;
    try {
      await this.bridge.restartProvider(next);
      commit();
      this.loaded.clear();
      this.live.clear();
    } catch {
      try {
        await this.bridge.restartProvider(previous);
      } catch {
        throw fail('切换失败，原供应商配置已保留；执行器暂未恢复连接，请重新连接', 502);
      }
      throw fail('供应商启动失败，已恢复原供应商；请检查配置及服务器日志', 502);
    } finally {
      this.terminating = false;
    }
    this.publish('workbench/providerChanged', { provider: this.providers.summary() });
  }
  private providerThreadOptions() {
    return {
      modelProvider: this.providers.activeId()
        ? managedProviderId
        : this.bridge.defaultModelProvider,
      model: this.providers.summary().model || this.bridge.defaultModel,
    };
  }
  async list(params: Json) {
    await this.connect();
    const result = await this.bridge.call('thread/list', {
      limit: 60,
      sortKey: 'updated_at',
      modelProviders: [],
      ...params,
    });
    const meta = this.store.metadata();
    return {
      ...result,
      data: result.data
        .filter((thread: Thread) => !this.titleThreads.has(thread.id))
        .map((thread: Thread) => ({ ...thread, ...meta[thread.id] })),
    };
  }
  async read(id: string, cursor?: string, options: { refreshBalance?: boolean } = {}) {
    const version = this.revision;
    await this.connect();
    const { thread } = await this.bridge
      .call('thread/read', { threadId: id, includeTurns: false })
      .catch((error) => {
        if (
          /thread (?:not found|not loaded)|no (?:saved )?thread found|unknown thread|no rollout found/i.test(
            error.message,
          )
        )
          throw fail('会话不存在或已删除', 404);
        throw error;
      });
    let nextCursor: string | null = null;
    if (thread.historyMode === 'paginated') {
      try {
        const page = await this.bridge.call('thread/turns/list', {
          threadId: id,
          limit: 30,
          itemsView: 'full',
          sortDirection: 'desc',
          ...(cursor ? { cursor } : {}),
        });
        thread.turns = page.data.reverse();
        nextCursor = page.nextCursor || null;
      } catch (error) {
        // 0.155.1 creates the thread before materializing its history. Opening
        // that fresh thread is valid and must show an empty composer.
        if ((error as Error).message.includes('not materialized yet')) thread.turns = [];
        else if ((error as Error).message.trim() === 'list_turns is not supported yet') {
          // 0.159.3 also returns this for an empty, not-yet-persisted thread.
          // Only treat it as empty when native metadata has no preview and its
          // rollout does not exist; never hide an existing history or I/O error.
          let unmaterialized = false;
          if (!cursor && !thread.preview && typeof thread.path === 'string') {
            try {
              await fs.stat(thread.path);
            } catch (cause) {
              if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
              unmaterialized = true;
            }
          }
          if (unmaterialized) thread.turns = [];
          else {
            // The CLI can change history backends between metadata and page reads.
            // Re-read native history instead of inventing an empty conversation.
            const result = await this.bridge.call('thread/read', {
              threadId: id,
              includeTurns: true,
            });
            thread.turns = result.thread.turns;
            thread.historyMode = result.thread.historyMode;
          }
        } else throw error;
      }
    } else {
      const result = await this.bridge.call('thread/read', { threadId: id, includeTurns: true });
      thread.turns = result.thread.turns;
    }
    if (version !== this.revision || this.store.deletion(id))
      throw fail('会话状态已变化，请重新读取', 409);
    this.rememberDirectory(id, thread.cwd);
    this.store.db
      .prepare(
        "INSERT INTO token_state(thread_id,name,cwd) VALUES(?,?,?) ON CONFLICT(thread_id) DO UPDATE SET cwd=excluded.cwd,name=CASE WHEN excluded.name<>'' THEN excluded.name ELSE token_state.name END",
      )
      .run(id, thread.name || thread.preview || '', thread.cwd);
    const nativeModels =
      typeof thread.path === 'string'
        ? await nativeTurnModels(thread.path, id)
        : new Map<string, string>();
    if (version !== this.revision || this.store.deletion(id))
      throw fail('会话状态已变化，请重新读取', 409);
    for (const turn of thread.turns) {
      this.store.recordUsageTurn(id, turn);
      const model = nativeModels.get(turn.id) || modelName(turn.model);
      if (model) this.store.saveTurnModel(id, turn.id, model);
    }
    const turnModels = this.store.threadModels(id);
    const usage = this.store.threadUsage(id);
    const balances = this.store.threadBalances(id);
    // Existing conversations predate completion snapshots. Initialize only the
    // latest finished turn on first open, explicitly labeled as a current query.
    const latestFinished = !cursor && thread.turns.findLast((turn) => turn.status !== 'inProgress');
    if (
      options.refreshBalance !== false &&
      latestFinished &&
      !balances.has(latestFinished.id) &&
      !this.balanceJobs.has(latestFinished.id)
    ) {
      const provider = this.providers.runtime();
      const balance = {
        status: 'loading' as const,
        checkedAt: Date.now(),
        providerName: provider?.name,
        source: 'opened' as const,
      };
      this.store.saveBalance(id, latestFinished.id, balance);
      balances.set(latestFinished.id, balance);
      void this.refreshBalance(id, latestFinished.id, provider, 'opened');
    }
    thread.tokenUsage ||= usage.snapshot;
    thread.turns = thread.turns.map((turn) => ({
      ...turn,
      model: turnModels.get(turn.id),
      ...usage.turns.get(turn.id),
      upstreamBalance: balances.get(turn.id),
    }));
    const merged = overlayLive(
      {
        ...thread,
        turns: this.store.metadata()[id]?.interrupted
          ? thread.turns.map((turn) =>
              turn.status === 'inProgress' ? { ...turn, status: 'interrupted' } : turn,
            )
          : thread.turns,
      },
      cursor ? undefined : this.live.get(id),
    );
    merged.turns = merged.turns.map((turn) => ({
      ...turn,
      model: turnModels.get(turn.id) || turn.model,
    }));
    return {
      thread: {
        ...merged,
        ...this.store.metadata()[id],
      },
      nextCursor,
      cursor: this.store.cursor(),
    };
  }
  async create(cwd: string, options: Json) {
    return this.exclusive(`create:${randomUUID()}`, async () => {
      await this.connect();
      const projectOptions = this.projectThreadOptions(cwd);
      const result = await this.bridge.call('thread/start', {
        cwd,
        ...this.providerThreadOptions(),
        ...options,
        ...projectOptions,
      });
      this.store.saveThreadExecution(result.thread.id, threadExecution(result, options));
      this.loaded.set(result.thread.id, cwd);
      this.appliedProjectSettings.set(result.thread.id, JSON.stringify(projectOptions));
      return result;
    });
  }
  private projectThreadOptions(cwd: string) {
    const project = this.store.projectForDirectory(cwd);
    const context = nativeProjectContext(project ? projectContextSchema.parse(project) : undefined);
    return {
      developerInstructions: project?.systemPrompt || '',
      ...(context ? { config: context } : {}),
    };
  }
  private rememberDirectory(id: string, cwd: string) {
    this.directories.delete(id);
    this.directories.set(id, { cwd, until: Date.now() + 30000 });
    if (this.directories.size > 500) this.directories.delete(this.directories.keys().next().value!);
  }
  async threadDirectory(id: string) {
    if (this.store.deletion(id)) throw fail('此会话正在删除，请先完成清理', 409);
    const version = this.revision;
    const cached = this.directories.get(id);
    if (cached && cached.until > Date.now()) return cached.cwd;
    await this.connect();
    const { thread } = await this.bridge.call('thread/read', { threadId: id, includeTurns: false });
    if (version !== this.revision || this.store.deletion(id))
      throw fail('会话状态已变化，请重试', 409);
    this.rememberDirectory(id, thread.cwd);
    return thread.cwd as string;
  }
  async searchFiles(cwd: string, query: string) {
    await this.connect();
    const generation = this.generation;
    const result = await this.bridge.call('fuzzyFileSearch', {
      query,
      roots: [cwd],
      cancellationToken: null,
    });
    if (generation !== this.generation || this.disposed || this.terminating)
      throw fail('执行器连接已变化，请重新搜索', 409);
    return result;
  }
  async exclusive<T>(id: string, fn: () => Promise<T>) {
    if (this.terminating || this.disposed) throw fail('执行器正在切换或停止，请稍后重试', 409);
    if (this.busy.has(id)) throw fail('此会话正在处理另一个操作，请稍后再试', 409);
    this.busy.add(id);
    try {
      return await fn();
    } finally {
      this.busy.delete(id);
      this.starts.delete(id);
      this.scheduleQueue();
    }
  }
  async maintenance<T>(fn: () => Promise<T>, stopExecutor = false) {
    if (
      this.terminating ||
      this.disposed ||
      this.active.size ||
      this.pending.size ||
      this.busy.size ||
      this.reservations.size ||
      this.draining ||
      this.balanceJobs.size ||
      this.store.publicQueue().length
    )
      throw fail('请先结束任务、处理审批并清空队列，再修改执行器配置或迁移数据', 409);
    this.terminating = true;
    this.generation++;
    this.revision++;
    try {
      if (stopExecutor) await this.bridge.forceStop();
      return await fn();
    } finally {
      this.loaded.clear();
      this.appliedProjectSettings.clear();
      this.live.clear();
      this.directories.clear();
      this.terminating = false;
      if (stopExecutor) {
        this.bridge.configureProvider(this.providers.runtime());
        try {
          await this.connect();
        } catch (error) {
          this.bridge.error = (error as Error).message;
          this.publish('workbench/warning', {
            message: '数据或配置已保存，Codex 暂未恢复连接，请在设置中重新连接。',
          });
        }
      }
      this.publish('workbench/configurationChanged', {});
    }
  }
  hasPendingOperation(id: string) {
    return this.busy.has(id);
  }
  cachedTurn(id: string, turnId: string) {
    return this.live.get(id)?.turns.find((turn) => turn.id === turnId);
  }
  async send(
    id: string,
    input: Json[],
    options: Json,
    steer: boolean,
    fromQueue = false,
    beforeSubmit: () => void = () => {},
    operation?: { type: 'review'; target: ReviewTarget } | { type: 'compact' },
    preview = input
      .filter((item) => item.type === 'text')
      .map((item) => item.text || '')
      .join('\n') || '附件消息',
    textIndex?: number,
  ) {
    return this.exclusive(id, async () => {
      this.continuity?.assertSubmit(
        id,
        typeof options.collaborationRunId === 'string' ? options.collaborationRunId : undefined,
      );
      if (this.store.deletion(id)) throw fail('此会话正在删除，请先完成清理', 409);
      const generation = this.generation;
      const stopToken = { stopped: false };
      this.starts.set(id, stopToken);
      const checkStopped = () => {
        if (
          this.disposed ||
          this.terminating ||
          generation !== this.generation ||
          stopToken.stopped
        )
          throw fail('发送过程已被停止，请核对历史后重试', 409);
        if (
          fromQueue &&
          this.store.publicQueue().find((r) => r.id === options.clientUserMessageId)?.state !==
            'sending'
        )
          throw fail('队列已暂停或取消', 409);
      };
      await this.connect();
      checkStopped();
      const running = this.active.get(id);
      if (steer) {
        if (this.compactions.has(id)) throw fail('压缩过程中请加入队列，或等待完成', 409);
        if (!running) throw fail('任务已结束，请作为新消息发送', 409);
        beforeSubmit();
        return this.bridge.call('turn/steer', {
          threadId: id,
          expectedTurnId: running.turnId,
          input,
        });
      }
      if (running) {
        if (!fromQueue && !operation && !options.collaborationRunId)
          return this.enqueue(id, input, options, preview, beforeSubmit, textIndex);
        throw fail('此会话正在运行，可补充指令或先停止', 409);
      }
      if (
        operation &&
        [...this.pending.values()].some((r) => !r.params.threadId || r.params.threadId === id)
      )
        throw fail('请先处理待办审批或问题', 409);
      if (!fromQueue && this.store.publicQueue().some((r) => r.threadId === id)) {
        if (!operation && !options.collaborationRunId)
          return this.enqueue(id, input, options, preview, beforeSubmit, textIndex);
        throw fail('此会话有排队消息，请加入队列或先处理队列', 409);
      }
      const { thread } = await this.bridge.call('thread/read', {
        threadId: id,
        includeTurns: false,
      });
      const cwd = await fs.realpath(thread.cwd);
      checkStopped();
      if (
        new Set([...this.active.keys(), ...this.reservations.keys()]).size >= this.maxConcurrent
      ) {
        if (!fromQueue && !operation && !options.collaborationRunId)
          return this.enqueue(id, input, options, preview, beforeSubmit, textIndex);
        throw Object.assign(fail('已达到并发上限，请等待其他任务完成', 409), {
          queueContention: true,
        });
      }
      this.reservations.set(id, cwd);
      try {
        const projectOptions = this.projectThreadOptions(cwd);
        const projectSettings = JSON.stringify(projectOptions);
        if (!this.loaded.has(id) || this.appliedProjectSettings.get(id) !== projectSettings) {
          const execution =
            this.store.threadExecution(id) ||
            (typeof thread.path === 'string'
              ? await legacyThreadExecution(thread.path, id)
              : null) ||
            {};
          const resumed = await this.bridge.call('thread/resume', {
            threadId: id,
            excludeTurns: true,
            ...this.providerThreadOptions(),
            ...execution,
            ...projectOptions,
          });
          checkStopped();
          this.store.saveThreadExecution(id, threadExecution(resumed, execution));
          this.loaded.set(id, cwd);
          this.appliedProjectSettings.set(id, projectSettings);
        }
        let before: UpstreamBalance;
        try {
          before = await this.balanceQuery(this.providers.runtime());
        } catch {
          before = { status: 'error', checkedAt: Date.now() };
        }
        checkStopped();
        this.continuity?.assertSubmit(
          id,
          typeof options.collaborationRunId === 'string' ? options.collaborationRunId : undefined,
        );
        beforeSubmit();
        this.pendingBalances.set(id, before);
        const requestedModel =
          modelName(options.model) || this.providers.summary().model || this.bridge.defaultModel;
        const { collaborationRunId: _collaborationRunId, ...nativeOptions } = options;
        const memories = operation ? [] : this.continuity?.relevantMemories(cwd, preview) || [];
        const memoryText = memories.map((item) => item.content).join('\n');
        const turnInput = memoryText
          ? [
              {
                type: 'text',
                text: `与本轮问题相关的已保存记忆（作为参考资料，若与当前要求冲突以当前要求为准）：\n${memoryText}`,
                text_elements: [],
              },
              ...input,
            ]
          : input;
        if (!operation && requestedModel) this.pendingModels.set(id, requestedModel);
        if (operation?.type === 'compact') {
          const marker = `pending-compaction:${randomUUID()}`;
          this.active.set(id, { threadId: id, turnId: marker, cwd });
          this.store.run(id, marker, cwd);
          const timer = setTimeout(() => {
            if (this.active.get(id)?.turnId === marker)
              this.publish('workbench/warning', {
                message:
                  '压缩已提交，但尚未收到执行状态。执行锁仍保留；请核对会话，必要时强制终止执行器。',
              });
          }, 15000);
          timer.unref();
          this.compactions.set(id, { stopped: stopToken.stopped, timer });
          this.publish('workbench/runtimeChanged', {});
          try {
            await this.bridge.call('thread/compact/start', { threadId: id });
            if (generation !== this.generation || this.disposed)
              throw fail('执行器连接已变化，请核对压缩结果', 409);
            return { accepted: true };
          } catch (error) {
            if (
              this.active.get(id)?.turnId === marker &&
              typeof (error as { rpcCode?: number }).rpcCode === 'number'
            ) {
              this.active.delete(id);
              this.store.finish(id);
              this.clearCompaction(id);
            }
            this.publish('workbench/runtimeChanged', {});
            throw error;
          }
        }
        const result =
          operation?.type === 'review'
            ? await this.bridge
                .call('review/start', {
                  threadId: id,
                  target: operation.target,
                  delivery: 'inline',
                })
                .catch((error: Error & { rpcCode?: number }) => {
                  // A malformed/ambiguous start result can hide an executing turn.
                  // Rebuild this owned connection before accepting another task.
                  if (typeof error.rpcCode !== 'number' && generation === this.generation)
                    this.bridge.stop();
                  throw error;
                })
            : await this.bridge.call('turn/start', {
                threadId: id,
                input: turnInput,
                ...nativeOptions,
                model: requestedModel,
              });
        if (generation !== this.generation || this.disposed)
          throw fail('执行器连接已变化，请核对历史确认发送结果', 409);
        if (result.turn) this.recordBalanceStart(id, result.turn.id);
        if (result.turn && memories.length)
          this.continuity?.recordMemoryUse(
            id,
            result.turn.id,
            memories.map((item) => item.id),
          );
        if (result.turn) {
          const model =
            modelName(result.turn.model) ||
            this.store.threadModels(id).get(result.turn.id) ||
            this.pendingModels.get(id);
          if (model) {
            result.turn.model = model;
            this.store.saveTurnModel(id, result.turn.id, model);
            this.notification('workbench/turnModelUpdated', {
              threadId: id,
              turnId: result.turn.id,
              model,
            });
          }
        }
        if (
          result.turn?.status === 'inProgress' &&
          !this.completed.has(result.turn.id) &&
          !this.active.has(id) &&
          !this.live
            .get(id)
            ?.turns.some((t) => t.id === result.turn.id && t.status !== 'inProgress')
        ) {
          this.active.set(id, { threadId: id, turnId: result.turn.id, cwd });
          this.store.run(id, result.turn.id, cwd);
        }
        if (stopToken.stopped && this.active.has(id)) {
          await this.bridge.call('turn/interrupt', {
            threadId: id,
            turnId: this.active.get(id)!.turnId,
          });
        }
        return result;
      } finally {
        this.pendingModels.delete(id);
        if (!this.compactions.has(id)) this.pendingBalances.delete(id);
        this.reservations.delete(id);
      }
    });
  }
  async interrupt(id: string) {
    this.revision++;
    const starting = this.starts.get(id);
    if (starting) starting.stopped = true;
    const compact = this.compactions.get(id);
    if (compact) compact.stopped = true;
    this.store.pauseQueue(id, '已请求停止任务，后续队列已暂停。');
    this.queueChanged();
    const run = this.active.get(id);
    if (run?.turnId.startsWith('pending-compaction:')) return { stopping: true };
    if (!run) {
      if (this.reservations.has(id)) return { stopping: true };
      throw fail('当前没有运行中的任务', 409);
    }
    return this.bridge.call('turn/interrupt', { threadId: id, turnId: run.turnId });
  }
  async action(id: string, action: string, value?: string) {
    return this.exclusive(id, async () => {
      if (this.store.deletion(id)) throw fail('此会话正在删除，请先完成清理', 409);
      await this.connect();
      if (this.active.has(id) && action !== 'rename') throw fail('请先停止此会话的任务', 409);
      if (
        ['archive', 'fork'].includes(action) &&
        this.store.publicQueue().some((r) => r.threadId === id)
      )
        throw fail('请先取消此会话的排队消息', 409);
      const method = (
        {
          archive: 'thread/archive',
          unarchive: 'thread/unarchive',
          fork: 'thread/fork',
          rename: 'thread/name/set',
        } as Record<string, string>
      )[action];
      if (!method) throw fail('未知操作');
      let execution = this.store.threadExecution(id);
      let projectOptions = {};
      if (action === 'fork') {
        const { thread } = await this.bridge.call('thread/read', {
          threadId: id,
          includeTurns: false,
        });
        execution ??=
          typeof thread.path === 'string' ? await legacyThreadExecution(thread.path, id) : null;
        projectOptions = this.projectThreadOptions(await fs.realpath(thread.cwd));
      }
      const result = await this.bridge.call(method, {
        threadId: id,
        ...(action === 'rename' ? { name: value } : {}),
        ...(action === 'fork' ? { excludeTurns: true, ...execution, ...projectOptions } : {}),
      });
      if (action === 'fork' && result && typeof result === 'object' && 'thread' in result) {
        const fork = result as { thread: Thread } & Json;
        this.store.saveThreadExecution(fork.thread.id, threadExecution(fork, execution || {}));
      }
      this.publish('workbench/threadsChanged', {});
      return result;
    });
  }
  clearCache() {
    if (
      this.active.size ||
      this.busy.size ||
      this.reservations.size ||
      this.pending.size ||
      this.draining ||
      this.terminating
    )
      throw fail('请等待任务和操作结束后清除缓存', 409);
    this.directories.clear();
    this.live.clear();
    const result = this.store.clearCache();
    this.publish('workbench/cacheCleared', {});
    return result;
  }
  async deleteThread(id: string) {
    return this.exclusive(id, async () => {
      if (
        this.active.has(id) ||
        this.reservations.has(id) ||
        [...this.pending.values()].some((r) => r.params.threadId === id)
      )
        throw fail('请先停止此会话并处理待审批操作，再永久删除', 409);
      const pending = this.store.deletion(id);
      if (!pending?.native_deleted) await this.connect();
      if (!pending) {
        const { thread } = await this.bridge.call('thread/read', {
          threadId: id,
          includeTurns: false,
        });
        if (thread.status?.type === 'active')
          throw fail('此会话仍在其他客户端执行，请先停止任务', 409);
      }
      await attachmentDirectories(this.store, id);
      this.revision++;
      this.directories.delete(id);
      this.store.db.prepare('INSERT OR IGNORE INTO thread_deletions(thread_id) VALUES(?)').run(id);
      if (!pending?.native_deleted) {
        try {
          await this.bridge.call('thread/delete', { threadId: id });
        } catch (error) {
          const message = (error as Error).message;
          if ((error as Error & { rpcCode?: number }).rpcCode === -32601) {
            this.store.db
              .prepare('DELETE FROM thread_deletions WHERE thread_id=? AND native_deleted=0')
              .run(id);
            throw fail('当前 Codex CLI 不支持永久删除，请升级 CLI 后重试；会话和附件已保留。', 501);
          }
          // Only a previously journaled deletion may recover from a missing native thread.
          if (
            !pending ||
            !/thread (?:not found|not loaded)|no (?:saved )?thread found|unknown thread/i.test(
              message,
            )
          )
            throw fail(`Codex 原生删除未完成：${message}。可在设置中继续清理。`, 502);
        }
        this.store.db
          .prepare('UPDATE thread_deletions SET native_deleted=1 WHERE thread_id=?')
          .run(id);
      }
      const attachments = await removeAttachments(this.store, id);
      for (const [turnId, job] of this.balanceJobs)
        if (job.threadId === id) {
          job.controller.abort();
          this.balanceJobs.delete(turnId);
        }
      this.store.deleteThreadData(id);
      this.loaded.delete(id);
      this.live.delete(id);
      this.directories.delete(id);
      this.publish('workbench/threadDeleted', { threadId: id });
      this.queueChanged();
      return { ok: true, attachments };
    });
  }
  answer(
    id: string,
    body: { decision?: string; answers?: Record<string, string>; content?: unknown },
  ) {
    const request = this.pending.get(id);
    if (!request) throw fail('请求已处理或已失效', 409);
    let result: Json;
    if (request.method === 'item/tool/requestUserInput') {
      const answers: Json = {};
      for (const question of request.params.questions || []) {
        const answer = body.answers?.[question.id];
        if (typeof answer !== 'string' || !answer.trim() || answer.length > 16000)
          throw fail('请回答所有问题');
        answers[question.id] = { answers: [answer] };
      }
      result = { answers };
    } else if (request.method === 'item/permissions/requestApproval') {
      if (!['accept', 'decline'].includes(body.decision || '')) throw fail('无效审批结果');
      result = {
        permissions:
          body.decision === 'accept'
            ? Object.fromEntries(
                Object.entries(request.params.permissions || {}).filter(([, v]) => v != null),
              )
            : {},
        scope: 'turn',
      };
    } else if (request.method === 'mcpServer/elicitation/request') {
      if (!['accept', 'decline', 'cancel'].includes(body.decision || ''))
        throw fail('无效审批结果');
      result = { action: body.decision, content: body.content ?? null, _meta: null };
    } else {
      if (!['accept', 'decline', 'cancel'].includes(body.decision || ''))
        throw fail('无效审批结果');
      result = { decision: body.decision };
    }
    this.bridge.respond(request.rpcId, result);
    this.pending.delete(id);
    this.publish('workbench/requestResolved', { id });
  }
}
