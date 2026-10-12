import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../server/store.js';
import { Workbench } from '../server/workbench.js';
import { MockCodex } from './mock-codex.js';
import { buildApp } from '../server/app.js';
import { Auth } from '../server/auth.js';
import { config } from '../server/config.js';
import type { Json } from '../shared/types.js';

test('queue edits preserve complete text, references, attachments, options and order; conflicts cannot overwrite newer content', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'queue-edit-'));
  const store = new Store(path.join(root, 'data'));
  const bridge = new MockCodex(root);
  const wb = new Workbench(bridge, store, 3);
  const app = await buildApp(store, wb, { logger: false });
  try {
    const native = bridge.makeThread();
    const original = '完整正文'.repeat(150);
    const reference = { type: 'text', text: '引用内容', text_elements: [] };
    const attachment = { type: 'localImage', path: '/synthetic/photo.png' };
    const id = store.enqueue(
      native.id,
      root,
      [reference, { type: 'text', text: original }, attachment],
      { model: 'test-model', effort: 'high' },
      original,
      1,
    );
    store.pauseQueue(native.id);
    const before = store.queueRows()[0];
    await new Auth(store).change('queue-edit-password');
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: config.origin },
      payload: { password: 'queue-edit-password' },
    });
    const headers = {
      origin: config.origin,
      cookie: `${login.cookies[0].name}=${login.cookies[0].value}`,
    };
    const url = `/api/queue/${id}`;
    assert.equal((await app.inject({ url })).statusCode, 401);
    const draft = (await app.inject({ url, headers })).json();
    assert.equal(draft.text, original);
    const save = (text: string, revision = draft.revision, origin = config.origin) =>
      app.inject({
        method: 'PATCH',
        url,
        headers: { ...headers, origin },
        payload: { text, revision },
      });
    assert.equal((await save('denied', draft.revision, 'https://evil.test')).statusCode, 403);
    assert.equal((await save('x'.repeat(100001))).statusCode, 400);
    assert.equal((await save('新的正文')).statusCode, 200);
    assert.equal((await save('旧页面覆盖')).statusCode, 409);
    const after = store.queueRows()[0];
    assert.deepEqual(after.input, [
      reference,
      { type: 'text', text: '新的正文', text_elements: [] },
      attachment,
    ]);
    assert.deepEqual(after.options, before.options);
    assert.equal(after.createdAt, before.createdAt);
    assert.equal(after.state, 'paused');
    assert.equal(after.id, id);
    store.close();
    store.reload();
    assert.equal(wb.queueMessage(id).text, '新的正文');
    const latest = wb.queueMessage(id);
    wb.editQueue(id, '', latest.revision);
    assert.deepEqual(store.queueRows()[0].input, [reference, attachment]);
    const empty = wb.queueMessage(id);
    assert.equal(empty.text, '');
    wb.editQueue(id, '重新补充正文', empty.revision);
    store.db.prepare("UPDATE message_queue SET state='sending' WHERE id=?").run(id);
    assert.equal((await save('已经提交')).statusCode, 409);
    store.db.prepare('DELETE FROM message_queue WHERE id=?').run(id);
    assert.equal((await app.inject({ url, headers })).statusCode, 409);
    const legacy = store.enqueue(native.id, root, [{ type: 'text', text: original }], {}, original);
    assert.equal(wb.queueMessage(legacy).text, original);
  } finally {
    wb.dispose();
    await app.close();
    bridge.stop();
    store.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('queue drain re-reads edited payload instead of submitting its stale iteration snapshot', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'queue-edit-drain-'));
  const store = new Store(root);
  const bridge = new MockCodex(root);
  const wb = new Workbench(bridge, store, 3);
  try {
    const native = bridge.makeThread();
    const id = store.enqueue(native.id, root, [{ type: 'text', text: 'before' }], {}, 'before', 0);
    store.pauseQueue(native.id);
    const stale = store.queueRows();
    wb.editQueue(id, 'after', wb.queueMessage(id).revision);
    await wb.connect();
    const read = store.queueRows.bind(store);
    store.queueRows = () => {
      store.queueRows = read;
      return stale;
    };
    const call = bridge.call.bind(bridge);
    let sent: Json | undefined;
    bridge.call = async (method, params = {}) => {
      if (method === 'turn/start') sent = structuredClone(params);
      return call(method, params);
    };
    wb.queueAction(id, 'resume');
    const deadline = Date.now() + 3000;
    while (!sent && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(sent?.input, [{ type: 'text', text: 'after', text_elements: [] }]);
  } finally {
    wb.dispose();
    bridge.stop();
    store.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
