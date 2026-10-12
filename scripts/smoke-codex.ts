import fs from 'node:fs/promises';
import path from 'node:path';
import { CodexBridge } from '../server/codex.js';
import { config } from '../server/config.js';
const bridge = new CodexBridge(config.codexBin);
const cwd = path.resolve('.test-data', `codex-smoke-${Date.now()}`);
await fs.mkdir(cwd, { recursive: true });
let threadId = '';
let finish!: () => void;
let reject!: (e: Error) => void;
const done = new Promise<void>((resolve, fail) => {
  finish = resolve;
  reject = fail;
});
// Attach immediately so failures cannot become unhandled rejections.
void done.catch(() => {});
bridge.on('request', (message) => {
  if (message.method.endsWith('requestApproval'))
    bridge.respond(message.id, { decision: 'decline' });
  else bridge.rejectRequest(message.id, 'Smoke test does not support tools');
});
bridge.on('notification', (message) => {
  if (message.params?.threadId !== threadId) return;
  if (message.method === 'item/completed' && message.params.item.type === 'agentMessage')
    console.log(`Model reply: ${message.params.item.text}`);
  if (message.method === 'turn/completed') {
    if (message.params.turn.status === 'failed')
      reject(new Error(message.params.turn.error?.message || 'Turn failed'));
    else finish();
  }
});
let timer: NodeJS.Timeout | undefined;
try {
  await bridge.start();
  const result = await bridge.call('thread/start', {
    cwd,
    sandbox: 'read-only',
    approvalPolicy: 'never',
    ephemeral: true,
  });
  threadId = result.thread.id;
  const read = await bridge.call('thread/read', { threadId, includeTurns: false });
  console.log(`Thread start/read: OK (${read.thread.historyMode})`);
  const turn = await bridge.call('turn/start', {
    threadId,
    input: [
      {
        type: 'text',
        text: 'Reply with exactly CODEX_WORKBENCH_OK. Do not call tools or read any files.',
        text_elements: [],
      },
    ],
  });
  console.log(`Turn started: ${turn.turn.id}`);
  timer = setTimeout(() => reject(new Error('Model test timeout')), 90000);
  await done;
  console.log('Real Codex protocol and model round-trip: PASS');
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
  bridge.stop();
}
