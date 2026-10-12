import type { DatabaseSync } from 'node:sqlite';
import type { EventParams, TokenCounts, TokenUsage } from '../shared/types.js';
import { accumulateTokens, cacheHitRate } from '../shared/tokens.js';

// Earlier versions retained upstream cache counters in events but omitted them
// from per-turn counts. Recover only turns whose full input window can be replayed.
export function backfillCachedTokens(db: DatabaseSync) {
  if (db.prepare('SELECT 1 FROM migrations WHERE version=9').get()) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    const previous = new Map<string, TokenUsage>();
    const turns = new Map<
      string,
      { thread: string; turn: string; counts: TokenCounts; partial: boolean }
    >();
    for (const row of db
      .prepare(
        "SELECT method,params FROM events WHERE method IN ('thread/started','thread/tokenUsage/updated') ORDER BY seq",
      )
      .iterate()) {
      const params = JSON.parse(String(row.params)) as EventParams;
      const id = params.threadId || params.thread?.id;
      if (!id) continue;
      if (row.method === 'thread/started') {
        if (
          !previous.has(id) &&
          params.thread &&
          !params.thread.preview &&
          !params.thread.turns.length
        )
          previous.set(id, {
            total: {
              inputTokens: 0,
              cachedInputTokens: 0,
              outputTokens: 0,
              totalTokens: 0,
              reasoningOutputTokens: 0,
            },
          });
        continue;
      }
      const usage = params.tokenUsage;
      if (!usage) continue;
      if (params.turnId) {
        const key = JSON.stringify([id, params.turnId]);
        const saved = turns.get(key);
        const result = accumulateTokens(usage, previous.get(id), saved?.counts);
        turns.set(key, {
          thread: id,
          turn: params.turnId,
          counts: result.counts,
          partial: result.partial || !!saved?.partial,
        });
      }
      previous.set(id, usage);
    }
    const update =
      db.prepare(`UPDATE token_turns SET counts=json_set(counts,'$.cachedInputTokens',?)
      WHERE thread_id=? AND turn_id=? AND json_extract(counts,'$.cachedInputTokens') IS NULL
      AND json_extract(counts,'$.inputTokens')=?`);
    for (const turn of turns.values()) {
      if (!turn.partial && cacheHitRate(turn.counts) !== undefined)
        update.run(
          turn.counts.cachedInputTokens!,
          turn.thread,
          turn.turn,
          turn.counts.inputTokens!,
        );
    }
    db.exec('INSERT INTO migrations VALUES(9, unixepoch()); COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
