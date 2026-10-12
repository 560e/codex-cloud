import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { Json } from '../shared/types.js';
import { wireSchema, parseRpcResult, type RpcMethod, type RpcResult } from '../shared/protocol.js';
import { providerLaunch, providerEnvKey, type RuntimeProvider } from './providers.js';

export function resolveCodex(custom?: string): { command: string; args: string[] } {
  const candidates = custom
    ? [custom]
    : (process.env.PATH || '')
        .split(path.delimiter)
        .flatMap((dir) =>
          process.platform === 'win32'
            ? [
                path.join(dir, 'codex.exe'),
                path.join(dir, 'node_modules/@openai/codex/bin/codex.js'),
              ]
            : [path.join(dir, 'codex')],
        );
  for (let file of candidates) {
    if (/\.(cmd|ps1)$/i.test(file))
      file = path.join(path.dirname(file), 'node_modules/@openai/codex/bin/codex.js');
    if (!existsSync(file)) continue;
    return file.endsWith('.js')
      ? { command: process.execPath, args: [file] }
      : { command: file, args: [] };
  }
  throw new Error('未找到 Codex。请安装 CLI 或在 .env 配置 CODEX_BIN 的绝对路径。');
}

export class CodexBridge extends EventEmitter {
  readonly isTest: boolean = false;
  child?: ChildProcessWithoutNullStreams;
  ready = false;
  version?: string;
  error?: string;
  defaultModelProvider = 'openai';
  defaultModel?: string;
  private provider: RuntimeProvider | null = null;
  private startPromise?: Promise<void>;
  private nextId = 1;
  private pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
      method: string;
    }
  >();
  constructor(private binary?: string) {
    super();
  }
  get binaryPath() {
    return this.binary;
  }
  setBinary(binary?: string) {
    if (this.child || this.ready) throw new Error('请先停止执行器再切换 CLI');
    this.binary = binary;
  }
  configureProvider(provider: RuntimeProvider | null) {
    if (this.child || this.ready) throw new Error('请先停止执行器再修改供应商');
    this.provider = provider;
  }
  async restartProvider(provider: RuntimeProvider | null) {
    await this.forceStop();
    await this.startPromise?.catch(() => {});
    this.configureProvider(provider);
    await this.start();
  }
  private redact(value: string, provider = this.provider) {
    if (!provider) return value;
    for (const secret of [provider.apiKey, provider.baseUrl])
      value = value
        .replaceAll(secret, '[已隐藏]')
        .replaceAll(JSON.stringify(secret).slice(1, -1), '[已隐藏]');
    return value;
  }
  async start() {
    if (this.ready) return;
    if (this.startPromise) return this.startPromise;
    if (this.child) throw new Error('Codex 连接正在关闭，请稍后重试');
    this.startPromise = this.connect().finally(() => {
      this.startPromise = undefined;
    });
    return this.startPromise;
  }
  private async connect() {
    const provider = this.provider;
    const { command, args } = resolveCodex(this.binary);
    const launch = providerLaunch(this.provider);
    const childEnv = { ...process.env };
    delete childEnv[providerEnvKey];
    const child = spawn(command, [...args, ...launch.args, 'app-server', '--listen', 'stdio://'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
      env: { ...childEnv, ...launch.env },
    });
    this.child = child;
    child.stdin.on('error', () => {});
    let ended = false;
    const end = (message: string) => {
      if (ended) return;
      ended = true;
      this.ready = false;
      this.error = message;
      if (this.child === child) this.child = undefined;
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error(message));
      }
      this.pending.clear();
      this.emit('disconnect', message);
    };
    child.on('error', (e) => end(e.message));
    child.on('exit', (code, signal) => end(`Codex 进程已退出 (${code ?? signal})`));
    const lines = createInterface({ input: child.stdout });
    lines.on('line', (line) => {
      let msg;
      try {
        // Do not redact protocol IDs, model IDs or user content: a short relay
        // key can also occur in ordinary data. Sanitize diagnostic/error text.
        msg = wireSchema.parse(
          JSON.parse(line, (key, value: unknown) =>
            key === 'message' && typeof value === 'string' ? this.redact(value, provider) : value,
          ) as unknown,
        );
      } catch {
        return;
      }
      if (msg.method && msg.id !== undefined) this.emit('request', msg);
      else if (msg.method) this.emit('notification', msg);
      else if (typeof msg.id === 'number') {
        const request = this.pending.get(msg.id);
        if (!request) return;
        clearTimeout(request.timer);
        this.pending.delete(msg.id);
        if (msg.error)
          request.reject(
            Object.assign(new Error(this.redact(msg.error.message || 'Codex 请求失败', provider)), {
              rpcCode: msg.error.code,
            }),
          );
        else {
          try {
            request.resolve(parseRpcResult(request.method, msg.result));
          } catch {
            request.reject(new Error(`Codex 返回的数据格式不兼容：${request.method}`));
          }
        }
      }
    });
    const diagnostics = createInterface({ input: child.stderr });
    diagnostics.on('line', (line) =>
      this.emit('diagnostic', this.redact(line, provider).slice(0, 4000) + '\n'),
    );
    try {
      const result = await this.call('initialize', {
        clientInfo: {
          name: 'codex_private_workbench',
          title: 'Codex Cloud',
          version: '1.0.0',
        },
        capabilities: { experimentalApi: true, requestAttestation: false },
      });
      this.write({ method: 'initialized' });
      this.version = result.userAgent;
      const settings = await this.call('config/read', { includeLayers: false });
      this.defaultModelProvider = settings.config.model_provider || 'openai';
      this.defaultModel = settings.config.model || undefined;
      if (provider && !provider.model && !this.defaultModel) {
        // Resolve the CLI default explicitly so resuming a thread does not
        // accidentally retain the previous supplier's model.
        const seen = new Set<string>();
        let cursor: string | undefined;
        do {
          const page = await this.call('model/list', {
            includeHidden: true,
            limit: 100,
            ...(cursor ? { cursor } : {}),
          });
          this.defaultModel = page.data.find((model) => model.isDefault)?.model;
          cursor = page.nextCursor || undefined;
          if (cursor && seen.has(cursor)) throw new Error('CLI 模型列表分页异常');
          if (cursor) seen.add(cursor);
        } while (!this.defaultModel && cursor);
        if (!this.defaultModel)
          throw new Error('无法确定 CLI 默认模型，请在供应商设置中填写默认模型 ID');
      }
      this.ready = true;
      this.error = undefined;
      this.emit('connected');
    } catch (error) {
      this.stop();
      throw error;
    }
  }
  private write(message: Json) {
    if (!this.child || this.child.stdin.destroyed) throw new Error('Codex 未连接');
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }
  call<M extends RpcMethod>(method: M, params?: Json): Promise<RpcResult<M>>;
  call(method: string, params?: Json): Promise<unknown>;
  call(method: string, params: Json = {}): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex 请求超时：${method}。连接将重建，请核对会话状态。`));
        // A timed-out mutation may still be executing. Stop this owned process;
        // never retry turns automatically or release its execution lock silently.
        this.stop();
      }, 90000);
      this.pending.set(id, { resolve, reject, timer, method });
      try {
        this.write({ id, method, params });
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }
  respond(id: string | number, result: Json) {
    this.write({ id, result });
  }
  rejectRequest(id: string | number, message: string) {
    this.write({ id, error: { code: -32601, message } });
  }
  async forceStop() {
    const child = this.child;
    if (!child?.pid) return;
    let cleanup = () => {};
    const exited = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.off('exit', done);
        reject(new Error('强制终止未确认，请检查执行器状态'));
      }, 10000);
      const done = () => {
        cleanup();
        resolve();
      };
      cleanup = () => {
        clearTimeout(timer);
        child.off('exit', done);
      };
      child.once('exit', done);
      if (child.exitCode !== null || child.signalCode !== null) done();
    });
    void exited.catch(() => {});
    try {
      if (process.platform === 'win32') {
        await new Promise<void>((resolve, reject) => {
          // Kill only the app-server tree owned by this workbench, never all Codex processes.
          const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
            windowsHide: true,
            stdio: 'ignore',
          });
          killer.once('error', reject);
          killer.once('exit', (code) =>
            code === 0 || child.exitCode !== null || child.signalCode !== null
              ? resolve()
              : reject(new Error(`终止 Codex 进程树失败 (${code})`)),
          );
        });
      } else {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
      }
      await exited;
    } finally {
      cleanup();
    }
  }
  stop() {
    const child = this.child;
    if (!child) return;
    this.ready = false;
    child.stdin.end();
    if (process.platform !== 'win32' && child.pid) {
      // This child owns a detached process group. Also reap its remaining tools
      // when the group leader exits; killing only the leader leaks descendants.
      const pid = child.pid;
      const signal = (value: NodeJS.Signals) => {
        try {
          process.kill(-pid, value);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH')
            this.emit('diagnostic', `Codex 进程组终止失败：${(error as Error).message}\n`);
        }
      };
      const timer = setTimeout(() => signal('SIGKILL'), 1500);
      timer.unref();
      child.once('exit', () => {
        clearTimeout(timer);
        signal('SIGKILL');
      });
      signal('SIGTERM');
      return;
    }
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null && child.pid) {
        spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore',
        });
      }
    }, 1500);
    timer.unref();
  }
}
