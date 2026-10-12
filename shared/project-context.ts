export const PROJECT_CONTEXT_WINDOW = 1_000_000;
export const AUTO_COMPACT_PERCENTAGES = [50, 60, 70, 80, 90] as const;
export const DEFAULT_AUTO_COMPACT_PERCENT = 90;

export type ProjectContextSettings = {
  contextWindow1M: boolean;
  autoCompactPercent: number;
};
