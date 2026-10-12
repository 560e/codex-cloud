import { useState } from 'react';
import { api } from '../api';

export type FeatureFlags = { memory: boolean; collaboration: boolean };

export function FeatureSettings({
  value,
  onChange,
}: {
  value: FeatureFlags;
  onChange: (value: FeatureFlags) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const update = async (next: Partial<FeatureFlags>) => {
    setBusy(true);
    setError('');
    try {
      onChange(await api<FeatureFlags>('/features', { method: 'PUT', body: JSON.stringify(next) }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="settings-section" aria-label="记忆与协作功能">
      <h3>记忆与协作</h3>
      <p className="muted small">两个功能默认关闭，可独立开启。关闭协作会暂停后续自动交接。</p>
      <label className="feature-toggle">
        <span>
          <strong>跨会话及项目记忆</strong>
          <small>保存记忆，在相关会话中引用已开启范围内的内容。</small>
        </span>
        <input
          type="checkbox"
          checked={value.memory}
          disabled={busy}
          onChange={(e) => void update({ memory: e.target.checked })}
        />
      </label>
      <label className="feature-toggle">
        <span>
          <strong>多会话及项目协作</strong>
          <small>创建协作组，让已有会话按自定义顺序交接。</small>
        </span>
        <input
          type="checkbox"
          checked={value.collaboration}
          disabled={busy}
          onChange={(e) => void update({ collaboration: e.target.checked })}
        />
      </label>
      {error && (
        <p className="error-box" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
