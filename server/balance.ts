import type { UpstreamBalance } from '../shared/types.js';
import type { RuntimeProvider } from './providers.js';
import { setTimeout as delay } from 'node:timers/promises';

// Only normalized, public account data leaves this module; never relay upstream errors.
export async function queryBalance(
  provider: RuntimeProvider | null,
  timeoutMs = 8000,
  signal?: AbortSignal,
): Promise<UpstreamBalance> {
  const metadata = { checkedAt: Date.now(), providerName: provider?.name };
  if (!provider) return { ...metadata, status: 'unavailable' };
  let errorCode: UpstreamBalance['errorCode'] = 'network';
  const timeout = AbortSignal.timeout(timeoutMs);
  try {
    const url = new URL(provider.baseUrl);
    const base = url.pathname.replace(/\/+$/, '');
    url.pathname = `${base.endsWith('/v1') ? base : base + '/v1'}/usage`;
    const response = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${provider.apiKey}` },
      redirect: 'manual',
      signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
    });
    if (!response.ok) {
      await response.body?.cancel();
      return {
        ...metadata,
        checkedAt: Date.now(),
        status: 'error',
        errorCode: 'http',
        httpStatus: response.status,
      };
    }
    if (!response.body)
      return { ...metadata, checkedAt: Date.now(), status: 'error', errorCode: 'invalid_response' };
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 65536) {
          errorCode = 'invalid_response';
          throw new Error();
        }
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    errorCode = 'invalid_response';
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const raw = data?.remaining ?? data?.quota?.remaining ?? data?.balance;
    const remaining = typeof raw === 'string' && raw.trim() ? Number(raw) : raw;
    const unit = data?.unit ?? data?.quota?.unit ?? 'USD';
    const isValid = data?.is_active ?? data?.isValid ?? true;
    if (
      typeof remaining !== 'number' ||
      !Number.isFinite(remaining) ||
      typeof unit !== 'string' ||
      !unit.trim() ||
      unit.length > 32 ||
      typeof isValid !== 'boolean'
    )
      throw new Error();
    return { ...metadata, checkedAt: Date.now(), status: 'available', remaining, unit, isValid };
  } catch {
    return {
      ...metadata,
      checkedAt: Date.now(),
      status: 'error',
      errorCode: timeout.aborted ? 'timeout' : errorCode,
    };
  }
}

// Conversation snapshots run in the background. Give transient upstream failures
// more time without extending the foreground send/settings request timeout.
export async function queryBalanceAfterTurn(
  provider: RuntimeProvider | null,
  query: typeof queryBalance = queryBalance,
  signal?: AbortSignal,
): Promise<UpstreamBalance> {
  for (let attempt = 1; ; attempt++) {
    signal?.throwIfAborted();
    const result = await query(provider, 15000, signal).catch((): UpstreamBalance => ({
      status: 'error',
      checkedAt: Date.now(),
      providerName: provider?.name,
      errorCode: 'network',
    }));
    signal?.throwIfAborted();
    const retryable =
      result.status === 'error' &&
      (result.errorCode === 'timeout' ||
        result.errorCode === 'network' ||
        (result.errorCode === 'http' &&
          (result.httpStatus === 408 ||
            result.httpStatus === 429 ||
            (result.httpStatus ?? 0) >= 500)));
    if (!retryable || attempt >= 3) return { ...result, attempts: attempt };
    await delay(attempt * 1000, undefined, { signal });
  }
}
