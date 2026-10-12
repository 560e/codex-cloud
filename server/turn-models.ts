import fs from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { BoundedCache } from './cache.js';

const cache = new BoundedCache<{ stamp: string; models: [string, string][] }>(100);
export function modelName(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() && value.length <= 200
    ? value.trim()
    : undefined;
}

// Read only per-turn native context. The thread's current model cannot identify
// the model used by older replies, and session defaults may have changed.
export async function nativeTurnModels(
  file: string,
  threadId: string,
): Promise<Map<string, string>> {
  const models = new Map<string, string>();
  const handle = await fs.open(file, 'r').catch(() => null);
  if (!handle) return models;
  let lines: ReturnType<typeof createInterface> | undefined;
  let stream: ReturnType<typeof handle.createReadStream> | undefined;
  try {
    const stat = await handle.stat();
    const stamp = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
    const key = `${threadId}:${file}`;
    const saved = cache.get(key);
    if (saved?.stamp === stamp) return new Map(saved.models);
    stream = handle.createReadStream({ encoding: 'utf8', autoClose: false });
    lines = createInterface({ input: stream, crlfDelay: Infinity });
    stream.on('error', (error) => lines?.emit('error', error));
    let owned = false;
    for await (const line of lines) {
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue; // A currently running rollout may end with a partial record.
      }
      if (record?.type === 'session_meta') {
        if (record.payload?.id !== threadId) return new Map();
        owned = true;
      }
      if (owned && record?.type === 'turn_context') {
        const id = record.payload?.turn_id;
        const model = modelName(record.payload?.model);
        if (typeof id === 'string' && id && model) models.set(id, model);
      }
    }
    cache.set(key, { stamp, models: [...models] });
  } catch {
    // Missing/unreadable history must not prevent the conversation from opening.
  } finally {
    lines?.close();
    stream?.destroy();
    await handle.close();
  }
  return models;
}
