import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { Store } from './store.js';
import type { ProviderProfile } from '../shared/types.js';
import { fetchProviderModels } from './provider-models.js';

const fail = (message: string, statusCode = 400) =>
  Object.assign(new Error(message), { statusCode });
export const providerInput = z.object({
  name: z.string().trim().min(1).max(80),
  baseUrl: z
    .string()
    .trim()
    .max(2000)
    .transform((value, ctx) => {
      try {
        const url = new URL(value);
        if (
          url.username ||
          url.password ||
          url.search ||
          url.hash ||
          (url.protocol !== 'https:' &&
            !(
              url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
            ))
        )
          throw new Error();
        if (/\/(responses|chat\/completions)\/?$/.test(url.pathname)) throw new Error();
        return url.href.replace(/\/+$/, '');
      } catch {
        ctx.addIssue({
          code: 'custom',
          message:
            '请输入 HTTPS API 基础地址（例如 https://relay.example/v1），不要包含 Key、查询参数或 /responses；本机中转可用 HTTP。',
        });
        return z.NEVER;
      }
    }),
  model: z
    .string()
    .trim()
    .max(200)
    .regex(/^[^\s\x00-\x1f]*$/, '模型 ID 不能包含空白字符')
    .default(''),
  models: z
    .array(
      z
        .string()
        .trim()
        .min(1)
        .max(200)
        .regex(/^[^\s\x00-\x1f]+$/),
    )
    .max(100)
    .transform((values) => [...new Set(values)])
    .optional(),
  apiKey: z
    .string()
    .trim()
    .min(1)
    .max(4096)
    .regex(/^[\x21-\x7e]+$/, 'Key 包含无效字符')
    .optional(),
});
type SavedProvider = Omit<ProviderProfile, 'hasKey'> & { encryptedKey: string };
export type RuntimeProvider = Omit<SavedProvider, 'encryptedKey'> & { apiKey: string };
const setting = 'providerProfiles';
export const providerKeyFile = 'providers.key';
export const managedProviderId = 'workbench_managed';
export const providerEnvKey = 'WORKBENCH_UPSTREAM_API_KEY';

export class Providers {
  private fetchingModels = new Set<string>();
  constructor(private store: Store) {}
  private rows(): SavedProvider[] {
    return JSON.parse(this.store.get(setting) || '[]') as SavedProvider[];
  }
  list(): ProviderProfile[] {
    return this.rows().map(({ encryptedKey: _secret, ...profile }) => ({
      ...profile,
      hasKey: true,
    }));
  }
  activeId() {
    return this.store.get('activeProvider') || null;
  }
  summary() {
    const active = this.rows().find((p) => p.id === this.activeId());
    return {
      id: active?.id || null,
      name: active?.name || '服务器默认配置',
      model: active?.model || null,
    };
  }
  private encryptionKey(create: boolean) {
    const file = path.join(this.store.dir, providerKeyFile);
    if (!fs.existsSync(file) && create) {
      // Never silently replace a lost encryption key for existing credentials.
      if (this.rows().length) throw fail('供应商密钥文件缺失，请从备份恢复', 500);
      fs.writeFileSync(file, randomBytes(32), { flag: 'wx', mode: 0o600 });
    }
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size !== 32)
      throw fail('供应商密钥文件无效，请检查服务器配置', 500);
    return fs.readFileSync(file);
  }
  private seal(key: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.encryptionKey(true), iv);
    const encrypted = Buffer.concat([cipher.update(key, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
  }
  runtime(id = this.activeId()): RuntimeProvider | null {
    if (!id) return null;
    const profile = this.rows().find((p) => p.id === id);
    if (!profile) throw fail('供应商不存在', 404);
    try {
      const data = Buffer.from(profile.encryptedKey, 'base64');
      const decipher = createDecipheriv(
        'aes-256-gcm',
        this.encryptionKey(false),
        data.subarray(0, 12),
      );
      decipher.setAuthTag(data.subarray(12, 28));
      const apiKey = Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString(
        'utf8',
      );
      const { encryptedKey: _secret, ...publicFields } = profile;
      return { ...publicFields, apiKey };
    } catch {
      throw fail('无法读取供应商 Key，请恢复密钥文件或重新配置该供应商', 500);
    }
  }
  save(input: z.output<typeof providerInput>, id?: string, allowActive = false) {
    const profiles = this.rows();
    const existing = id ? profiles.find((p) => p.id === id) : undefined;
    if (id && !existing) throw fail('供应商不存在', 404);
    if (id && id === this.activeId() && !allowActive)
      throw fail('当前供应商需要重新连接后更新', 409);
    if (!existing && profiles.length >= 20) throw fail('最多保存 20 个供应商');
    if (!existing && !input.apiKey) throw fail('新供应商必须填写 API Key');
    const row: SavedProvider = {
      id: id || randomUUID(),
      name: input.name,
      baseUrl: input.baseUrl,
      model: input.model,
      models: input.models ?? existing?.models ?? [],
      modelsFetchedAt: existing?.modelsFetchedAt,
      encryptedKey: input.apiKey ? this.seal(input.apiKey) : existing!.encryptedKey,
    };
    this.store.set(
      setting,
      JSON.stringify(
        existing ? profiles.map((p) => (p.id === row.id ? row : p)) : [...profiles, row],
      ),
    );
    return this.list().find((p) => p.id === row.id)!;
  }
  async refreshModels(id: string) {
    if (this.fetchingModels.has(id)) throw fail('正在获取该供应商模型，请稍后重试', 409);
    const before = this.rows().find((p) => p.id === id);
    if (!before) throw fail('供应商不存在', 404);
    const provider = this.runtime(id)!;
    this.fetchingModels.add(id);
    try {
      const models = await fetchProviderModels(provider);
      const profiles = this.rows();
      const current = profiles.find((p) => p.id === id);
      if (!current) throw fail('供应商已删除，未保存模型', 409);
      if (
        current.baseUrl !== before.baseUrl ||
        current.encryptedKey !== before.encryptedKey ||
        JSON.stringify(current.models) !== JSON.stringify(before.models)
      )
        throw fail('供应商配置已变化，请重新获取模型', 409);
      current.models = models;
      current.modelsFetchedAt = Date.now();
      this.store.set(setting, JSON.stringify(profiles));
      return this.list().find((p) => p.id === id)!;
    } finally {
      this.fetchingModels.delete(id);
    }
  }
  remove(id: string) {
    if (id === this.activeId()) throw fail('请先切换到其他供应商，再删除当前供应商', 409);
    const profiles = this.rows();
    if (!profiles.some((p) => p.id === id)) throw fail('供应商不存在', 404);
    this.store.set(setting, JSON.stringify(profiles.filter((p) => p.id !== id)));
  }
  activate(id: string | null) {
    this.store.set('activeProvider', id || '');
  }
}

// Credentials are passed only in the owned app-server environment, never argv
// or the shared Codex config/auth files.
export function providerLaunch(provider: RuntimeProvider | null) {
  if (!provider) return { args: [] as string[], env: {} as Record<string, string> };
  const values: [string, unknown][] = [
    ['model_provider', managedProviderId],
    [
      `model_providers.${managedProviderId}`,
      {
        name: provider.name,
        base_url: provider.baseUrl,
        env_key: providerEnvKey,
        wire_api: 'responses',
        requires_openai_auth: false,
        supports_websockets: false,
      },
    ],
  ];
  if (provider.model) values.push(['model', provider.model]);
  const toml = (value: unknown): string => {
    if (typeof value === 'object' && value !== null)
      return (
        '{ ' +
        Object.entries(value)
          .map(([key, v]) => `${key} = ${toml(v)}`)
          .join(', ') +
        ' }'
      );
    return JSON.stringify(value);
  };
  return {
    args: values.flatMap(([key, value]) => ['-c', `${key}=${toml(value)}`]),
    env: { [providerEnvKey]: provider.apiKey },
  };
}
