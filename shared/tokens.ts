import type { TokenCounts, TokenUsage } from './types.js';

export const tokenFields = [
  'totalTokens',
  'inputTokens',
  'cachedInputTokens',
  'outputTokens',
  'reasoningOutputTokens',
] as const;

export function formatTokens(value?: number): string {
  if (value === undefined || !Number.isFinite(value)) return '—';
  if (value < 10_000) return value.toLocaleString('en-US', { maximumFractionDigits: 0 });
  const units = ['K', 'M', 'B'] as const;
  let index = value >= 1_000_000_000 ? 2 : value >= 1_000_000 ? 1 : 0;
  let rounded = Number((value / 1000 ** (index + 1)).toFixed(2));
  if (rounded >= 1000 && index < units.length - 1) {
    index++;
    rounded = Number((value / 1000 ** (index + 1)).toFixed(2));
  }
  return `${rounded}${units[index]}`;
}

export function tokenTotal(counts: TokenCounts): number | undefined {
  return (
    counts.totalTokens ??
    (counts.inputTokens !== undefined && counts.outputTokens !== undefined
      ? counts.inputTokens + counts.outputTokens
      : undefined)
  );
}

export function cacheHitRate(counts: TokenCounts): number | undefined {
  const { inputTokens, cachedInputTokens } = counts;
  if (
    inputTokens === undefined ||
    cachedInputTokens === undefined ||
    !Number.isFinite(inputTokens) ||
    !Number.isFinite(cachedInputTokens) ||
    inputTokens <= 0 ||
    cachedInputTokens < 0 ||
    cachedInputTokens > inputTokens
  )
    return undefined;
  return (cachedInputTokens / inputTokens) * 100;
}

export function accumulateTokens(
  current: TokenUsage,
  previous?: TokenUsage,
  recorded: TokenCounts = {},
): { counts: TokenCounts; partial: boolean } {
  const counts = { ...recorded };
  let partial = false;
  // A cache counter introduced halfway through a turn cannot describe its full input.
  if (
    (recorded.inputTokens ?? 0) > 0 &&
    recorded.cachedInputTokens === undefined &&
    (current.total?.cachedInputTokens !== undefined ||
      current.last?.cachedInputTokens !== undefined)
  )
    partial = true;
  if (
    recorded.cachedInputTokens !== undefined &&
    current.total?.cachedInputTokens === undefined &&
    current.last?.cachedInputTokens === undefined
  )
    partial = true;
  for (const field of tokenFields) {
    const total = current.total?.[field];
    const before = previous?.total?.[field];
    const last = current.last?.[field];
    if (total !== undefined && before !== undefined && total >= before) {
      counts[field] = (counts[field] ?? 0) + total - before;
    } else if (last !== undefined) {
      // With no cumulative baseline, only the reported last request is attributable.
      // Repeated snapshots without totals replace rather than double-count that request.
      counts[field] = total === undefined ? last : (counts[field] ?? 0) + last;
      if (total === undefined || total !== last || before !== undefined) partial = true;
    } else if (total !== undefined) partial = true;
  }
  if (current.total?.totalTokens === undefined && current.last?.totalTokens === undefined) {
    delete counts.totalTokens;
    const total = tokenTotal(counts);
    if (total !== undefined) counts.totalTokens = total;
  }
  return { counts, partial };
}
