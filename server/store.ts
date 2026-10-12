import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  Project,
  WorkEvent,
  Json,
  EventParams,
  TokenUsage,
  TokenCounts,
  UsageStats,
  UpstreamBalance,
  Turn,
} from '../shared/types.js';
import { usageStats } from './usage-stats.js';
import { accumulateTokens, tokenTotal } from '../shared/tokens.js';
import { backfillCachedTokens } from './cache-usage.js';
import { threadExecutionSchema, type ThreadExecution } from './thread-execution.js';
import { projectContextSchema } from './project-context.js';
import type { ProjectContextSettings } from '../shared/project-context.js';

export class Store {
  db: DatabaseSync;
  private eventBytes = 0;
  private eventRows = 0;
  constructor(
    public dir: string,
    recoverRuns = false,
    private eventBudget = 32 * 1024 * 1024,
  ) {
    mkdirSync(dir, { recursive: true });
    this.db = new DatabaseSync(path.join(dir, 'workbench.sqlite'));
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA secure_delete=ON;
      CREATE TABLE IF NOT EXISTS migrations(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT UNIQUE NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS thread_meta(id TEXT PRIMARY KEY, pinned INTEGER NOT NULL DEFAULT 0, interrupted INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS runs(thread_id TEXT PRIMARY KEY, turn_id TEXT NOT NULL, cwd TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT, method TEXT NOT NULL, params TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS events_at ON events(at);
      CREATE TABLE IF NOT EXISTS attachments(id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, path TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS message_queue(id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, cwd TEXT NOT NULL, input TEXT NOT NULL, options TEXT NOT NULL, preview TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'queued', created_at INTEGER NOT NULL, error TEXT);
      CREATE INDEX IF NOT EXISTS message_queue_thread ON message_queue(thread_id,created_at);
      CREATE TABLE IF NOT EXISTS thread_deletions(thread_id TEXT PRIMARY KEY, native_deleted INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS thread_execution(thread_id TEXT PRIMARY KEY, settings TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS token_state(thread_id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', cwd TEXT NOT NULL DEFAULT '', usage TEXT NOT NULL DEFAULT '{}');
      CREATE TABLE IF NOT EXISTS token_turns(thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, counts TEXT NOT NULL, partial INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL, PRIMARY KEY(thread_id,turn_id));
      CREATE TABLE IF NOT EXISTS usage_turns(thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, prompt TEXT NOT NULL DEFAULT '', started_at INTEGER, completed_at INTEGER, status TEXT NOT NULL DEFAULT '', PRIMARY KEY(thread_id,turn_id));
      CREATE TABLE IF NOT EXISTS turn_balances(thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, balance TEXT NOT NULL, PRIMARY KEY(thread_id,turn_id));
      CREATE TABLE IF NOT EXISTS turn_models(thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, model TEXT NOT NULL, PRIMARY KEY(thread_id,turn_id));
      CREATE TABLE IF NOT EXISTS memories(id TEXT PRIMARY KEY, project_id TEXT, content TEXT NOT NULL, source_thread_id TEXT, enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS memories_scope ON memories(project_id,enabled,updated_at);
      CREATE TABLE IF NOT EXISTS memory_uses(thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, memory_ids TEXT NOT NULL, PRIMARY KEY(thread_id,turn_id));
      CREATE TABLE IF NOT EXISTS collaboration_groups(id TEXT PRIMARY KEY, name TEXT NOT NULL, goal TEXT NOT NULL, members TEXT NOT NULL, max_steps INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS collaboration_runs(id TEXT PRIMARY KEY, group_id TEXT NOT NULL, status TEXT NOT NULL, step_index INTEGER NOT NULL DEFAULT 0, steps_done INTEGER NOT NULL DEFAULT 0, next_input TEXT NOT NULL, current_thread_id TEXT, current_turn_id TEXT, error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS collaboration_runs_status ON collaboration_runs(status,updated_at);
      CREATE TABLE IF NOT EXISTS collaboration_handoffs(id TEXT PRIMARY KEY, run_id TEXT NOT NULL, step_index INTEGER NOT NULL, source_thread_id TEXT NOT NULL, source_turn_id TEXT NOT NULL, target_thread_id TEXT, content TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE(run_id,source_turn_id));
      INSERT OR IGNORE INTO migrations VALUES(7, unixepoch());
      CREATE INDEX IF NOT EXISTS token_turns_updated ON token_turns(updated_at);
      INSERT OR IGNORE INTO migrations VALUES(3, unixepoch());
      INSERT OR IGNORE INTO migrations VALUES(2, unixepoch());
      INSERT OR IGNORE INTO migrations VALUES(1, unixepoch());`);
    if (
      !this.db
        .prepare('PRAGMA table_info(attachments)')
        .all()
        .some((r) => r.name === 'state')
    ) {
      // Existing files may already be referenced by native history; never auto-delete them.
      this.db.exec("ALTER TABLE attachments ADD COLUMN state TEXT NOT NULL DEFAULT 'used'");
    }
    if (
      !this.db
        .prepare('PRAGMA table_info(message_queue)')
        .all()
        .some((row) => row.name === 'text_index')
    ) {
      this.db.exec('ALTER TABLE message_queue ADD COLUMN text_index INTEGER');
    }
    this.db.exec('INSERT OR IGNORE INTO migrations VALUES(4, unixepoch())');
    this.db.exec('INSERT OR IGNORE INTO migrations VALUES(5, unixepoch())');
    if (!this.db.prepare('SELECT 1 FROM migrations WHERE version=6').get()) {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        for (const row of this.db
          .prepare(
            "SELECT method,params,at FROM events WHERE method IN ('thread/started','thread/name/updated','item/completed','thread/tokenUsage/updated') ORDER BY seq",
          )
          .iterate())
          this.observeUsage(String(row.method), JSON.parse(String(row.params)), Number(row.at));
        this.db.exec('INSERT INTO migrations VALUES(6, unixepoch()); COMMIT');
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    }
    if (!this.db.prepare('SELECT 1 FROM migrations WHERE version=8').get()) {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        for (const row of this.db
          .prepare(
            "SELECT method,params,at FROM events WHERE method IN ('turn/started','turn/completed','item/completed') ORDER BY seq",
          )
          .iterate())
          this.observeUsage(String(row.method), JSON.parse(String(row.params)), Number(row.at));
        this.db.exec('INSERT INTO migrations VALUES(8, unixepoch()); COMMIT');
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    }
    backfillCachedTokens(this.db);
    if (recoverRuns)
      this.db.exec(
        `UPDATE turn_balances SET balance=json_set(balance,'$.status','error') WHERE json_extract(balance,'$.status')='loading'`,
      );
    if (recoverRuns) this.db.exec("UPDATE attachments SET state='pending' WHERE state='deleting'");
    this.measureEvents();
    this.trimEvents();
    if (recoverRuns)
      this.db
        .exec(`INSERT INTO thread_meta(id, interrupted) SELECT thread_id, 1 FROM runs WHERE true
      ON CONFLICT(id) DO UPDATE SET interrupted=1; DELETE FROM runs;`);
    if (recoverRuns)
      this.pauseQueue(undefined, '服务已重启，请核对历史后继续队列；提交中的消息不会自动重发。');
  }
  get(key: string) {
    return (
      this.db.prepare('SELECT value FROM settings WHERE key=?').get(key) as
        { value: string } | undefined
    )?.value;
  }
  set(key: string, value: string) {
    this.db
      .prepare(
        'INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      )
      .run(key, value);
  }
  projects(): Project[] {
    const projects = this.db
      .prepare('SELECT id,name,path,created_at AS createdAt FROM projects ORDER BY created_at')
      .all() as Pick<Project, 'id' | 'name' | 'path' | 'createdAt'>[];
    return projects.map((project) => ({
      ...project,
      systemPrompt: this.get(`projectPrompt:${project.id}`) || '',
      ...projectContextSchema.parse(JSON.parse(this.get(`projectContext:${project.id}`) || '{}')),
    }));
  }
  projectForDirectory(cwd: string) {
    const normalize = (value: string) =>
      process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
    return this.projects().find((project) => normalize(project.path) === normalize(cwd));
  }
  projectPrompt(cwd: string) {
    return this.projectForDirectory(cwd)?.systemPrompt || '';
  }
  reload() {
    const next = new Store(this.dir, true);
    this.db = next.db;
    this.eventBytes = next.eventBytes;
    this.eventRows = next.eventRows;
  }
  addProject(name: string, cwd: string, context: Partial<ProjectContextSettings> = {}) {
    const settings = projectContextSchema.parse(context);
    const project = { id: randomUUID(), name, path: cwd, createdAt: Date.now(), ...settings };
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db
        .prepare('INSERT INTO projects VALUES(?,?,?,?)')
        .run(project.id, name, cwd, project.createdAt);
      this.set(`projectContext:${project.id}`, JSON.stringify(settings));
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return project;
  }
  metadata() {
    return Object.fromEntries(
      this.db
        .prepare('SELECT * FROM thread_meta')
        .all()
        .map((r) => [r.id, { pinned: !!r.pinned, interrupted: !!r.interrupted }]),
    );
  }
  pin(id: string, pinned: boolean) {
    this.db
      .prepare(
        'INSERT INTO thread_meta(id,pinned) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET pinned=excluded.pinned',
      )
      .run(id, +pinned);
  }
  threadExecution(id: string): ThreadExecution | null {
    const row = this.db.prepare('SELECT settings FROM thread_execution WHERE thread_id=?').get(id);
    return row ? threadExecutionSchema.parse(JSON.parse(String(row.settings))) : null;
  }
  saveThreadExecution(id: string, settings: ThreadExecution) {
    const parsed = threadExecutionSchema.parse(settings);
    this.db
      .prepare(
        'INSERT INTO thread_execution VALUES(?,?) ON CONFLICT(thread_id) DO UPDATE SET settings=excluded.settings',
      )
      .run(id, JSON.stringify(parsed));
  }
  run(threadId: string, turnId: string, cwd: string) {
    this.db.prepare('INSERT OR REPLACE INTO runs VALUES(?,?,?)').run(threadId, turnId, cwd);
    this.db.prepare('UPDATE thread_meta SET interrupted=0 WHERE id=?').run(threadId);
  }
  finish(threadId: string) {
    this.db.prepare('DELETE FROM runs WHERE thread_id=?').run(threadId);
  }
  interruptRuns() {
    this.db.exec(
      `INSERT INTO thread_meta(id,interrupted) SELECT thread_id,1 FROM runs WHERE true ON CONFLICT(id) DO UPDATE SET interrupted=1; DELETE FROM runs;`,
    );
  }
  event(method: string, params: EventParams): WorkEvent {
    const at = Date.now();
    const atomic = method === 'thread/tokenUsage/updated';
    let encoded: string;
    let seq: number;
    if (atomic) this.db.exec('BEGIN IMMEDIATE');
    try {
      params = this.observeUsage(method, params, at);
      encoded = JSON.stringify(params);
      if (Buffer.byteLength(encoded) > Math.min(1024 * 1024, this.eventBudget / 4)) {
        method = 'workbench/resyncRequired';
        params = {
          threadId: params.threadId || params.thread?.id,
          message: '大段输出已保存到会话历史，正在重新读取。',
        };
        encoded = JSON.stringify(params);
      }
      const result = this.db
        .prepare('INSERT INTO events(method,params,at) VALUES(?,?,?)')
        .run(method, encoded, at);
      seq = Number(result.lastInsertRowid);
      if (atomic) this.db.exec('COMMIT');
    } catch (error) {
      if (atomic) this.db.exec('ROLLBACK');
      throw error;
    }
    this.eventBytes += Buffer.byteLength(encoded);
    this.eventRows++;
    this.trimEvents();
    return { seq, method, params, at };
  }
  private observeUsage(method: string, params: EventParams, at: number): EventParams {
    const id = params.threadId || params.thread?.id;
    if (
      !id ||
      ![
        'thread/started',
        'thread/name/updated',
        'item/completed',
        'thread/tokenUsage/updated',
        'turn/started',
        'turn/completed',
      ].includes(method)
    )
      return params;
    this.db.prepare('INSERT OR IGNORE INTO token_state(thread_id) VALUES(?)').run(id);
    if (method === 'thread/started' && params.thread) {
      const thread = params.thread;
      this.db
        .prepare('UPDATE token_state SET name=?,cwd=? WHERE thread_id=?')
        .run(thread.name || thread.preview || '', thread.cwd, id);
      if (!thread.preview && !thread.turns.length)
        this.db.prepare("UPDATE token_state SET usage=? WHERE thread_id=? AND usage='{}'").run(
          JSON.stringify({
            total: {
              totalTokens: 0,
              inputTokens: 0,
              cachedInputTokens: 0,
              outputTokens: 0,
              reasoningOutputTokens: 0,
            },
          }),
          id,
        );
    }
    if (method === 'thread/name/updated')
      this.db
        .prepare('UPDATE token_state SET name=? WHERE thread_id=?')
        .run(params.threadName ?? params.name ?? '', id);
    if (method === 'item/completed' && params.item?.type === 'userMessage') {
      const content = params.item.content || [];
      const preview = content
        .filter((part) => typeof part !== 'string' && part.type === 'text')
        .map((part) => (typeof part === 'string' ? part : part.text || ''))
        .join(' ')
        .slice(0, 200);
      if (preview)
        this.db
          .prepare("UPDATE token_state SET name=? WHERE thread_id=? AND name=''")
          .run(preview, id);
    }
    if ((method === 'turn/started' || method === 'turn/completed') && params.turn)
      this.recordUsageTurn(id, {
        ...params.turn,
        startedAt: params.turn.startedAt ?? (method === 'turn/started' ? at / 1000 : undefined),
        completedAt:
          params.turn.completedAt ?? (method === 'turn/completed' ? at / 1000 : undefined),
      });
    if (method === 'item/completed' && params.turnId && params.item?.type === 'userMessage')
      this.recordUsageTurn(id, { id: params.turnId, status: '', items: [params.item] });
    if (method !== 'thread/tokenUsage/updated' || !params.tokenUsage) return params;
    const previous = JSON.parse(
      String(this.db.prepare('SELECT usage FROM token_state WHERE thread_id=?').get(id)!.usage),
    ) as TokenUsage;
    const turnId =
      params.turnId ||
      String(this.db.prepare('SELECT turn_id FROM runs WHERE thread_id=?').get(id)?.turn_id || '');
    this.db
      .prepare('UPDATE token_state SET usage=? WHERE thread_id=?')
      .run(JSON.stringify(params.tokenUsage), id);
    if (!turnId) return params;
    const existing = this.db
      .prepare('SELECT counts,partial FROM token_turns WHERE thread_id=? AND turn_id=?')
      .get(id, turnId);
    const result = accumulateTokens(
      params.tokenUsage,
      previous,
      existing ? (JSON.parse(String(existing.counts)) as TokenCounts) : {},
    );
    if (!Object.keys(result.counts).length) return params;
    const total = tokenTotal(result.counts);
    if (total !== undefined) result.counts.totalTokens = total;
    const partial = result.partial || !!existing?.partial;
    this.db
      .prepare(
        'INSERT INTO token_turns VALUES(?,?,?,?,?) ON CONFLICT(thread_id,turn_id) DO UPDATE SET counts=excluded.counts,partial=excluded.partial,updated_at=excluded.updated_at',
      )
      .run(id, turnId, JSON.stringify(result.counts), +partial, at);
    return { ...params, turnId, turnTokenUsage: result.counts, tokenUsagePartial: partial };
  }
  saveBalance(threadId: string, turnId: string, balance: UpstreamBalance) {
    this.db
      .prepare(
        'INSERT INTO turn_balances VALUES(?,?,?) ON CONFLICT(thread_id,turn_id) DO UPDATE SET balance=excluded.balance',
      )
      .run(threadId, turnId, JSON.stringify(balance));
  }
  threadBalances(id: string): Map<string, UpstreamBalance> {
    return new Map(
      this.db
        .prepare('SELECT turn_id,balance FROM turn_balances WHERE thread_id=?')
        .all(id)
        .map((row) => [String(row.turn_id), JSON.parse(String(row.balance))]),
    );
  }
  threadUsage(id: string) {
    const snapshot = this.db.prepare('SELECT usage FROM token_state WHERE thread_id=?').get(id);
    return {
      snapshot: snapshot ? (JSON.parse(String(snapshot.usage)) as TokenUsage) : undefined,
      turns: new Map(
        this.db
          .prepare('SELECT turn_id,counts,partial FROM token_turns WHERE thread_id=?')
          .all(id)
          .map((row) => [
            String(row.turn_id),
            {
              tokenUsage: JSON.parse(String(row.counts)) as TokenCounts,
              tokenUsagePartial: !!row.partial,
            },
          ]),
      ),
    };
  }
  recordUsageTurn(threadId: string, turn: Turn) {
    const messages = turn.items.filter((item) => item.type === 'userMessage');
    const prompt =
      messages
        .map((item) =>
          (item.content || [])
            .map((part) =>
              typeof part === 'string' ? part : part.type === 'text' ? part.text || '' : '',
            )
            .join(''),
        )
        .join('\n')
        .slice(0, 4000) || (messages.length ? '附件消息' : '');
    this.db
      .prepare(
        `INSERT INTO usage_turns VALUES(?,?,?,?,?,?) ON CONFLICT(thread_id,turn_id) DO UPDATE SET
      prompt=CASE WHEN excluded.prompt<>'' THEN excluded.prompt ELSE usage_turns.prompt END,
      started_at=COALESCE(excluded.started_at,usage_turns.started_at),
      completed_at=COALESCE(excluded.completed_at,usage_turns.completed_at),
      status=CASE WHEN excluded.status='inProgress' AND usage_turns.completed_at IS NOT NULL THEN usage_turns.status WHEN excluded.status<>'' THEN excluded.status ELSE usage_turns.status END`,
      )
      .run(
        threadId,
        turn.id,
        prompt,
        turn.startedAt ?? null,
        turn.completedAt ?? null,
        turn.status,
      );
  }
  saveTurnModel(threadId: string, turnId: string, model: string) {
    this.db
      .prepare(
        'INSERT INTO turn_models VALUES(?,?,?) ON CONFLICT(thread_id,turn_id) DO UPDATE SET model=excluded.model',
      )
      .run(threadId, turnId, model);
  }
  threadModels(threadId: string): Map<string, string> {
    return new Map(
      this.db
        .prepare('SELECT turn_id,model FROM turn_models WHERE thread_id=?')
        .all(threadId)
        .map((row) => [String(row.turn_id), String(row.model)]),
    );
  }
  usageStats(
    since = 0,
    filters: { project?: string; thread?: string; page?: number } = {},
  ): UsageStats {
    return usageStats(this, since, filters);
  }
  queueRows() {
    return this.db
      .prepare('SELECT * FROM message_queue ORDER BY created_at,rowid')
      .all()
      .map((r) => ({
        id: String(r.id),
        threadId: String(r.thread_id),
        cwd: String(r.cwd),
        input: JSON.parse(String(r.input)),
        options: JSON.parse(String(r.options)),
        preview: String(r.preview),
        textIndex: r.text_index == null ? undefined : Number(r.text_index),
        state: r.state as 'queued' | 'sending' | 'paused',
        createdAt: Number(r.created_at),
        error: r.error ? String(r.error) : undefined,
      }));
  }
  publicQueue() {
    return this.db
      .prepare(
        'SELECT id,thread_id AS threadId,preview,state,created_at AS createdAt,error FROM message_queue ORDER BY created_at,rowid',
      )
      .all() as import('../shared/types.js').QueuedMessage[];
  }
  enqueue(
    threadId: string,
    cwd: string,
    input: Json[],
    options: Json,
    preview: string,
    textIndex?: number,
  ) {
    const id = randomUUID();
    this.db
      .prepare(
        'INSERT INTO message_queue(id,thread_id,cwd,input,options,preview,created_at,text_index) VALUES(?,?,?,?,?,?,?,?)',
      )
      .run(
        id,
        threadId,
        cwd,
        JSON.stringify(input),
        JSON.stringify(options),
        preview.slice(0, 300),
        Date.now(),
        textIndex ?? null,
      );
    return id;
  }
  pauseQueue(threadId?: string, error = '队列已暂停') {
    this.db
      .prepare(
        `UPDATE message_queue SET state='paused',error=?${threadId ? ' WHERE thread_id=?' : ''}`,
      )
      .run(...(threadId ? [error, threadId] : [error]));
  }
  cursor() {
    return Number(
      (
        this.db.prepare("SELECT seq FROM sqlite_sequence WHERE name='events'").get() as
          { seq: number } | undefined
      )?.seq || 0,
    );
  }
  replay(after: number, limit = 2000): WorkEvent[] {
    const events: WorkEvent[] = [];
    let bytes = 0;
    for (const r of this.db
      .prepare('SELECT * FROM events WHERE seq>? ORDER BY seq LIMIT ?')
      .iterate(after, limit)) {
      bytes += Buffer.byteLength(String(r.params));
      if (bytes > 4 * 1024 * 1024) break;
      events.push({
        seq: Number(r.seq),
        method: String(r.method),
        params: JSON.parse(String(r.params)),
        at: Number(r.at),
      });
    }
    return events;
  }
  private measureEvents() {
    const row = this.db
      .prepare(
        'SELECT COUNT(*) AS n,COALESCE(SUM(length(CAST(params AS BLOB))),0) AS bytes FROM events',
      )
      .get()!;
    this.eventRows = Number(row.n);
    this.eventBytes = Number(row.bytes);
  }
  private trimEvents() {
    if (this.eventBytes <= this.eventBudget && this.eventRows <= 100000) return;
    this.db
      .prepare(
        `DELETE FROM events WHERE seq IN (
      SELECT seq FROM (SELECT seq, SUM(length(CAST(params AS BLOB))) OVER (ORDER BY seq DESC) AS bytes,
      ROW_NUMBER() OVER (ORDER BY seq DESC) AS n FROM events) WHERE bytes>? OR n>80000
    )`,
      )
      .run(Math.floor(this.eventBudget * 0.8));
    this.measureEvents();
  }
  prune(days: number) {
    this.db.prepare('DELETE FROM events WHERE at<?').run(Date.now() - days * 86400000);
    this.db.exec('DELETE FROM events WHERE seq < (SELECT COALESCE(MAX(seq),0)-100000 FROM events)');
    this.db.prepare('DELETE FROM sessions WHERE expires_at<?').run(Date.now());
    this.measureEvents();
  }
  close() {
    this.db.close();
  }
  deletion(id: string) {
    return this.db.prepare('SELECT native_deleted FROM thread_deletions WHERE thread_id=?').get(id);
  }
  clearCache() {
    const events = Number(this.db.prepare('SELECT COUNT(*) AS count FROM events').get()!.count);
    this.db.exec('DELETE FROM events');
    this.db.prepare('DELETE FROM sessions WHERE expires_at<?').run(Date.now());
    this.db.exec('VACUUM; PRAGMA wal_checkpoint(TRUNCATE)');
    this.measureEvents();
    return { events };
  }
  deleteThreadData(id: string) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const table of [
        'attachments',
        'message_queue',
        'runs',
        'thread_execution',
        'token_turns',
        'turn_balances',
        'turn_models',
        'usage_turns',
        'token_state',
        'memory_uses',
      ])
        this.db.prepare(`DELETE FROM ${table} WHERE thread_id=?`).run(id);
      this.db.prepare('DELETE FROM thread_meta WHERE id=?').run(id);
      this.db
        .prepare(
          'DELETE FROM events WHERE EXISTS(SELECT 1 FROM json_tree(events.params) WHERE atom=?)',
        )
        .run(id);
      this.db.prepare('DELETE FROM thread_deletions WHERE thread_id=?').run(id);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    this.measureEvents();
  }
}
