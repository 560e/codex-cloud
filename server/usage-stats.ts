import type { Store } from './store.js';
import type { UsageStats, UsageRecord, TokenCounts } from '../shared/types.js';
import { tokenFields } from '../shared/tokens.js';
import { balanceDifference } from '../shared/money.js';
import path from 'node:path';

export function usageStats(
  store: Store,
  since: number,
  filters: { project?: string; thread?: string; page?: number },
): UsageStats {
  const db = store.db;
  const cte = `WITH ids AS (SELECT thread_id,turn_id FROM token_turns UNION SELECT thread_id,turn_id FROM usage_turns UNION SELECT thread_id,turn_id FROM turn_balances),
    base AS (SELECT i.thread_id,i.turn_id,s.name,s.cwd,p.id AS project_id,p.name AS project_name,t.counts,t.partial,
      u.prompt,u.started_at,u.completed_at,u.status,b.balance,
      COALESCE(u.started_at*1000,t.updated_at,json_extract(b.balance,'$.checkedAt'),0) AS at,
      COALESCE(t.updated_at,u.completed_at*1000,u.started_at*1000,json_extract(b.balance,'$.checkedAt'),0) AS updated_at
      FROM ids i LEFT JOIN token_turns t ON t.thread_id=i.thread_id AND t.turn_id=i.turn_id
      LEFT JOIN token_state s ON s.thread_id=i.thread_id
      LEFT JOIN usage_turns u ON u.thread_id=i.thread_id AND u.turn_id=i.turn_id
      LEFT JOIN turn_balances b ON b.thread_id=i.thread_id AND b.turn_id=i.turn_id
      LEFT JOIN projects p ON p.path=s.cwd ${process.platform === 'win32' ? 'COLLATE NOCASE' : ''}),
    ranked AS (SELECT *,ROW_NUMBER() OVER (PARTITION BY thread_id ORDER BY at,turn_id) AS turn_number FROM base),
    filtered AS (SELECT * FROM ranked WHERE updated_at>=? AND (?='' OR project_id=?) AND (?='' OR thread_id=?))`;
  const args = [
    since,
    filters.project || '',
    filters.project || '',
    filters.thread || '',
    filters.thread || '',
  ];
  const sums = tokenFields
    .map((field) => `SUM(json_extract(counts,'$.${field}')) AS ${field}`)
    .join(',');
  const total = db.prepare(`${cte} SELECT ${sums},COUNT(*) AS turns FROM filtered`).get(...args)!;
  const cache = db
    .prepare(
      `${cte} SELECT
    SUM(json_extract(counts,'$.inputTokens')) AS inputTokens,
    SUM(json_extract(counts,'$.cachedInputTokens')) AS cachedInputTokens,
    COUNT(*) AS turns FROM filtered WHERE partial=0
    AND json_extract(counts,'$.inputTokens')>0
    AND json_extract(counts,'$.cachedInputTokens') BETWEEN 0 AND json_extract(counts,'$.inputTokens')`,
    )
    .get(...args)!;
  const counts = (row: Record<string, unknown>): TokenCounts =>
    Object.fromEntries(
      tokenFields.filter((field) => row[field] != null).map((field) => [field, Number(row[field])]),
    );
  const pages = Math.max(1, Math.ceil(Number(total.turns) / 50));
  const page = Math.min(filters.page || 1, pages);
  const records = db
    .prepare(
      `${cte} SELECT * FROM filtered ORDER BY updated_at DESC,thread_id,turn_id LIMIT 50 OFFSET ?`,
    )
    .all(...args, (page - 1) * 50)
    .map((row): UsageRecord => ({
      threadId: String(row.thread_id),
      turnId: String(row.turn_id),
      turnNumber: Number(row.turn_number),
      name: String(row.name || '未命名会话'),
      cwd: String(row.cwd || ''),
      projectId: row.project_id ? String(row.project_id) : undefined,
      projectName: String(
        row.project_name || (row.cwd ? path.basename(String(row.cwd)) : '未关联项目'),
      ),
      prompt: String(row.prompt || '未记录本轮问题'),
      status: String(row.status || 'unknown'),
      startedAt: row.started_at == null ? undefined : Number(row.started_at) * 1000,
      completedAt: row.completed_at == null ? undefined : Number(row.completed_at) * 1000,
      updatedAt: Number(row.updated_at),
      counts: row.counts ? JSON.parse(String(row.counts)) : {},
      partial: !!row.partial,
      balance: row.balance ? JSON.parse(String(row.balance)) : undefined,
    }));
  const expenses = db
    .prepare(
      `${cte} SELECT UPPER(TRIM(json_extract(balance,'$.unit'))) AS unit,SUM(json_extract(balance,'$.spent')) AS spent,COUNT(*) AS turns FROM filtered WHERE json_extract(balance,'$.spent') IS NOT NULL GROUP BY unit`,
    )
    .all(...args)
    .map((row) => ({
      unit: String(row.unit || ''),
      spent: Number(row.spent),
      turns: Number(row.turns),
    }));
  // Normalize decimal totals after SQLite's floating-point summation.
  for (const expense of expenses) {
    const amounts = db
      .prepare(
        `${cte} SELECT json_extract(balance,'$.spent') AS spent FROM filtered WHERE UPPER(TRIM(json_extract(balance,'$.unit')))=? AND json_extract(balance,'$.spent') IS NOT NULL`,
      )
      .all(...args, expense.unit);
    expense.spent = amounts.reduce(
      (sum, row) => balanceDifference(sum, -Number(row.spent)) ?? sum,
      0,
    );
  }
  return {
    totals: counts(total),
    cache: { ...counts(cache), turns: Number(cache.turns) },
    turns: Number(total.turns),
    page,
    pages,
    pageSize: 50,
    records,
    expenses,
    filters: {
      projects: store.projects().map(({ id, name }) => ({ id, name })),
      threads: db
        .prepare(
          `SELECT s.thread_id,s.name,p.id AS project_id FROM token_state s LEFT JOIN projects p ON p.path=s.cwd ${process.platform === 'win32' ? 'COLLATE NOCASE' : ''} WHERE (?='' OR p.id=?) AND s.thread_id IN (SELECT thread_id FROM token_turns UNION SELECT thread_id FROM usage_turns UNION SELECT thread_id FROM turn_balances) ORDER BY s.name,s.thread_id`,
        )
        .all(filters.project || '', filters.project || '')
        .map((row) => ({
          id: String(row.thread_id),
          name: String(row.name || '未命名会话'),
          projectId: row.project_id ? String(row.project_id) : undefined,
        })),
    },
    threads: db
      .prepare(
        `${cte} SELECT thread_id,name,cwd,${sums},COUNT(*) AS turns,MAX(updated_at) AS updatedAt,MAX(partial) AS partial FROM filtered GROUP BY thread_id ORDER BY updatedAt DESC LIMIT 200`,
      )
      .all(...args)
      .map((row) => ({
        threadId: String(row.thread_id),
        name: String(row.name || '未命名会话'),
        cwd: String(row.cwd || ''),
        counts: counts(row),
        turns: Number(row.turns),
        updatedAt: Number(row.updatedAt),
        partial: !!row.partial,
      })),
  };
}
