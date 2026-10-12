import { useState } from 'react';
import { api, post } from './api';
export function CliSettings({ refresh }: { refresh: () => void }) {
  const [latest, setLatest] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="settings-section" aria-label="CLI 在线更新">
      <h3>Codex CLI 在线更新</h3>
      <p className="muted small">
        下载官方稳定版到程序目录，验证连接后切换；系统安装保留。更新前请结束所有任务并清空队列。
      </p>
      <div className="button-row">
        <button
          className="secondary"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              const result = await api<{ latest: string }>('/cli');
              setLatest(result.latest);
              setMessage('最新稳定版：' + result.latest);
            })
          }
        >
          检查 CLI 更新
        </button>
        {latest && (
          <button
            className="primary"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const result = await post<{ version: string }>('/cli/update', {
                  version: latest,
                  confirm: true,
                });
                setMessage('已更新至 ' + result.version);
                refresh();
              })
            }
          >
            更新至 {latest}
          </button>
        )}
      </div>
      {busy && <p role="status">正在处理，请等待…</p>}
      {message && <p role="status">{message}</p>}
      {error && (
        <p role="alert" className="error-box">
          {error}
        </p>
      )}
    </section>
  );
}
