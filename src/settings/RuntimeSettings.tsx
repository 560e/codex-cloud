import { useEffect, useState } from 'react';
import { api, post } from '../api';
import { Server, RefreshCw } from 'lucide-react';
import { CliSettings } from '../CliSettings';
import type { RuntimeStatus, AccountInfo, SettingsInfo } from '../../shared/types';
export function RuntimeSettings({
  status,
  refresh,
}: {
  status: RuntimeStatus | null;
  refresh: () => void;
}) {
  const [account, setAccount] = useState<AccountInfo | null>(null);
  const [info, setInfo] = useState<SettingsInfo | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      api<AccountInfo>('/account'),
      api<RuntimeStatus & { settings: SettingsInfo }>('/status'),
    ])
      .then(([a, b]) => {
        if (cancelled) return;
        setAccount(a);
        setInfo(b.settings);
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [status?.provider, status?.connected]);
  return (
    <>
      <div className="settings-section">
        <h3>
          <Server size={16} />
          执行环境
        </h3>
        <div className="info-row">
          <span>Codex 连接</span>
          <span className={status?.connected ? 'green-text' : 'amber-text'}>
            {status?.connected ? '已连接' : '未连接'}
          </span>
        </div>
        <div className="info-row">
          <span>CLI</span>
          <code>{status?.version || '等待连接'}</code>
        </div>
        <div className="info-row">
          <span>账户</span>
          <span>{account?.account?.email || account?.account?.type || '使用服务器现有配置'}</span>
        </div>
        <div className="info-row">
          <span>访问地址</span>
          <code>{info?.origin}</code>
        </div>
        <div className="info-row">
          <span>最大并发 / 登录有效期</span>
          <span>
            {info?.maxConcurrent ?? '—'} / {info?.sessionDays ?? '—'} 天
          </span>
        </div>
        <p className="muted small">
          执行环境、端口和并发上限在服务器 .env 中配置。已验证 CLI：{info?.testedCli || '0.155.1'}。
        </p>
        <button
          className="secondary"
          onClick={() => {
            setBusy(true);
            void post('/connect')
              .then(refresh)
              .catch((e) => setError(e.message))
              .finally(() => setBusy(false));
          }}
          disabled={busy}
        >
          <RefreshCw size={14} />
          重新连接
        </button>
      </div>
      <CliSettings refresh={refresh} />
      {error && (
        <div role="alert" className="error-box">
          {error}
        </div>
      )}
    </>
  );
}
