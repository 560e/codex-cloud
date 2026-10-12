import { useState } from 'react';
import { post } from '../api';
import { LockKeyhole } from 'lucide-react';
export function AccountSettings({ onLogout }: { onLogout: () => void }) {
  const [current, setCurrent] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <>
      <section className="settings-section">
        <h3>登录</h3>
        <button
          className="secondary"
          onClick={() =>
            void post('/auth/logout')
              .then(onLogout)
              .catch((e) => setError(e.message))
          }
        >
          退出登录
        </button>
      </section>
      <div className="settings-section">
        <h3>
          <LockKeyhole size={16} />
          修改访问密码
        </h3>
        <p className="muted small">修改后所有设备退出登录，正在执行的任务继续运行。</p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (password !== confirm) {
              setError('两次输入的密码不一致');
              return;
            }
            setBusy(true);
            void post('/auth/password', { current, password })
              .then(onLogout)
              .catch((e) => setError(e.message))
              .finally(() => setBusy(false));
          }}
        >
          <label className="field">
            <span>当前密码</span>
            <input
              type="password"
              autoComplete="current-password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              required
            />
          </label>
          <label className="field">
            <span>新密码（至少 8 位）</span>
            <input
              type="password"
              autoComplete="new-password"
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </label>
          <label className="field">
            <span>确认新密码</span>
            <input
              type="password"
              autoComplete="new-password"
              minLength={8}
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              required
            />
          </label>
          <button className="primary" disabled={busy}>
            更新密码
          </button>
        </form>
      </div>
      {error && (
        <div role="alert" className="error-box">
          {error}
        </div>
      )}
    </>
  );
}
