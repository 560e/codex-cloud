import { z } from 'zod';
import {
  DEFAULT_AUTO_COMPACT_PERCENT,
  PROJECT_CONTEXT_WINDOW,
  type ProjectContextSettings,
} from '../shared/project-context.js';

export const projectContextSchema = z.object({
  contextWindow1M: z.boolean().default(false),
  autoCompactPercent: z
    .number()
    .int()
    .min(50)
    .max(90)
    .multipleOf(10)
    .default(DEFAULT_AUTO_COMPACT_PERCENT),
});

export function nativeProjectContext(settings?: ProjectContextSettings) {
  if (!settings) return undefined;
  return {
    model_post_turn_compact_threshold_percent: settings.autoCompactPercent,
    ...(settings.contextWindow1M
      ? {
          model_context_window: PROJECT_CONTEXT_WINDOW,
          model_auto_compact_token_limit:
            (PROJECT_CONTEXT_WINDOW * settings.autoCompactPercent) / 100,
        }
      : {}),
  };
}
