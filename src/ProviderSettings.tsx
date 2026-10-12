import { useEffect, useState } from 'react';
import { RefreshCw, Server } from 'lucide-react';
import { api, post } from './api';
import type {
  ProviderAccess,
  ProviderList,
  ProviderProfile,
  UpstreamBalance,
} from '../shared/types';
import { formatMoney, moneyUnit } from '../shared/money';
import { balanceErrorText } from '../shared/balance';

function ProviderBalance({
  id,
  name,
  profiles,
}: {
  id: string;
  name: string;
  profiles: ProviderProfile[];
}) {
  const [balance, setBalance] = useState<UpstreamBalance | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setBalance(null);
    void api<UpstreamBalance>(`/providers/${encodeURIComponent(id)}/balance`, {
      signal: controller.signal,
    })
      .then((next) => {
        if (!controller.signal.aborted) setBalance(next);
      })
      .catch(() => {
        if (!controller.signal.aborted) setBalance({ status: 'error', checkedAt: Date.now() });
      });
    return () => controller.abort();
  }, [id, profiles, revision]);
  const loading = !balance || balance.status === 'loading';
  return (
    <span className="provider-balance" aria-label={`${name}当前余额`} aria-live="polite">
      <span
        title={balance ? `查询时间：${new Date(balance.checkedAt).toLocaleString()}` : undefined}
      >
        当前余额：
        {loading
          ? '查询中…'
          : balance.status === 'available'
            ? `${formatMoney(balance.remaining)} ${moneyUnit(balance.unit)}`
            : balance.status === 'unavailable'
              ? '暂不支持查询'
              : balanceErrorText(balance)}
        {balance?.isValid === false && '（账户未激活）'}
      </span>
      {balance?.status !== 'unavailable' && (
        <button
          className="text-button"
          disabled={loading}
          aria-label={`刷新 ${name}余额`}
          title="刷新余额"
          onClick={() => setRevision((value) => value + 1)}
        >
          <RefreshCw size={13} />
        </button>
      )}
    </span>
  );
}

export function ProviderSettings({
  refresh,
  currentProvider,
}: {
  refresh: () => void;
  currentProvider?: ProviderAccess['active'];
}) {
  const [access, setAccess] = useState<ProviderAccess | null>(null);
  const [profiles, setProfiles] = useState<ProviderProfile[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [models, setModels] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [fetchingModels, setFetchingModels] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [confirm, setConfirm] = useState<{
    action: 'activate' | 'delete';
    id: string | null;
    name: string;
  } | null>(null);
  const clearForm = () => {
    setEditing(null);
    setShowForm(false);
    setName('');
    setBaseUrl('');
    setModel('');
    setModels('');
    setApiKey('');
  };
  const reload = async () => {
    const next = await api<ProviderAccess>('/providers/access');
    setAccess(next);
    if (next.unlocked) setProfiles((await api<ProviderList>('/providers')).profiles);
    else {
      setProfiles([]);
      clearForm();
      setConfirm(null);
    }
  };
  useEffect(() => {
    void reload().catch((e) => setError(e.message));
  }, [currentProvider?.id, currentProvider?.name, currentProvider?.model]);
  async function perform(operation: () => Promise<unknown>, success: string) {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await operation();
      setMessage(success);
      setConfirm(null);
      await reload();
      refresh();
    } catch (e) {
      setError((e as Error).message);
      await reload().catch(() => {});
    } finally {
      setBusy(false);
    }
  }
  async function fetchModels(profile: ProviderProfile) {
    setBusy(true);
    setFetchingModels(profile.id);
    setError('');
    setMessage('');
    try {
      const updated = await post<ProviderProfile>(`/providers/${profile.id}/models/refresh`);
      setProfiles((rows) => rows.map((row) => (row.id === updated.id ? updated : row)));
      if (editing === updated.id) setModels((updated.models || []).join('\n'));
      setMessage(
        `已获取“${updated.name}”的 ${updated.models?.length || 0} 个模型并保存，再次点击“获取模型”才会重新获取。`,
      );
      refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setFetchingModels(null);
      setBusy(false);
    }
  }
  return (
    <section className="settings-section provider-settings" aria-label="模型供应商">
      <h3>
        <Server size={16} />
        模型供应商
      </h3>
      <div className="info-row">
        <span>当前供应商</span>
        <strong>{access?.active.name || '正在读取…'}</strong>
      </div>
      {access?.active.model && (
        <div className="info-row">
          <span>默认模型</span>
          <code>{access.active.model}</code>
        </div>
      )}
      <p className="muted small">
        供应商切换对整个工作台生效。地址和 Key 由服务器使用，登录后即可管理配置，已保存的 Key
        不会回显。
      </p>
      {access && (
        <>
          <div className="button-row provider-toolbar">
            <button
              className="secondary"
              disabled={busy}
              onClick={() => {
                clearForm();
                setShowForm(true);
                setMessage('');
              }}
            >
              添加供应商
            </button>
          </div>
          <div className="provider-list">
            <div className="provider-card">
              <div>
                <div className="provider-heading">
                  <strong>服务器默认配置</strong>
                  <ProviderBalance id="default" name="服务器默认配置" profiles={profiles} />
                </div>
                <p className="muted small">使用服务器原有的 Codex 配置。</p>
              </div>
              {access.active.id === null ? (
                <span className="green-text">使用中</span>
              ) : (
                <button
                  className="secondary"
                  disabled={busy}
                  onClick={() =>
                    setConfirm({ action: 'activate', id: null, name: '服务器默认配置' })
                  }
                >
                  切换至默认配置
                </button>
              )}
            </div>
            {profiles.map((profile) => (
              <div className="provider-card" key={profile.id}>
                <div className="provider-details">
                  <div className="provider-heading">
                    <strong>{profile.name}</strong>
                    <ProviderBalance id={profile.id} name={profile.name} profiles={profiles} />
                  </div>
                  <p>{profile.baseUrl}</p>
                  <p className="muted small">{profile.model || '沿用 CLI 默认模型'} · Key 已保存</p>
                  <p className="muted small">
                    已保存 {profile.models?.length || 0} 个可选模型
                    {profile.modelsFetchedAt
                      ? ` · 上次获取：${new Date(profile.modelsFetchedAt).toLocaleString()}`
                      : ' · 尚未从供应商获取'}
                  </p>
                </div>
                <div className="button-row">
                  <button
                    className="secondary"
                    disabled={busy}
                    aria-label={`获取 ${profile.name}模型`}
                    onClick={() => void fetchModels(profile)}
                  >
                    {fetchingModels === profile.id ? '正在获取…' : '获取模型'}
                  </button>
                  {access.active.id === profile.id ? (
                    <span className="green-text">使用中</span>
                  ) : (
                    <button
                      className="secondary"
                      disabled={busy}
                      aria-label={`切换到 ${profile.name}`}
                      onClick={() =>
                        setConfirm({ action: 'activate', id: profile.id, name: profile.name })
                      }
                    >
                      使用
                    </button>
                  )}
                  <button
                    className="text-button"
                    disabled={busy}
                    aria-label={`编辑 ${profile.name}`}
                    onClick={() => {
                      setEditing(profile.id);
                      setName(profile.name);
                      setBaseUrl(profile.baseUrl);
                      setModel(profile.model);
                      setModels((profile.models || []).join('\n'));
                      setApiKey('');
                      setShowForm(true);
                      setMessage('');
                    }}
                  >
                    编辑
                  </button>
                  <button
                    className="text-button"
                    disabled={busy || access.active.id === profile.id}
                    aria-label={`删除供应商 ${profile.name}`}
                    onClick={() =>
                      setConfirm({ action: 'delete', id: profile.id, name: profile.name })
                    }
                  >
                    删除
                  </button>
                </div>
              </div>
            ))}
          </div>
          {confirm && (
            <div className="maintenance-confirm">
              <p>
                {confirm.action === 'activate'
                  ? `切换到“${confirm.name}”？后续消息将发送给此供应商，需要先结束运行任务、处理审批并清空队列。`
                  : `删除“${confirm.name}”及其保存的 Key？`}
              </p>
              <div className="button-row">
                <button className="secondary" disabled={busy} onClick={() => setConfirm(null)}>
                  取消
                </button>
                <button
                  className={confirm.action === 'activate' ? 'primary' : 'danger'}
                  disabled={busy}
                  onClick={() =>
                    void perform(
                      () =>
                        confirm.action === 'activate'
                          ? post('/providers/active', { id: confirm.id })
                          : api(`/providers/${confirm.id}`, { method: 'DELETE' }),
                      confirm.action === 'activate'
                        ? '供应商已切换。执行器已启动，上游模型可用性以实际请求结果为准。'
                        : '供应商已删除。',
                    )
                  }
                >
                  {busy
                    ? '正在处理…'
                    : confirm.action === 'activate'
                      ? '确认切换'
                      : '确认删除供应商'}
                </button>
              </div>
            </div>
          )}
          {showForm && (
            <form
              className="provider-form"
              onSubmit={(e) => {
                e.preventDefault();
                const body = {
                  name,
                  baseUrl,
                  model,
                  models: models
                    .split(/\r?\n/)
                    .map((v) => v.trim())
                    .filter(Boolean),
                  ...(apiKey ? { apiKey } : {}),
                };
                void perform(
                  async () => {
                    await api(editing ? `/providers/${editing}` : '/providers', {
                      method: editing ? 'PUT' : 'POST',
                      body: JSON.stringify(body),
                    });
                    clearForm();
                  },
                  editing === access.active.id
                    ? '配置已保存，当前供应商已重新连接。'
                    : '供应商已保存，可点击“使用”进行切换。',
                );
              }}
            >
              <h4>{editing ? '编辑供应商' : '添加供应商'}</h4>
              <label className="field">
                <span>供应商名称</span>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                  maxLength={80}
                  placeholder="例如：欧洲中转"
                  disabled={busy}
                />
              </label>
              <label className="field">
                <span>API 基础地址</span>
                <input
                  type="url"
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  required
                  maxLength={2000}
                  placeholder="https://relay.example/v1"
                  disabled={busy}
                  autoComplete="off"
                />
              </label>
              <label className="field">
                <span>API Key{editing ? '（留空保留原值）' : ''}</span>
                <input
                  type="password"
                  autoComplete="new-password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  required={!editing}
                  maxLength={4096}
                  disabled={busy}
                />
              </label>
              <label className="field">
                <span>默认模型 ID</span>
                <input
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  maxLength={200}
                  placeholder="选填，留空沿用 CLI 默认模型"
                  disabled={busy}
                />
              </label>
              <label className="field">
                <span>可选模型 ID（每行一个）</span>
                <textarea
                  value={models}
                  onChange={(e) => setModels(e.target.value)}
                  rows={5}
                  disabled={busy}
                  maxLength={20100}
                  placeholder="填写此供应商支持的模型 ID"
                />
                <small>
                  最多 100
                  个；可手动填写，或保存供应商后点击“获取模型”。默认模型自动加入列表，页面刷新不会重新获取。
                </small>
              </label>

              <p className="muted small">
                默认模型可不填；也可在聊天输入框手动指定模型。所选模型需受中转支持。
              </p>
              <p className="muted small">
                中转需兼容 OpenAI Responses API；填写基础地址，不要填写完整的 /responses
                路径。已保存的 Key 不回显。
              </p>
              {editing === access.active.id && (
                <p className="muted small">
                  保存当前供应商会重新连接执行器，需先结束任务、处理审批并清空队列。
                </p>
              )}
              <div className="button-row">
                <button type="button" className="secondary" disabled={busy} onClick={clearForm}>
                  取消编辑
                </button>
                <button className="primary" disabled={busy}>
                  {busy ? '正在保存…' : '保存供应商'}
                </button>
              </div>
            </form>
          )}
        </>
      )}
      {error && (
        <p className="error-box" role="alert">
          {error}
        </p>
      )}
      {message && (
        <p className="maintenance-result" role="status">
          {message}
        </p>
      )}
    </section>
  );
}
