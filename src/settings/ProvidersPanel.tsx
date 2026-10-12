import { useEffect, useState } from 'react';
import { api } from '../api';
import { ProviderSettings } from '../ProviderSettings';
import type { RuntimeStatus } from '../../shared/types';
export function ProvidersPanel({
  status,
  refresh,
}: {
  status: RuntimeStatus | null;
  refresh: () => void;
}) {
  const [capabilities, setCapabilities] = useState<
    import('../../shared/types').ProviderCapabilities | null
  >(null);
  const [capabilityError, setCapabilityError] = useState('');
  useEffect(() => {
    let cancelled = false;
    setCapabilities(null);
    setCapabilityError('');
    void api<import('../../shared/types').ProviderCapabilities>('/capabilities')
      .then((value) => {
        if (!cancelled) setCapabilities(value);
      })
      .catch((error: Error) => {
        if (!cancelled) setCapabilityError(error.message);
      });
    return () => {
      cancelled = true;
    };
  }, [status?.provider, status?.connected]);
  return (
    <>
      <ProviderSettings refresh={refresh} currentProvider={status?.provider} />
      <section className="settings-section" aria-label="供应商能力">
        <h3>供应商能力</h3>
        <p className="muted small">
          当前 CLI 声明的能力范围；不代表中转连通性、Key 有效性或账户额度已验证。
        </p>
        {capabilities?.available ? (
          <>
            {(
              [
                ['webSearch', '网页搜索'],
                ['imageGeneration', '图像生成'],
                ['namespaceTools', '命名空间工具'],
              ] as const
            ).map(([key, label]) => (
              <div className="info-row" key={key}>
                <span>{label}</span>
                <span>{capabilities.capabilities[key] ? '声明支持' : '未声明支持'}</span>
              </div>
            ))}
          </>
        ) : (
          <p role="status">
            {capabilityError ||
              (capabilities && !capabilities.available ? capabilities.reason : '正在查询…')}
          </p>
        )}
      </section>
    </>
  );
}
