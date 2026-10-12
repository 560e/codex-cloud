import { useEffect, useState } from 'react';
import { api } from '../api';
import type { Project } from '../../shared/types';
export function ProjectPrompts() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selected, setSelected] = useState('');
  const [prompt, setPrompt] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void api<Project[]>('/projects')
      .then((items) => {
        setProjects(items);
        setSelected(items[0]?.id || '');
        setPrompt(items[0]?.systemPrompt || '');
      })
      .catch((e) => setMessage(e.message));
  }, []);
  return (
    <section className="settings-section" aria-label="项目系统提示词">
      <h3>项目系统提示词</h3>
      <p className="muted small">
        每个项目独立保存。新会话立即使用，已有会话从下一次发送开始使用；留空取消项目提示词。
      </p>
      {!projects.length ? (
        <p>请先添加项目。</p>
      ) : (
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            setBusy(true);
            setMessage('');
            try {
              await api(`/projects/${encodeURIComponent(selected)}/prompt`, {
                method: 'PUT',
                body: JSON.stringify({ systemPrompt: prompt }),
              });
              setProjects((items) =>
                items.map((item) =>
                  item.id === selected ? { ...item, systemPrompt: prompt } : item,
                ),
              );
              setMessage('项目提示词已保存');
            } catch (e) {
              setMessage((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <label className="field">
            <span>项目</span>
            <select
              aria-label="提示词项目"
              value={selected}
              disabled={busy}
              onChange={(e) => {
                setSelected(e.target.value);
                setPrompt(projects.find((item) => item.id === e.target.value)?.systemPrompt || '');
                setMessage('');
              }}
            >
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>系统提示词</span>
            <textarea
              aria-label="项目系统提示词内容"
              rows={6}
              maxLength={50000}
              value={prompt}
              disabled={busy}
              placeholder="例如：回答使用中文；遵循项目代码风格；修改后运行相关检查。"
              onChange={(e) => setPrompt(e.target.value)}
            />
          </label>
          <button className="primary" disabled={busy}>
            {busy ? '保存中…' : '保存项目提示词'}
          </button>
        </form>
      )}
      {message && <p role="status">{message}</p>}
    </section>
  );
}
