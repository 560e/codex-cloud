import { parseApiResult } from '../shared/protocol';
async function request(url: string, options: RequestInit): Promise<Response> {
  const readOnly = (options.method || 'GET').toUpperCase() === 'GET';
  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) controller.abort();
    const timeout = readOnly ? setTimeout(abort, 12000) : undefined;
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      if (readOnly && attempt < 2 && [502, 503, 504].includes(response.status)) {
        await response.body?.cancel();
      } else return response;
    } catch (error) {
      if (options.signal?.aborted) throw error;
      if (!readOnly || attempt >= 2)
        throw Object.assign(
          new Error(
            readOnly
              ? '暂时无法连接服务器，请检查网络或证书后重新同步。'
              : '请求连接中断，操作结果尚未确认。请先重新同步，避免重复提交。',
          ),
          { networkFailure: true },
        );
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', abort);
    }
    await new Promise((resolve) => setTimeout(resolve, (attempt + 1) * 350));
  }
}
export async function api<T = unknown>(url: string, options: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (options.body && !(options.body instanceof FormData))
    headers['Content-Type'] = 'application/json';
  const response = await request('/api' + url, {
    credentials: 'same-origin',
    ...options,
    headers: { ...headers, ...options.headers },
  });
  let result: unknown;
  try {
    result = await response.json();
  } catch {
    throw new Error(`服务器返回了无法读取的响应 (${response.status})`);
  }
  if (!response.ok) {
    if (response.status === 401 && url !== '/auth/login')
      window.dispatchEvent(new Event('session-expired'));
    const message =
      result && typeof result === 'object' && 'error' in result && typeof result.error === 'string'
        ? result.error
        : `请求失败 (${response.status})`;
    throw Object.assign(new Error(message), {
      statusCode: response.status,
    });
  }
  try {
    return parseApiResult(url, options.method || 'GET', result) as T;
  } catch {
    throw new Error('服务器响应格式不兼容，请刷新页面或检查服务版本');
  }
}
export const post = <T = unknown>(url: string, body: unknown = {}) =>
  api<T>(url, { method: 'POST', body: JSON.stringify(body) });
