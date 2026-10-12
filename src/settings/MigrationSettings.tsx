import { useState } from 'react';
import { api, post } from '../api';
type Preview = {
  id: string;
  createdAt: string;
  platform: string;
  files: number;
  projects: { id: string; name: string; path: string; target: string }[];
};
export function MigrationSettings() {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const run = async (fn: () => Promise<void>) => {
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
  };
  return (
    <section className="settings-section" aria-label="备份与迁移">
      <h3>备份与迁移</h3>
      <p className="muted small">
        统一 .tar.gz 数据包，可在 Linux、Windows、macOS
        之间导入导出。包含工作台数据、附件、供应商密钥、Codex 配置与会话、用户 Skills。项目源码和
        CLI 安装不包含，请先复制项目代码并安装 CLI。MCP 本机命令和环境变量需适配目标机器。
      </p>
      <div className="button-row">
        <button
          className="secondary"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              const response = await fetch('/api/migration/export', {
                method: 'POST',
                credentials: 'same-origin',
              });
              if (!response.ok) {
                const result = await response.json();
                throw new Error(result.error || '导出失败');
              }
              const url = URL.createObjectURL(await response.blob());
              const link = document.createElement('a');
              link.href = url;
              link.download = 'codex-cloud-' + new Date().toISOString().slice(0, 10) + '.tar.gz';
              link.click();
              setTimeout(() => URL.revokeObjectURL(url), 30000);
              setMessage('迁移包已导出，请妥善保存其中的凭据');
            })
          }
        >
          导出完整迁移包
        </button>
      </div>
      <label className="field">
        <span>导入迁移包（最大 2 GiB）</span>
        <input
          aria-label="导入迁移包"
          type="file"
          accept=".tar.gz,.tgz"
          disabled={busy || !!preview}
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (!file) return;
            void run(async () => {
              const data = new FormData();
              data.append('file', file);
              setPreview(await api<Preview>('/migration/preview', { method: 'POST', body: data }));
            });
          }}
        />
      </label>
      {preview && (
        <div className="management-editor">
          <p>
            来源：{preview.platform} · {new Date(preview.createdAt).toLocaleString()} ·{' '}
            {preview.files} 个已校验文件
          </p>
          <p>
            导入将替换当前工作台与 Codex
            数据，并使用备份中的密码重新登录；原数据会保留为恢复副本。请核对每个项目在当前机器上的目录。
          </p>
          {preview.projects.map((item) => (
            <label className="field" key={item.id}>
              <span>
                {item.name}
                <small>原目录：{item.path}</small>
              </span>
              <input
                aria-label={`迁移项目目录 ${item.name}`}
                value={item.target}
                onChange={(e) =>
                  setPreview({
                    ...preview,
                    projects: preview.projects.map((p) =>
                      p.id === item.id ? { ...p, target: e.target.value } : p,
                    ),
                  })
                }
              />
            </label>
          ))}
          <div className="button-row">
            <button
              className="danger"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await post('/migration/apply', {
                    id: preview.id,
                    confirm: true,
                    projects: Object.fromEntries(preview.projects.map((p) => [p.id, p.target])),
                  });
                  window.location.reload();
                })
              }
            >
              确认导入并重新登录
            </button>
            <button
              className="secondary"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await api('/migration/' + preview.id, { method: 'DELETE' });
                  setPreview(null);
                })
              }
            >
              取消导入
            </button>
          </div>
        </div>
      )}
      {busy && <p role="status">正在处理，请稍候…</p>}
      {message && <p role="status">{message}</p>}
      {error && (
        <p className="error-box" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
