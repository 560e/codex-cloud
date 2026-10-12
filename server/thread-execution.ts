import { z } from 'zod';
import type { Json } from '../shared/types.js';
import fs from 'node:fs/promises';
import { createInterface } from 'node:readline';

export const threadExecutionSchema = z.object({
  approvalPolicy: z.enum(['on-request', 'untrusted', 'never']).optional(),
  sandbox: z.enum(['read-only', 'workspace-write', 'danger-full-access']).optional(),
});
export type ThreadExecution = z.output<typeof threadExecutionSchema>;

// Prefer the effective native policy, which can be tightened by managed config.
export function threadExecution(result: Json, fallback: Json = {}): ThreadExecution {
  const native = result.sandbox;
  const nativeType = native && typeof native === 'object' && 'type' in native ? native.type : null;
  const sandbox =
    nativeType === 'readOnly'
      ? 'read-only'
      : nativeType === 'workspaceWrite'
        ? 'workspace-write'
        : nativeType === 'dangerFullAccess'
          ? 'danger-full-access'
          : fallback.sandbox;
  return threadExecutionSchema.parse({
    approvalPolicy: result.approvalPolicy ?? fallback.approvalPolicy,
    sandbox,
  });
}

// This client has only ever allowed execution settings at thread creation.
// Its old resume implementation omitted them, allowing CLI defaults to replace
// the choice. Recover the initial choice for this client's legacy threads only.
export async function legacyThreadExecution(
  file: string,
  id: string,
): Promise<ThreadExecution | null> {
  const handle = await fs.open(file, 'r').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!handle) return null;
  const stream = handle.createReadStream({ encoding: 'utf8', autoClose: false });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  stream.on('error', (error) => lines.emit('error', error));
  let owned = false;
  let bytes = 0;
  try {
    for await (const line of lines) {
      bytes += Buffer.byteLength(line);
      if (bytes > 8 * 1024 * 1024) return null;
      let record;
      try {
        record = JSON.parse(line) as { type?: string; payload?: Json };
      } catch {
        return null;
      }
      if (!record || typeof record !== 'object') return null;
      const payload = record.payload;
      if (!payload) continue;
      if (record.type === 'session_meta') {
        if (payload.id !== id || payload.originator !== 'codex_private_workbench') return null;
        owned = true;
      }
      if (record.type === 'turn_context') {
        if (!owned) return null;
        const policy = payload.sandbox_policy;
        if (!policy || typeof policy !== 'object' || !('type' in policy)) return null;
        const execution = threadExecutionSchema.safeParse({
          approvalPolicy: payload.approval_policy,
          sandbox: policy.type,
        });
        return execution.success && execution.data.sandbox ? execution.data : null;
      }
    }
    return null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  } finally {
    lines.close();
    stream.destroy();
    await handle.close();
  }
}
