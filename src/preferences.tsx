import { useState } from 'react';

export const effortOptions = [
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
  { value: 'xhigh', label: '极高' },
];
export type Preferences = { policy: string; sandbox: string; effort: string; models: string[] };
export function readPreferences(): Preferences {
  let saved: Partial<Preferences> = {};
  try {
    saved = JSON.parse(localStorage.getItem('workbench.preferences') || '{}') || {};
  } catch {
    /* Use safe defaults for old or invalid storage. */
  }
  return {
    policy: ['on-request', 'untrusted', 'never'].includes(saved.policy || '')
      ? saved.policy!
      : 'on-request',
    sandbox: ['workspace-write', 'read-only', 'danger-full-access'].includes(saved.sandbox || '')
      ? saved.sandbox!
      : 'danger-full-access',
    effort: effortOptions.some((o) => o.value === saved.effort) ? saved.effort! : '',
    models: Array.isArray(saved.models)
      ? saved.models
          .filter((v): v is string => typeof v === 'string' && /^[^\s\x00-\x1f]{1,200}$/.test(v))
          .slice(0, 100)
      : [],
  };
}
export function ExecutionPreferences({
  value,
  onSave,
}: {
  value: Preferences;
  onSave: (value: Preferences) => void;
}) {
  const [draft, setDraft] = useState(value);
  const [models, setModels] = useState(value.models.join('\n'));
  const [message, setMessage] = useState('');
  return (
    <section className="settings-section" aria-label="新会话默认设置">
      <h3>新会话默认设置</h3>
      <p className="muted small">
        保存在当前浏览器。审批和文件访问设置仅用于新建会话；已有会话保持原执行权限。
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const names = [
            ...new Set(
              models
                .split(/\r?\n/)
                .map((v) => v.trim())
                .filter(Boolean),
            ),
          ];
          if (names.length > 100 || names.some((v) => !/^[^\s\x00-\x1f]{1,200}$/.test(v))) {
            setMessage('最多 100 个模型，每个 ID 最多 200 字符，不能包含空白。');
            return;
          }
          try {
            const next = { ...draft, models: names };
            localStorage.setItem('workbench.preferences', JSON.stringify(next));
            onSave(next);
            setMessage('默认设置已保存');
          } catch {
            setMessage('无法保存，请检查浏览器存储权限');
          }
        }}
      >
        <label className="field">
          <span>审批</span>
          <select
            aria-label="审批"
            value={draft.policy}
            onChange={(e) => setDraft({ ...draft, policy: e.target.value })}
          >
            <option value="on-request">按需审批</option>
            <option value="untrusted">严格审批</option>
            <option value="never">不请求审批</option>
          </select>
        </label>
        <label className="field">
          <span>文件访问</span>
          <select
            aria-label="文件访问"
            value={draft.sandbox}
            onChange={(e) => setDraft({ ...draft, sandbox: e.target.value })}
          >
            <option value="workspace-write">允许修改项目</option>
            <option value="read-only">只读</option>
            <option value="danger-full-access">完整访问服务器</option>
          </select>
        </label>
        {draft.sandbox === 'danger-full-access' && (
          <p className="amber-text small">完整访问将允许 Codex 操作项目之外的服务器文件。</p>
        )}
        <label className="field">
          <span>默认思考强度</span>
          <select
            aria-label="默认思考强度"
            value={draft.effort}
            onChange={(e) => setDraft({ ...draft, effort: e.target.value })}
          >
            <option value="">跟随模型默认</option>
            {effortOptions.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <p className="muted small">
          低、中、高、极高四档。模型明确不支持的档位在工作台禁用；中转模型需由供应商支持所选强度。
        </p>
        <label className="field">
          <span>个人模型列表（每行一个 ID）</span>
          <textarea
            rows={4}
            maxLength={20100}
            value={models}
            onChange={(e) => setModels(e.target.value)}
          />
          <small>用于筛选工作台下拉框；留空显示供应商模型列表。不会限制服务器可调用的模型。</small>
        </label>
        <button className="primary">保存默认设置</button>
        {message && <p role="status">{message}</p>}
      </form>
    </section>
  );
}
