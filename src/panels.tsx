import { projectDirectory } from '../shared/project-directory';
import { useEffect, useState } from 'react';
import { ArrowLeft, ArrowUpRight, ChevronRight, Folder, Shield } from 'lucide-react';
import { api, post } from './api';
import { Modal, Spinner } from './components';
import type { Project, RuntimeStatus, SettingsInfo } from '../shared/types';
import { identity } from './identity';
import {
  AUTO_COMPACT_PERCENTAGES,
  DEFAULT_AUTO_COMPACT_PERCENT,
  PROJECT_CONTEXT_WINDOW,
} from '../shared/project-context';

export function Login({ onLogin, configured }: { onLogin: () => void; configured: boolean }) {
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <div className="login-page">
      <div className="login-glow" />
      <div className="login-brand">
        <div className="brand-mark">
          <img src={identity.logoUrl} alt="Codex Cloud Logo" />
        </div>
        <strong>{identity.appName}</strong>
        <span>私人工作台</span>
      </div>
      <main className="login-card">
        <div className="login-symbol">
          <img src={identity.avatarUrl} alt="Arran 的头像" />
        </div>
        <div className="eyebrow">欢迎回来，{identity.userName}</div>
        <h1>回到你的工作台</h1>
        <p>
          项目与会话始终在服务器上。
          <br />
          从这里，继续上一次的思路。
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setBusy(true);
            setError('');
            void post('/auth/login', { password, remember })
              .then(onLogin)
              .catch((e) => setError(e.message))
              .finally(() => setBusy(false));
          }}
        >
          <label className="field">
            <span>工作台密码</span>
            <input
              autoFocus
              type="password"
              autoComplete="current-password"
              placeholder="输入你的访问密码"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </label>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
            />
            记住此设备
          </label>
          {!configured && (
            <div className="notice">
              首次使用：请在服务器运行 <code>npm run password</code> 设置密码。
            </div>
          )}
          {error && (
            <div className="error-box" role="alert">
              {error}
            </div>
          )}
          <button className="primary login-submit" disabled={busy || !configured}>
            {busy ? (
              <Spinner label="正在验证" />
            ) : (
              <>
                进入工作台
                <ArrowUpRight size={17} />
              </>
            )}
          </button>
        </form>
        <div className="login-foot">
          <Shield size={13} />
          仅属于你的私人空间
        </div>
      </main>
      <footer>
        Codex Cloud <span>·</span> 在任何地方，继续创造。
      </footer>
    </div>
  );
}

export function ProjectModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (project: Project) => void;
}) {
  const [name, setName] = useState('');
  const [contextWindow1M, setContextWindow1M] = useState(false);
  const [autoCompactPercent, setAutoCompactPercent] = useState(DEFAULT_AUTO_COMPACT_PERCENT);
  const autoCompactTokens = (PROJECT_CONTEXT_WINDOW * autoCompactPercent) / 100;
  const [path, setPath] = useState('');
  const [roots, setRoots] = useState<string[]>([]);
  const [root, setRoot] = useState('');
  const [child, setChild] = useState('');
  const [rootLoading, setRootLoading] = useState(true);
  const [listing, setListing] = useState<{
    path: string;
    parent: string | null;
    entries: { name: string; path: string }[];
  } | null>(null);
  const [browseLoading, setBrowseLoading] = useState(false);
  const [browseError, setBrowseError] = useState('');
  const browsePath = root || path;
  useEffect(() => {
    let disposed = false;
    setListing(null);
    setBrowseError('');
    if (!browsePath) return;
    setBrowseLoading(true);
    void api<NonNullable<typeof listing>>(
      `/project-directories?path=${encodeURIComponent(browsePath)}`,
    )
      .then((result) => {
        if (!disposed) setListing(result);
      })
      .catch((error: Error) => {
        if (!disposed) setBrowseError(error.message);
      })
      .finally(() => {
        if (!disposed) setBrowseLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, [browsePath]);
  const selectDirectory = (value: string) => {
    setRoot(value);
    setPath(value);
    setChild('');
    setCreate(false);
    setError('');
  };
  useEffect(() => {
    let disposed = false;
    void api<RuntimeStatus & { settings: SettingsInfo }>('/status')
      .then((result) => {
        if (disposed) return;
        setRoots(result.settings.projectRoots.length ? result.settings.projectRoots : ['/']);
        selectDirectory(result.settings.projectRoots[0] || '/');
      })
      .catch((e: Error) => {
        if (!disposed) setError(e.message);
      })
      .finally(() => {
        if (!disposed) setRootLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, []);
  const [create, setCreate] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <Modal title="添加项目" onClose={onClose}>
      <p className="muted">连接服务器上的项目目录。Codex 将在这个目录中工作。</p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          let directory = path.trim();
          try {
            if (root) directory = projectDirectory(root, child);
          } catch (e) {
            setError((e as Error).message);
            return;
          }
          setBusy(true);
          setError('');
          void post<Project>('/projects', {
            name,
            path: directory,
            create: root && !child.trim() ? false : create,
            contextWindow1M,
            autoCompactPercent,
          })
            .then(onCreated)
            .catch((e) => setError(e.message))
            .finally(() => setBusy(false));
        }}
      >
        <section className="project-context-options" aria-label="项目上下文设置">
          <label className="checkbox">
            <input
              type="checkbox"
              checked={contextWindow1M}
              disabled={busy}
              aria-describedby="project-context-hint"
              onChange={(e) => setContextWindow1M(e.target.checked)}
            />
            启用 1M 上下文
          </label>
          <p id="project-context-hint" className="muted">
            仅对本项目生效，需模型及供应商支持 1M 上下文。
          </p>
          <div className="project-context-threshold">
            <div className="project-context-heading">
              <label htmlFor="project-auto-compact">自动压缩阈值</label>
              <output htmlFor="project-auto-compact" aria-live="polite">
                {autoCompactPercent}%
                {contextWindow1M
                  ? ` · ${autoCompactTokens.toLocaleString('en-US')} Token`
                  : ' · 当前模型窗口'}
              </output>
            </div>
            <input
              id="project-auto-compact"
              type="range"
              min={50}
              max={90}
              step={10}
              value={autoCompactPercent}
              aria-valuetext={
                contextWindow1M
                  ? `${autoCompactPercent}%，${autoCompactTokens.toLocaleString('en-US')} Token`
                  : `${autoCompactPercent}%，当前模型可用上下文`
              }
              disabled={busy}
              onChange={(e) => setAutoCompactPercent(Number(e.target.value))}
            />
            <div className="project-context-ticks" aria-hidden="true">
              {AUTO_COMPACT_PERCENTAGES.map((percent) => (
                <span key={percent}>{percent}%</span>
              ))}
            </div>
          </div>
          <p className="muted">
            无需启用 1M；每轮结束时按模型可用上下文检查比例并自动压缩。CLI 原有压缩保护仍生效。
          </p>
        </section>
        <label className="field">
          <span>项目名称</span>
          <input
            autoFocus
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="我的项目"
          />
        </label>
        {rootLoading ? (
          <p className="muted">正在读取项目根目录…</p>
        ) : root ? (
          <>
            <label className="field">
              <span>项目根目录</span>
              <select
                aria-label="项目根目录"
                value={root}
                disabled={browseLoading}
                onChange={(e) => selectDirectory(e.target.value)}
              >
                {[
                  ...new Set([
                    root,
                    ...(listing?.parent ? [listing.parent] : []),
                    ...(listing?.entries.map((entry) => entry.path) || []),
                    ...roots,
                  ]),
                ].map((value) => (
                  <option key={value} value={value}>
                    {value}
                    {value === listing?.parent ? '（上级目录）' : ''}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>子目录（留空使用根目录）</span>
              <div className="directory-input">
                <code title={root}>{root.replace(/[\\/]+$/, '')}/</code>
                <input
                  aria-label="子目录（留空使用根目录）"
                  value={child}
                  onChange={(e) => {
                    setChild(e.target.value);
                    setError('');
                    if (!e.target.value.trim()) setCreate(false);
                  }}
                  placeholder="例如 my-app 或课程/my-app"
                />
              </div>
            </label>
            <p className="small muted">
              下拉框列出服务器当前目录下的现有文件夹，选择后可继续选择下一级。已有目录直接添加；新项目可填写子目录并勾选“创建新目录”。
            </p>
          </>
        ) : (
          <label className="field">
            <span>服务器绝对路径</span>
            <input
              aria-label="服务器绝对路径"
              required
              value={path}
              onChange={(e) => {
                setPath(e.target.value);
                setError('');
              }}
              placeholder="例如 /srv/projects/my-app"
            />
          </label>
        )}
        {!rootLoading && (
          <div className="project-browser">
            <div className="project-browser-actions">
              <button
                type="button"
                className="secondary"
                disabled={!listing?.parent || browseLoading}
                onClick={() => listing?.parent && selectDirectory(listing.parent)}
              >
                <ArrowLeft size={14} /> 返回上级
              </button>
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  setPath(root || path);
                  setRoot('');
                  setChild('');
                  setCreate(false);
                }}
              >
                直接输入路径
              </button>
            </div>
            <p className="small muted">
              点击文件夹逐级进入；可在当前目录下输入多级子目录并勾选创建。
            </p>
            {browseLoading && (
              <p className="muted" role="status">
                正在读取目录…
              </p>
            )}
            {browseError && (
              <p className="small muted" role="status">
                无法浏览此路径：{browseError}
              </p>
            )}
            {listing && (
              <div className="project-directory-list" aria-label="服务器目录">
                {listing.entries.length ? (
                  listing.entries.map((entry) => (
                    <button
                      key={entry.path}
                      type="button"
                      onClick={() => selectDirectory(entry.path)}
                    >
                      <Folder size={16} />
                      <span>{entry.name}</span>
                      <ChevronRight size={14} />
                    </button>
                  ))
                ) : (
                  <p className="small muted">此目录没有子文件夹</p>
                )}
              </div>
            )}
          </div>
        )}
        <label className="checkbox">
          <input
            type="checkbox"
            disabled={rootLoading || (!!root && !child.trim())}
            checked={create}
            onChange={(e) => setCreate(e.target.checked)}
          />
          创建新目录（支持自动创建多级父目录）
        </label>
        {error && <p className="error-box">{error}</p>}
        <div className="modal-actions">
          <button type="button" className="secondary" onClick={onClose}>
            取消
          </button>
          <button className="primary" disabled={busy || rootLoading}>
            {busy ? '正在添加…' : '添加项目'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
