import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { connect, type Socket } from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const run = promisify(execFile);
const configUrl = new URL('../server/config.ts', import.meta.url).href;
const balanceUrl = new URL('../server/balance.ts', import.meta.url).href;
const tsxLoader = import.meta.resolve('tsx');

test('startup loads .env proxy for balance fetch, bypasses NO_PROXY and preserves service overrides', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'codex-cloud-proxy-'));
  const requests: string[] = [];
  const tunnels: string[] = [];
  const sockets = new Set<Socket>();
  const target = createServer((req, res) => {
    requests.push(req.url!);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ remaining: 42 }));
  });
  const proxy = createServer();
  for (const server of [target, proxy]) {
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  }
  const targetPort = (target.address() as { port: number }).port;
  const proxyUrl = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
  const directUrl = `http://127.0.0.1:${targetPort}`;
  proxy.on('connect', (req, client, head) => {
    tunnels.push(req.url!);
    // The test proxy resolves this fake provider locally; direct access must fail.
    const upstream = connect(targetPort, '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      upstream.write(head);
      client.pipe(upstream).pipe(client);
    });
    sockets.add(upstream);
    upstream.on('close', () => sockets.delete(upstream));
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
    client.on('close', () => upstream.destroy());
  });
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (/proxy/i.test(key) || key.startsWith('DOTENV_CONFIG_')) delete env[key];
  // Ensure these tests exercise dotenv initialization, not Node's startup flag.
  delete env.NODE_OPTIONS;
  const script = `
    await import(${JSON.stringify(configUrl)});
    const { queryBalance } = await import(${JSON.stringify(balanceUrl)});
    const result = await queryBalance({
      id: 'proxy-test', name: 'test', baseUrl: process.env.TEST_PROVIDER,
      apiKey: 'test-only', model: 'test', models: []
    }, 3000);
    const direct = await fetch(${JSON.stringify(directUrl)}, { signal: AbortSignal.timeout(3000) });
    console.log(JSON.stringify({ result, direct: direct.status, proxy: process.env.HTTP_PROXY }));
  `;
  try {
    for (const mode of ['dotenv', 'service', 'direct']) {
      const configuredProxy = mode === 'service' ? 'http://127.0.0.1:1' : proxyUrl;
      await writeFile(
        path.join(dir, '.env'),
        mode === 'direct'
          ? ''
          : `HTTP_PROXY=${configuredProxy}\nHTTPS_PROXY=${configuredProxy}\nNO_PROXY=127.0.0.1,localhost\n`,
      );
      const before = tunnels.length;
      const { stdout } = await run(
        process.execPath,
        ['--import', tsxLoader, '--input-type=module', '-e', script],
        {
          cwd: dir,
          timeout: 10000,
          env: {
            ...env,
            TEST_PROVIDER: mode === 'direct' ? directUrl : 'http://provider.invalid',
            ...(mode === 'service' ? { HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl } : {}),
          },
        },
      );
      const output = JSON.parse(stdout.trim().split('\n').at(-1)!);
      assert.equal(output.result.status, 'available', mode);
      assert.equal(output.result.remaining, 42, mode);
      assert.equal(output.direct, 200, mode);
      assert.equal(output.proxy, mode === 'direct' ? undefined : proxyUrl, mode);
      assert.deepEqual(tunnels.slice(before), mode === 'direct' ? [] : ['provider.invalid:80']);
    }
    assert.deepEqual(requests, ['/v1/usage', '/', '/v1/usage', '/', '/v1/usage', '/']);

    await writeFile(
      path.join(dir, '.env'),
      'HTTPS_PROXY=socks5://user:private-password@localhost:1\n',
    );
    await assert.rejects(
      run(process.execPath, ['--import', tsxLoader, '--input-type=module', '-e', script], {
        cwd: dir,
        env,
        timeout: 10000,
      }),
      (error: unknown) => {
        const stderr = (error as { stderr: string }).stderr;
        assert.match(stderr, /Invalid HTTP_PROXY or HTTPS_PROXY/);
        assert.ok(!stderr.includes('private-password'));
        return true;
      },
    );
  } finally {
    for (const socket of sockets) socket.destroy();
    await Promise.all(
      [target, proxy].map(
        (server) => new Promise<void>((resolve) => server.close(() => resolve())),
      ),
    );
    await rm(dir, { recursive: true, force: true });
  }
});
