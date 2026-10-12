import fs from 'node:fs/promises';
import path from 'node:path';
import { once } from 'node:events';
import { Store } from '../server/store.js';
import { CodexBridge } from '../server/codex.js';
import { config } from '../server/config.js';
import { Workbench } from '../server/workbench.js';
const dir = path.resolve('.test-data', `real-workbench-${Date.now()}`);
await fs.mkdir(dir, { recursive: true });
const store = new Store(path.join(dir, 'data'));
const bridge = new CodexBridge(config.codexBin);
const workbench = new Workbench(bridge, store, 2);
let threadId = '';
try {
  const result = await workbench.create(dir, { sandbox: 'read-only', approvalPolicy: 'never' });
  threadId = result.thread.id;
  const initial = await workbench.read(threadId);
  console.log(`Initial full history: ${initial.thread.turns.length} turns`);
  const complete = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Turn timeout')), 90000);
    workbench.on('event', (event) => {
      if (event.method === 'turn/completed' && event.params.threadId === threadId) {
        clearTimeout(timer);
        event.params.turn.status === 'failed'
          ? reject(new Error(event.params.turn.error?.message))
          : resolve();
      }
    });
  });
  void complete.catch(() => {});
  await workbench.send(
    threadId,
    [
      {
        type: 'text',
        text: 'Reply exactly WORKBENCH_HISTORY_OK. Do not use tools or read files.',
        text_elements: [],
      },
    ],
    {},
    false,
  );
  await complete;
  const restored = await workbench.read(threadId);
  console.log(
    `History after turn: ${restored.thread.turns.length} turns, ${restored.thread.turns.flatMap((t) => t.items).length} items`,
  );
  if (
    !restored.thread.turns.some((t) =>
      t.items.some((i) => i.type === 'agentMessage' && i.text.includes('WORKBENCH_HISTORY_OK')),
    )
  )
    throw new Error('Assistant reply missing from history');
  console.log('Workbench create/read/send/live overlay/history: PASS');
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
} finally {
  if (threadId && bridge.ready) {
    try {
      await bridge.call('thread/archive', { threadId });
      console.log('Test thread archived');
    } catch {}
  }
  const exited = bridge.child ? once(bridge.child, 'exit') : Promise.resolve();
  bridge.stop();
  await exited;
  store.close();
}
