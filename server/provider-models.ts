import type { RuntimeProvider } from './providers.js';

const fail = (message: string) => Object.assign(new Error(message), { statusCode: 502 });

export async function fetchProviderModels(provider: RuntimeProvider, timeoutMs = 15000) {
  const url = new URL(provider.baseUrl);
  const base = url.pathname.replace(/\/+$/, '');
  url.pathname = `${base || '/v1'}/models`;
  const timeout = AbortSignal.timeout(timeoutMs);
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${provider.apiKey}`, Accept: 'application/json' },
      redirect: 'manual',
      signal: timeout,
    });
  } catch {
    throw fail(timeout.aborted ? '获取模型超时，原列表未变更' : '无法连接供应商，原列表未变更');
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw fail(`供应商模型接口返回 HTTP ${response.status}，原列表未变更`);
  }
  let data: unknown;
  try {
    if (!response.body) throw new Error();
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 1024 * 1024) throw new Error();
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw fail(
      timeout.aborted ? '获取模型超时，原列表未变更' : '供应商模型响应无效或过大，原列表未变更',
    );
  }
  if (!data || typeof data !== 'object' || !('data' in data) || !Array.isArray(data.data))
    throw fail('供应商模型响应格式无效，原列表未变更');
  if ('has_more' in data && data.has_more === true)
    throw fail('供应商返回了不完整的分页列表，原列表未变更');
  const models = new Set<string>();
  for (const item of data.data) {
    if (
      !item ||
      typeof item.id !== 'string' ||
      !item.id.trim() ||
      item.id.trim().length > 200 ||
      /[\s\x00-\x1f]/.test(item.id.trim())
    )
      throw fail('供应商返回了无效模型 ID，原列表未变更');
    models.add(item.id.trim());
  }
  if (models.size > 100) throw fail('供应商返回超过 100 个模型，原列表未变更');
  return [...models];
}
