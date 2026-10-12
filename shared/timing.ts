import type { Turn } from './types.js';

// Native timestamps are seconds; durationMs includes model/tool/approval wait time.
export function turnElapsed(turn: Turn, now = Date.now()): number | null {
  if (turn.status !== 'inProgress' && typeof turn.durationMs === 'number')
    return Math.max(0, turn.durationMs);
  if (typeof turn.startedAt !== 'number') return null;
  const end =
    typeof turn.completedAt === 'number'
      ? turn.completedAt * 1000
      : turn.status === 'inProgress'
        ? now
        : null;
  return end === null ? null : Math.max(0, end - turn.startedAt * 1000);
}
export function formatElapsed(ms: number): string {
  if (ms < 1000) return `${(ms / 1000).toFixed(1)} 秒`;
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  return `${minutes >= 60 ? `${Math.floor(minutes / 60)} 小时 ` : ''}${minutes ? `${minutes % 60} 分 ` : ''}${seconds % 60} 秒`;
}
