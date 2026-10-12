import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { completeConversation, renderConversation } from '../server/conversation-export.js';
import { Store } from '../server/store.js';
import { Workbench } from '../server/workbench.js';
import { MockCodex } from './mock-codex.js';
import { Auth } from '../server/auth.js';
import { buildApp } from '../server/app.js';
import { config } from '../server/config.js';
import type { Thread, Turn } from '../shared/types.js';

const turn = (id: string): Turn => ({
  id,
  status: 'completed',
  items: [
    { id: id + '-user', type: 'userMessage', content: [{ type: 'text', text: `问题-${id}` }] },
    { id: id + '-agent', type: 'agentMessage', text: `答复-${id}` },
  ],
});
const thread = (turns: Turn[]): Thread => ({
  id: 'export-thread',
  name: '导出样例',
  preview: '',
  cwd: '/example/project',
  createdAt: 1,
  updatedAt: 2,
  status: { type: 'idle' },
  turns,
});

test('exports retain messages, tool results, diffs and safe offline HTML without loading attachment URLs', () => {
  const value = thread([turn('one')]);
  value.name = '<img src=x onerror=alert(1)>';
  value.turns[0].items.push(
    {
      id: 'reply',
      type: 'agentMessage',
      text: '**加粗**\n\n<script>alert(1)</script>\n\n![photo](https://example.test/private.png)\n\n[link](javascript:alert(1))',
    },
    {
      id: 'cmd',
      type: 'commandExecution',
      command: 'echo result',
      exitCode: 0,
      aggregatedOutput: '输出未截断\n```\n<script>tool</script>',
    },
    { id: 'diff', type: 'fileChange', changes: [{ path: 'sample.ts', diff: '-old\n+new' }] },
    { id: 'reason', type: 'reasoning', summary: ['摘要'], content: ['公开的思考内容'] },
    {
      id: 'file',
      type: 'userMessage',
      content: [
        { type: 'localImage', path: '/example/photo.png' },
        { type: 'image', url: 'data:image/png;base64,synthetic' },
      ],
    },
    { id: 'unknown', type: 'futureTool', result: { message: '未知工具结果保留' } },
  );
  for (const format of ['txt', 'markdown', 'html'] as const) {
    const result = renderConversation(value, format);
    for (const text of [
      '问题-one',
      '答复-one',
      '输出未截断',
      '-old',
      '+new',
      '公开的思考内容',
      '/example/photo.png',
      '未知工具结果保留',
    ])
      assert.ok(result.content.includes(text), `${format}: ${text}`);
    assert.ok(!result.content.includes('base64,synthetic'));
    assert.match(result.filename, /^conversation-[\w-]+\.(txt|md|html)$/);
    if (format === 'html') {
      assert.ok(result.content.includes('<strong>加粗</strong>'));
      assert.ok(result.content.includes('&lt;script&gt;'));
      assert.ok(!/<script|<img|href="javascript:/i.test(result.content));
      assert.ok(result.content.includes('Content-Security-Policy'));
    }
    if (format === 'markdown') assert.ok(result.content.includes('````\necho result'));
  }
  assert.ok(renderConversation(thread([]), 'txt').content.includes('轮次：0'));
});

test('full-history collection handles overlaps, pagination failures and cancellation without partial success', async () => {
  const newest = turn('two');
  newest.items[1].text = 'newest copy';
  const result = await completeConversation(async (cursor) => ({
    thread: thread(cursor ? [turn('one'), turn('two')] : [newest, turn('three')]),
    nextCursor: cursor ? null : 'older',
    cursor: 0,
  }));
  assert.deepEqual(
    result.turns.map((t) => t.id),
    ['one', 'two', 'three'],
  );
  assert.equal(result.turns[1].items[1].text, 'newest copy');
  await assert.rejects(
    completeConversation(async () => ({ thread: thread([]), nextCursor: 'loop', cursor: 0 })),
    /分页异常/,
  );
  await assert.rejects(
    completeConversation(async (cursor) => {
      if (cursor) throw new Error('history unavailable');
      return { thread: thread([turn('latest')]), nextCursor: 'older', cursor: 0 };
    }),
    /history unavailable/,
  );
  await assert.rejects(
    completeConversation(async () => {
      throw new Error('must not read');
    }, AbortSignal.abort()),
    /abort/i,
  );
});

test('authenticated export API reads all 65 turns, preserves order and does not query balances or start a turn', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-cloud-export-'));
  const store = new Store(path.join(root, 'data'));
  const bridge = new MockCodex(root);
  let balanceCalls = 0;
  const wb = new Workbench(bridge, store, 3, async () => {
    balanceCalls++;
    return { status: 'unavailable', checkedAt: 0 };
  });
  const app = await buildApp(store, wb, { logger: false });
  try {
    const native = bridge.makeThread();
    native.historyMode = 'paginated';
    native.turns = Array.from({ length: 65 }, (_, i) => turn(String(i).padStart(2, '0')));
    const calls: string[] = [];
    const original = bridge.call.bind(bridge);
    bridge.call = async (method, params = {}) => {
      calls.push(method);
      if (method === 'thread/turns/list') {
        const offset = Number(params.cursor || 0);
        const data = [...native.turns].reverse().slice(offset, offset + 30);
        return {
          data: structuredClone(data),
          nextCursor: offset + 30 < 65 ? String(offset + 30) : null,
        };
      }
      return original(method, params);
    };
    const url = `/api/threads/${native.id}/export`;
    assert.equal((await app.inject({ url: url + '?format=txt' })).statusCode, 401);
    await new Auth(store).change('export-test-password');
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: config.origin },
      payload: { password: 'export-test-password' },
    });
    const headers = { cookie: `${login.cookies[0].name}=${login.cookies[0].value}` };
    assert.equal((await app.inject({ url: url + '?format=pdf', headers })).statusCode, 400);
    for (const format of ['txt', 'markdown', 'html']) {
      const response = await app.inject({ url: url + `?format=${format}`, headers });
      assert.equal(response.statusCode, 200, response.body);
      assert.match(String(response.headers['content-disposition']), /^attachment;/);
      assert.equal(response.headers['cache-control'], 'no-store');
      let previous = -1;
      for (let i = 0; i < 65; i++) {
        const position = response.body.indexOf(`问题-${String(i).padStart(2, '0')}`);
        assert.ok(position > previous, `missing/out-of-order turn ${i}`);
        previous = position;
      }
    }
    assert.equal(calls.filter((method) => method === 'thread/turns/list').length, 9);
    assert.equal(balanceCalls, 0);
    assert.ok(!calls.includes('turn/start'));
    assert.equal(
      (await app.inject({ url: '/api/threads/missing/export?format=txt', headers })).statusCode,
      404,
    );
  } finally {
    wb.dispose();
    await app.close();
    bridge.stop();
    store.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
