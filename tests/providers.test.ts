import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { Store } from '../server/store.js';
import { Auth, hashPassword } from '../server/auth.js';
import { buildApp } from '../server/app.js';
import { config } from '../server/config.js';
import { Workbench } from '../server/workbench.js';
import { CodexBridge } from '../server/codex.js';
import { MockCodex } from './mock-codex.js';
import {
  Providers,
  providerInput,
  providerLaunch,
  managedProviderId,
  providerKeyFile,
  type RuntimeProvider,
} from '../server/providers.js';
import { backupWorkbench } from '../server/backup.js';
import { parseApiResult, parseRpcResult } from '../shared/protocol.js';
import { fetchProviderModels } from '../server/provider-models.js';

const first = {
  name: '欧洲线路',
  baseUrl: 'https://eu.example.test/v1',
  model: 'relay-model',
  apiKey: 'test-secret-europe-12345',
};
const second = {
  name: '亚洲线路',
  baseUrl: 'https://asia.example.test/v1',
  model: 'another-model',
  apiKey: 'test-secret-asia-12345',
};

test('model refresh is explicit, persists per provider, protects old data and updates clients without reconnecting', async () => {
  const f = await fixture();
  let calls = 0;
  let mode = 'normal';
  let release: (() => void) | undefined;
  let started: (() => void) | undefined;
  const upstream = createServer(async (req, res) => {
    calls++;
    assert.equal(req.url, '/v1/models');
    assert.equal(req.headers.authorization, `Bearer ${first.apiKey}`);
    if (mode === 'held') {
      started?.();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    }
    if (mode === 'http') res.writeHead(401);
    if (mode === 'redirect') res.writeHead(302, { Location: '/other' });
    res.end(
      mode === 'large'
        ? 'x'.repeat(1024 * 1024 + 1)
        : JSON.stringify(
            mode === 'invalid'
              ? { data: [{ id: 'invalid model' }] }
              : mode === 'shape'
                ? { error: first.apiKey }
                : mode === 'many'
                  ? { data: Array.from({ length: 101 }, (_, i) => ({ id: `m${i}` })) }
                  : mode === 'empty'
                    ? { data: [] }
                    : { data: [{ id: 'fast' }, { id: 'deep' }, { id: 'fast' }] },
          ),
    );
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
  const app = await buildApp(f.store, f.wb, { logger: false });
  try {
    const profile = f.wb.providers.save(
      providerInput.parse({ ...first, baseUrl, models: ['old'] }),
    );
    const other = f.wb.providers.save(providerInput.parse(second));
    f.wb.providers.activate(profile.id);
    await new Auth(f.store).change('model-test-password');
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: config.origin },
      payload: { password: 'model-test-password' },
    });
    const headers = {
      origin: config.origin,
      cookie: `${login.cookies[0].name}=${login.cookies[0].value}`,
    };
    const url = `/api/providers/${profile.id}/models/refresh`;
    assert.equal(
      (await app.inject({ method: 'POST', url, headers: { origin: config.origin } })).statusCode,
      401,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url,
          headers: { ...headers, origin: 'https://other.test' },
        })
      ).statusCode,
      403,
    );
    await app.inject({ url: '/api/providers', headers });
    f.bridge.start = async () => {
      throw new Error('Executor offline');
    };
    assert.equal((await app.inject({ url: '/api/models', headers })).statusCode, 200);
    assert.equal(calls, 0);
    const events: string[] = [];
    f.wb.on('event', (event) => events.push(event.method));
    const result = await app.inject({ method: 'POST', url, headers });
    assert.equal(result.statusCode, 200, result.body);
    const saved = result.json();
    assert.deepEqual(saved.models, ['fast', 'deep']);
    assert.ok(saved.modelsFetchedAt > 0);
    assert.ok(!result.body.includes(first.apiKey));
    assert.equal(
      (parseApiResult(url.slice(4), 'POST', saved) as typeof saved).modelsFetchedAt,
      saved.modelsFetchedAt,
    );
    assert.ok(events.includes('workbench/providerModelsUpdated'));
    const reopened = new Store(f.store.dir);
    assert.deepEqual(new Providers(reopened).list().find((p) => p.id === profile.id)?.models, [
      'fast',
      'deep',
    ]);
    reopened.close();
    assert.deepEqual(f.wb.providers.list().find((p) => p.id === other.id)?.models, []);
    for (let i = 0; i < 2; i++) {
      const models = await app.inject({ url: '/api/models', headers });
      assert.deepEqual(
        models.json().data.map((m: { model: string }) => m.model),
        [first.model, 'fast', 'deep'],
      );
    }
    assert.equal(calls, 1);
    for (mode of ['http', 'redirect', 'invalid', 'shape', 'large', 'many']) {
      const failed = await app.inject({ method: 'POST', url, headers });
      assert.equal(failed.statusCode, 502, mode);
      assert.ok(!failed.body.includes(first.apiKey));
      assert.deepEqual(
        f.wb.providers.list().find((p) => p.id === profile.id),
        saved,
      );
    }
    mode = 'held';
    const waiting = new Promise<void>((resolve) => {
      started = resolve;
    });
    const refreshing = f.wb.providers.refreshModels(profile.id);
    await waiting;
    await assert.rejects(f.wb.providers.refreshModels(profile.id), /正在获取/);
    f.wb.providers.save(
      providerInput.parse({ ...first, baseUrl, models: ['edited'] }),
      profile.id,
      true,
    );
    release!();
    await assert.rejects(refreshing, /配置已变化/);
    assert.deepEqual(f.wb.providers.list().find((p) => p.id === profile.id)?.models, ['edited']);
    mode = 'empty';
    const empty = await app.inject({ method: 'POST', url, headers });
    assert.equal(empty.statusCode, 200);
    assert.deepEqual(empty.json().models, []);
    mode = 'held';
    const timingOut = fetchProviderModels(f.wb.providers.runtime(profile.id)!, 50);
    await assert.rejects(timingOut, /超时/);
    release?.();
  } finally {
    release?.();
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    await app.close();
    await f.close();
  }
});
test('capabilities distinguish unsupported CLI, provider changes and malformed responses', async () => {
  const f = await fixture();
  try {
    const result = await f.wb.capabilities();
    assert.deepEqual(parseApiResult('/capabilities', 'GET', result), {
      available: true,
      capabilities: { namespaceTools: true, imageGeneration: false, webSearch: true },
    });
    assert.throws(() => parseRpcResult('modelProvider/capabilities/read', { webSearch: 'true' }));
    f.bridge.call = async () => {
      throw Object.assign(new Error('method not found'), { rpcCode: -32601 });
    };
    assert.deepEqual(await f.wb.capabilities(), {
      available: false,
      reason: '当前 CLI 不支持能力查询',
    });
    f.bridge.call = async () => {
      throw new Error('connection failed');
    };
    await assert.rejects(f.wb.capabilities(), /connection failed/);
    f.bridge.call = async () => {
      f.bridge.emit('disconnect', 'switched');
      return { namespaceTools: true, imageGeneration: true, webSearch: true };
    };
    await assert.rejects(f.wb.capabilities(), /供应商连接已变化/);
  } finally {
    await f.close();
  }
});
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-providers-'));
  const store = new Store(path.join(root, 'data'));
  const bridge = new MockCodex(root);
  const wb = new Workbench(bridge, store, 3);
  return {
    root,
    store,
    bridge,
    wb,
    async close() {
      wb.dispose();
      bridge.stop();
      store.close();
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

test('provider API requires login only, never returns keys and revokes access on logout', async () => {
  const f = await fixture();
  const app = await buildApp(f.store, f.wb, { logger: false });
  try {
    await new Auth(f.store).change('student-password');
    const login = async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { origin: config.origin },
        payload: { password: 'student-password' },
      });
      return {
        origin: config.origin,
        cookie: `${response.cookies[0].name}=${response.cookies[0].value}`,
      };
    };
    const admin = await login(),
      student = await login();
    assert.equal((await app.inject({ url: '/api/capabilities' })).statusCode, 401);
    const capabilities = await app.inject({ url: '/api/capabilities', headers: student });
    assert.equal(capabilities.statusCode, 200);
    assert.equal(capabilities.json().capabilities.webSearch, true);
    assert.equal((await app.inject({ url: '/api/providers' })).statusCode, 401);
    assert.equal((await app.inject({ url: '/api/providers', headers: student })).statusCode, 200);
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/providers',
          headers: { ...admin, origin: 'https://other.test' },
          payload: first,
        })
      ).statusCode,
      403,
    );
    const saved = await app.inject({
      method: 'POST',
      url: '/api/providers',
      headers: admin,
      payload: first,
    });
    assert.equal(saved.statusCode, 200, saved.body);
    const id = saved.json().id;
    assert.equal(saved.json().hasKey, true);
    assert.ok(!saved.body.includes(first.apiKey));
    assert.ok(
      !(await app.inject({ url: '/api/providers', headers: admin })).body.includes(first.apiKey),
    );
    const publicStatus = await app.inject({ url: '/api/providers/access', headers: student });
    assert.ok(!publicStatus.body.includes(first.baseUrl));
    assert.equal(publicStatus.json().unlocked, true);
    const edited = await app.inject({
      method: 'PUT',
      url: `/api/providers/${id}`,
      headers: student,
      payload: { name: '新名称', baseUrl: first.baseUrl, model: first.model },
    });
    assert.equal(edited.statusCode, 200);
    assert.equal(f.wb.providers.runtime(id)!.apiKey, first.apiKey);
    f.store.set('providerAdminHash', await hashPassword('changed-teacher-password'));
    assert.equal((await app.inject({ url: '/api/providers', headers: admin })).statusCode, 200);
    await app.inject({ method: 'POST', url: '/api/auth/logout', headers: admin });
    assert.equal((await app.inject({ url: '/api/providers', headers: admin })).statusCode, 401);
    assert.equal(
      (await app.inject({ url: '/api/auth/status', headers: student })).json().authenticated,
      true,
    );
  } finally {
    await app.close();
    await f.close();
  }
});

test('provider balances require login, query each saved provider and never expose keys', async () => {
  const f = await fixture();
  const app = await buildApp(f.store, f.wb, { logger: false });
  const requests: string[] = [];
  let upstreamError = false;
  const upstream = createServer((request, response) => {
    requests.push(request.url!);
    const european = request.url === '/eu/v1/usage';
    assert.equal(
      request.headers.authorization,
      `Bearer ${european ? first.apiKey : second.apiKey}`,
    );
    if (upstreamError) {
      response.writeHead(500);
      response.end(first.apiKey);
    } else response.end(JSON.stringify({ remaining: european ? 0 : 12.3456, unit: 'USD' }));
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
  try {
    const a = f.wb.providers.save(providerInput.parse({ ...first, baseUrl: baseUrl + '/eu' }));
    const b = f.wb.providers.save(providerInput.parse({ ...second, baseUrl: baseUrl + '/asia' }));
    f.store.set('activeProvider', a.id);
    const route = `/providers/${b.id}/balance`;
    assert.equal((await app.inject({ url: '/api' + route })).statusCode, 401);
    assert.equal(requests.length, 0);
    await new Auth(f.store).change('balance-test-password');
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: config.origin },
      payload: { password: 'balance-test-password' },
    });
    const headers = { cookie: `${login.cookies[0].name}=${login.cookies[0].value}` };
    for (const [profile, remaining] of [
      [a, 0],
      [b, 12.3456],
    ] as const) {
      const url = `/providers/${profile.id}/balance`;
      const result = await app.inject({ url: '/api' + url, headers });
      assert.equal(result.statusCode, 200);
      assert.equal(result.json().remaining, remaining);
      assert.equal(result.json().providerName, profile.name);
      assert.deepEqual(parseApiResult(url, 'GET', result.json()), result.json());
      assert.ok(!result.body.includes(first.apiKey));
      assert.ok(!result.body.includes(second.apiKey));
    }
    assert.equal(f.wb.providers.activeId(), a.id);
    assert.deepEqual(requests, ['/eu/v1/usage', '/asia/v1/usage']);
    upstreamError = true;
    const failed = await app.inject({ url: `/api/providers/${a.id}/balance`, headers });
    assert.equal(failed.json().status, 'error');
    assert.ok(!failed.body.includes(first.apiKey));
    const defaults = await app.inject({ url: '/api/providers/default/balance', headers });
    assert.equal(defaults.json().status, 'unavailable');
    assert.equal(
      (await app.inject({ url: '/api/providers/missing/balance', headers })).statusCode,
      404,
    );
  } finally {
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    await app.close();
    await f.close();
  }
});

test('optional provider model inherits CLI defaults and clearing it preserves the saved key', async () => {
  const f = await fixture();
  try {
    const { model: _model, ...withoutModel } = first;
    assert.equal(providerInput.parse(withoutModel).model, '');
    assert.equal(providerInput.parse({ ...first, model: '   ' }).model, '');
    assert.equal(providerInput.safeParse({ ...first, model: 'invalid model' }).success, false);
    const saved = f.wb.providers.save(providerInput.parse(first));
    f.wb.providers.save(providerInput.parse({ ...first, model: '', apiKey: undefined }), saved.id);
    assert.equal(f.wb.providers.runtime(saved.id)!.apiKey, first.apiKey);
    assert.ok(
      !providerLaunch(f.wb.providers.runtime(saved.id)).args.some((arg) =>
        arg.startsWith('model='),
      ),
    );
    f.bridge.defaultModel = 'cli-default-model';
    await f.wb.switchProvider(saved.id);
    assert.equal(f.wb.providers.summary().model, null);
    assert.equal((await f.wb.models()).data[0].model, 'cli-default-model');
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const original = f.bridge.call.bind(f.bridge);
    f.bridge.call = async (method, params = {}) => {
      calls.push({ method, params });
      return original(method, params);
    };
    const thread = (await f.wb.create(f.root, {})).thread;
    await f.wb.send(thread.id, [{ type: 'text', text: '慢速' }], { model: 'manual-model' }, false);
    assert.equal(
      calls.find((call) => call.method === 'thread/start')!.params.model,
      'cli-default-model',
    );
    assert.equal(calls.find((call) => call.method === 'turn/start')!.params.model, 'manual-model');
  } finally {
    await f.close();
  }
});

test('provider credentials are encrypted, validated, retained on edit, and included in verified recovery', async () => {
  const f = await fixture();
  try {
    for (const baseUrl of [
      'http://public.test/v1',
      'file:///tmp/key',
      'https://user:secret@relay.test',
      'https://relay.test/v1?key=secret',
      'https://relay.test/v1/responses',
    ])
      assert.equal(providerInput.safeParse({ ...first, baseUrl }).success, false);
    assert.equal(
      providerInput.parse({ ...first, baseUrl: 'http://127.0.0.1:3001/v1/' }).baseUrl,
      'http://127.0.0.1:3001/v1',
    );
    const saved = f.wb.providers.save(providerInput.parse(first));
    assert.ok(!f.store.get('providerProfiles')!.includes(first.apiKey));
    assert.equal((await fs.stat(path.join(f.store.dir, providerKeyFile))).size, 32);
    assert.equal(new Providers(f.store).runtime(saved.id)!.apiKey, first.apiKey);
    const destination = path.join(f.root, 'backup');
    await backupWorkbench(f.store.dir, destination);
    const manifest = JSON.parse(await fs.readFile(path.join(destination, 'manifest.json'), 'utf8'));
    assert.equal(manifest.credentialFile.path, providerKeyFile);
    const restored = new Store(destination);
    try {
      assert.equal(new Providers(restored).runtime(saved.id)!.apiKey, first.apiKey);
    } finally {
      restored.close();
    }
    await fs.unlink(path.join(f.store.dir, providerKeyFile));
    assert.throws(() => f.wb.providers.runtime(saved.id), /无法读取/);
    await assert.rejects(backupWorkbench(f.store.dir, path.join(f.root, 'broken')));
  } finally {
    await f.close();
  }
});

test('switching applies provider to old sessions, blocks active work, and can return to defaults', async () => {
  const f = await fixture();
  try {
    const thread = (await f.wb.create(f.root, {})).thread;
    const saved = f.wb.providers.save(providerInput.parse(first));
    await f.wb.send(thread.id, [{ type: 'text', text: '慢速' }], {}, false);
    await assert.rejects(f.wb.switchProvider(saved.id), /结束运行任务/);
    await f.wb.interrupt(thread.id);
    const queue = f.store.enqueue(thread.id, f.root, [], {}, 'queued');
    f.store.pauseQueue();
    await assert.rejects(f.wb.switchProvider(saved.id), /清空排队/);
    f.store.db.prepare('DELETE FROM message_queue WHERE id=?').run(queue);
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const original = f.bridge.call.bind(f.bridge);
    f.bridge.call = async (method, params = {}) => {
      calls.push({ method, params });
      return original(method, params);
    };
    await f.wb.switchProvider(saved.id);
    assert.equal(f.wb.providers.activeId(), saved.id);
    await f.wb.send(thread.id, [{ type: 'text', text: '慢速' }], {}, false);
    assert.equal(
      calls.find((c) => c.method === 'thread/resume')!.params.modelProvider,
      managedProviderId,
    );
    assert.equal(calls.find((c) => c.method === 'turn/start')!.params.model, first.model);
    assert.throws(() => f.wb.providers.remove(saved.id), /先切换/);
    await f.wb.interrupt(thread.id);
    calls.length = 0;
    await f.wb.switchProvider(null);
    await f.wb.send(thread.id, [{ type: 'text', text: '慢速' }], {}, false);
    assert.equal(calls.find((c) => c.method === 'thread/resume')!.params.modelProvider, 'openai');
    assert.equal(f.wb.providers.activeId(), null);
  } finally {
    await f.close();
  }
});

test('failed switch rolls back and active edits reconnect without exposing or losing the old key', async () => {
  const f = await fixture();
  try {
    const a = f.wb.providers.save(providerInput.parse(first));
    const b = f.wb.providers.save(providerInput.parse(second));
    await f.wb.switchProvider(a.id);
    const configure = f.bridge.configureProvider.bind(f.bridge);
    let selected: RuntimeProvider | null = null;
    f.bridge.configureProvider = (provider) => {
      selected = provider;
      configure(provider);
    };
    const start = f.bridge.start.bind(f.bridge);
    f.bridge.start = async () => {
      if (selected?.id === b.id) throw new Error('bad provider');
      await start();
    };
    await assert.rejects(f.wb.switchProvider(b.id), /恢复原供应商/);
    assert.equal(f.wb.providers.activeId(), a.id);
    assert.equal(f.bridge.ready, true);
    await f.wb.saveProvider(
      providerInput.parse({ ...first, name: 'updated', apiKey: undefined }),
      a.id,
    );
    assert.equal(f.wb.providers.runtime()!.apiKey, first.apiKey);
    assert.equal(f.wb.providers.summary().name, 'updated');
    assert.equal((await f.wb.models()).data[0].model, first.model);
  } finally {
    await f.close();
  }
});

test('runtime transition excludes new work and concurrent switches until the restart completes', async () => {
  const f = await fixture();
  try {
    const a = f.wb.providers.save(providerInput.parse(first));
    let resume!: () => void;
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const restart = f.bridge.restartProvider.bind(f.bridge);
    f.bridge.restartProvider = async (provider) => {
      await gate;
      await restart(provider);
    };
    const changing = f.wb.switchProvider(a.id);
    await assert.rejects(f.wb.create(f.root, {}), /切换或停止/);
    await assert.rejects(f.wb.switchProvider(a.id), /结束运行任务/);
    resume();
    await changing;
    assert.equal(f.wb.providers.activeId(), a.id);
  } finally {
    await f.close();
  }
});

test('owned app-server receives URL override and environment key without putting the key in argv or logs', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-provider-bridge-'));
  const file = path.join(root, 'peer.js');
  const capture = path.join(root, 'launch.json');
  await fs.writeFile(
    file,
    `const fs = require('node:fs'); const readline = require('node:readline');
    fs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ args: process.argv.slice(2), key: process.env.WORKBENCH_UPSTREAM_API_KEY }));
    console.error('diagnostic ' + process.env.WORKBENCH_UPSTREAM_API_KEY);
    readline.createInterface({ input: process.stdin }).on('line', line => {
      const m = JSON.parse(line); if (m.id === undefined) return;
      const result = m.method === 'initialize' ? { userAgent: 'test-cli' } : m.method === 'model/list' ? { data: [{ id: 'cli-default', model: 'cli-default', displayName: 'Default', isDefault: true, supportedReasoningEfforts: [], defaultReasoningEffort: '' }], nextCursor: null } : { config: { model_provider: 'workbench_managed', model: process.argv.some(arg => arg.startsWith('model=')) ? 'relay-model' : null } };
      process.stdout.write(JSON.stringify(m.method === 'fail' ? { id: m.id, error: { code: -1, message: 'Invalid key: ' + process.env.WORKBENCH_UPSTREAM_API_KEY } } : { id: m.id, result }) + '\\n');
    });`,
  );
  const bridge = new CodexBridge(file);
  const logs: string[] = [];
  bridge.on('diagnostic', (value) => logs.push(value));
  const provider = { ...first, id: 'test' };
  bridge.configureProvider(provider);
  try {
    assert.ok(!JSON.stringify(providerLaunch(provider).args).includes(first.apiKey));
    await bridge.start();
    const launched = JSON.parse(await fs.readFile(capture, 'utf8'));
    assert.equal(launched.key, first.apiKey);
    assert.ok(launched.args.some((arg: string) => arg.includes(first.baseUrl)));
    assert.ok(!JSON.stringify(launched.args).includes(first.apiKey));
    await assert.rejects(
      bridge.call('fail'),
      (error) =>
        error instanceof Error &&
        error.message.includes('[已隐藏]') &&
        !error.message.includes(first.apiKey),
    );
    assert.ok(!logs.join('').includes(first.apiKey));
    await bridge.restartProvider({ ...provider, apiKey: 'model' });
    assert.equal(bridge.defaultModel, 'relay-model');
    await bridge.restartProvider({ ...provider, model: '' });
    assert.equal(bridge.defaultModel, 'cli-default');
    const optional = JSON.parse(await fs.readFile(capture, 'utf8'));
    assert.ok(!optional.args.some((arg: string) => arg.startsWith('model=')));
  } finally {
    await bridge.forceStop();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('provider model catalogs persist, deduplicate and expose only model IDs to workspaces', async () => {
  const f = await fixture();
  try {
    const profile = f.wb.providers.save(
      providerInput.parse({ ...first, models: ['fast', 'deep', 'fast', first.model] }),
    );
    assert.deepEqual(new Providers(f.store).list()[0].models, ['fast', 'deep', first.model]);
    await f.wb.switchProvider(profile.id);
    const result = await f.wb.models();
    assert.deepEqual(
      result.data.map((m) => m.model),
      [first.model, 'fast', 'deep'],
    );
    assert.ok(!JSON.stringify(result).includes(first.baseUrl));
    assert.ok(!JSON.stringify(result).includes(first.apiKey));
    assert.equal(providerInput.safeParse({ ...first, models: ['invalid model'] }).success, false);
    assert.equal(
      providerInput.safeParse({ ...first, models: Array(101).fill('m') }).success,
      false,
    );
    f.wb.providers.save(providerInput.parse(first), profile.id, true);
    assert.deepEqual(f.wb.providers.list()[0].models, ['fast', 'deep', first.model]);
    f.wb.providers.save(providerInput.parse({ ...first, models: [] }), profile.id, true);
    assert.deepEqual(f.wb.providers.list()[0].models, []);
  } finally {
    await f.close();
  }
});
