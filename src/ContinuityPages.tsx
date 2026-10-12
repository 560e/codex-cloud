import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Menu, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { api, post } from './api';
import type { Project, Thread, ThreadPage } from '../shared/types';
import { shortThreadId } from './thread-id';

type Memory = {
  id: string;
  projectId: string | null;
  content: string;
  sourceThreadId: string | null;
  enabled: number;
  updatedAt: number;
};
type Member = { threadId: string; instruction: string; nextThreadId?: string };
type Group = { id: string; name: string; goal: string; members: Member[]; maxSteps: number };
type Run = {
  id: string;
  status: string;
  stepIndex: number;
  stepsDone: number;
  currentThreadId: string | null;
  error: string | null;
  updatedAt: number;
};
type Handoff = {
  id: string;
  source_thread_id: string;
  target_thread_id: string | null;
  content: string;
  step_index: number;
};
const runStatus = (status: string) =>
  ({
    ready: '等待执行',
    starting: '正在提交',
    running: '运行中',
    paused: '已暂停',
    stopping: '正在停止',
    completed: '已完成',
    cancelled: '已结束',
  })[status] || status;

export function MemoryPage({
  projects,
  defaultProjectId,
  sourceThreadId,
  initialText,
  onSaved,
  onSettings,
  onMenu,
  revision,
}: {
  projects: Project[];
  defaultProjectId?: string;
  sourceThreadId?: string;
  initialText: string;
  onSaved: () => void;
  onSettings: () => void;
  onMenu: () => void;
  revision: number;
}) {
  const [items, setItems] = useState<Memory[]>([]);
  const [scope, setScope] = useState(defaultProjectId || projects[0]?.id || 'global');
  const [scopeTouched, setScopeTouched] = useState(false);
  const [content, setContent] = useState(initialText);
  const [search, setSearch] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const memoryRequest = useRef(0);
  const load = useCallback(async () => {
    const request = ++memoryRequest.current;
    try {
      const result = await api<Memory[]>('/memories');
      if (request === memoryRequest.current) setItems(result);
    } catch (e) {
      if (request === memoryRequest.current) setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load, revision]);
  useEffect(() => {
    if (initialText) {
      setContent(initialText);
      if (defaultProjectId) setScope(defaultProjectId);
    }
  }, [initialText, defaultProjectId]);
  useEffect(() => {
    if (!scopeTouched && (defaultProjectId || projects[0]?.id))
      setScope(defaultProjectId || projects[0].id);
  }, [defaultProjectId, projects, scopeTouched]);
  const visible = items.filter(
    (item) =>
      (scope === 'all' ||
        (scope === 'global' ? item.projectId === null : item.projectId === scope)) &&
      item.content.toLowerCase().includes(search.trim().toLowerCase()),
  );
  const save = async () => {
    if (!content.trim()) return;
    setBusy(true);
    setError('');
    try {
      if (editing)
        await api(`/memories/${editing}`, {
          method: 'PATCH',
          body: JSON.stringify({ content, projectId: scope === 'global' ? null : scope }),
        });
      else
        await post('/memories', {
          projectId: scope === 'all' || scope === 'global' ? null : scope,
          content,
          sourceThreadId: initialText ? sourceThreadId : undefined,
        });
      setContent('');
      setEditing(null);
      onSaved();
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="continuity-page" aria-label="记忆库">
      <header className="continuity-heading">
        <button className="icon-btn mobile-only" aria-label="打开侧栏" onClick={onMenu}>
          <Menu size={19} />
        </button>
        <div>
          <span className="muted">工作台 / 记忆库</span>
          <h1>记忆库</h1>
          <p>保存以后对话需要用到的内容，并控制它的使用范围。</p>
        </div>
        <button className="secondary" onClick={onSettings}>
          功能设置
        </button>
      </header>
      <div className="continuity-layout">
        <section className="continuity-card">
          <h2>{editing ? '编辑记忆' : '新增记忆'}</h2>
          <label className="field">
            <span>使用范围</span>
            <select
              value={scope}
              onChange={(e) => {
                setScopeTouched(true);
                setScope(e.target.value);
              }}
            >
              <option value="global">跨项目</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>记忆内容</span>
            <textarea
              rows={7}
              maxLength={4000}
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="例如：讨论活动方案时，优先考虑初次参加者的体验。"
            />
          </label>
          <div className="continuity-actions">
            <button
              className="primary"
              disabled={busy || !content.trim()}
              onClick={() => void save()}
            >
              {busy ? '保存中…' : editing ? '保存修改' : '保存记忆'}
            </button>
            {editing && (
              <button
                className="secondary"
                onClick={() => {
                  setEditing(null);
                  setContent('');
                }}
              >
                取消编辑
              </button>
            )}
          </div>
          <p className="muted small">跨项目记忆只会在你开启记忆功能后供各项目使用。</p>
        </section>
        <section className="continuity-card">
          <div className="continuity-section-head">
            <h2>已保存的记忆</h2>
            <button className="icon-btn" aria-label="刷新记忆" onClick={() => void load()}>
              <RefreshCw size={16} />
            </button>
          </div>
          <input
            className="continuity-search"
            aria-label="搜索记忆"
            placeholder="搜索记忆内容"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {!visible.length && <p className="muted">当前范围没有匹配的记忆。</p>}
          <div className="continuity-list">
            {visible.map((item) => (
              <article key={item.id} className="continuity-item">
                <div className="continuity-item-top">
                  <strong>
                    {item.projectId
                      ? projects.find((p) => p.id === item.projectId)?.name || '已移除项目'
                      : '跨项目'}
                  </strong>
                  <span className="muted">{item.enabled ? '使用中' : '已停用'}</span>
                </div>
                <p>{item.content}</p>
                <div className="continuity-actions">
                  <button
                    className="secondary"
                    onClick={() => {
                      setScopeTouched(true);
                      setEditing(item.id);
                      setContent(item.content);
                      setScope(item.projectId || 'global');
                    }}
                  >
                    编辑
                  </button>
                  <button
                    className="secondary"
                    onClick={async () => {
                      try {
                        await api(`/memories/${item.id}`, {
                          method: 'PATCH',
                          body: JSON.stringify({ enabled: !item.enabled }),
                        });
                        await load();
                      } catch (e) {
                        setError((e as Error).message);
                      }
                    }}
                  >
                    {item.enabled ? '停用' : '启用'}
                  </button>
                  <button
                    className="secondary"
                    onClick={async () => {
                      if (!window.confirm('删除这条记忆？')) return;
                      try {
                        await api(`/memories/${item.id}`, { method: 'DELETE' });
                        await load();
                      } catch (e) {
                        setError((e as Error).message);
                      }
                    }}
                  >
                    删除
                  </button>
                </div>
              </article>
            ))}
          </div>
        </section>
      </div>
      {error && (
        <p className="error-box" role="alert">
          {error}
        </p>
      )}
    </main>
  );
}

export function CollaborationPage({
  initialThreadId,
  onSettings,
  onMenu,
  revision,
}: {
  initialThreadId?: string | null;
  onSettings: () => void;
  onMenu: () => void;
  revision: number;
}) {
  const [threads, setThreads] = useState<Thread[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [selected, setSelected] = useState('');
  const [name, setName] = useState('');
  const [goal, setGoal] = useState('');
  const [members, setMembers] = useState<Member[]>([
    { threadId: initialThreadId || '', instruction: '' },
    { threadId: '', instruction: '' },
  ]);
  const [maxSteps, setMaxSteps] = useState(4);
  const [prompt, setPrompt] = useState('');
  const [runs, setRuns] = useState<Run[]>([]);
  const [runId, setRunId] = useState('');
  const [handoffs, setHandoffs] = useState<Handoff[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const loadGroups = useCallback(
    () =>
      api<Group[]>('/collaborations')
        .then(setGroups)
        .catch((e) => setError(e.message)),
    [],
  );
  useEffect(() => {
    void loadGroups();
  }, [loadGroups, revision]);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const collected: Thread[] = [];
        let cursor: string | null = null;
        for (let page = 0; page < 10; page++) {
          const result: ThreadPage = await api<ThreadPage>(
            `/threads${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
          );
          collected.push(...result.data);
          cursor = result.nextCursor || null;
          if (!cursor) break;
        }
        if (!cancelled) setThreads(collected);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    void api<Run[]>(`/collaborations/${selected}/runs`)
      .then((items) => {
        if (cancelled) return;
        setRuns(items);
        setRunId((old) => old || items[0]?.id || '');
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [selected, revision]);
  useEffect(() => {
    if (!runId) {
      setHandoffs([]);
      return;
    }
    let cancelled = false;
    void api<Handoff[]>(`/collaboration-runs/${runId}/handoffs`)
      .then((items) => {
        if (!cancelled) setHandoffs(items);
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [runId, revision]);
  const selectGroup = (group: Group | null) => {
    setSelected(group?.id || '');
    setName(group?.name || '');
    setGoal(group?.goal || '');
    setMembers(
      group?.members || [
        { threadId: '', instruction: '' },
        { threadId: '', instruction: '' },
      ],
    );
    setMaxSteps(group?.maxSteps || 4);
    setRuns([]);
    setRunId('');
    setHandoffs([]);
    setError('');
  };
  const save = async () => {
    setBusy(true);
    setError('');
    try {
      const group = selected
        ? await api<Group>(`/collaborations/${selected}`, {
            method: 'PUT',
            body: JSON.stringify({ name, goal, members, maxSteps }),
          })
        : await post<Group>('/collaborations', { name, goal, members, maxSteps });
      await loadGroups();
      selectGroup(group);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const updateMember = (index: number, part: Partial<Member>) =>
    setMembers((old) => old.map((item, i) => (i === index ? { ...item, ...part } : item)));
  const run = runs.find((item) => item.id === runId);
  const operate = async (id: string, action: 'pause' | 'resume' | 'stop') => {
    setBusy(true);
    setError('');
    try {
      const updated = await post<Run>(`/collaboration-runs/${id}/actions`, { action });
      setRuns((old) => old.map((item) => (item.id === id ? updated : item)));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="continuity-page" aria-label="会话协作">
      <header className="continuity-heading">
        <button className="icon-btn mobile-only" aria-label="打开侧栏" onClick={onMenu}>
          <Menu size={19} />
        </button>
        <div>
          <span className="muted">工作台 / 协作</span>
          <h1>会话协作</h1>
          <p>选择已有会话，设定交接顺序和每个会话的要求。</p>
        </div>
        <button className="secondary" onClick={onSettings}>
          功能设置
        </button>
      </header>
      <div className="continuity-layout collaboration-layout">
        <aside className="continuity-card collaboration-groups">
          <div className="continuity-section-head">
            <h2>协作组</h2>
            <button className="secondary" onClick={() => selectGroup(null)}>
              <Plus size={15} /> 新建
            </button>
          </div>
          {groups.map((group) => (
            <button
              key={group.id}
              className={`collaboration-group ${selected === group.id ? 'active' : ''}`}
              onClick={() => selectGroup(group)}
            >
              <strong>{group.name}</strong>
              <small>
                {group.members.length} 个会话 · 最多 {group.maxSteps} 步
              </small>
            </button>
          ))}
          {!groups.length && <p className="muted">还没有协作组。选择两个会话即可开始。</p>}
        </aside>
        <div className="continuity-stack">
          <section className="continuity-card">
            <h2>{selected ? '编辑协作组' : '新建协作组'}</h2>
            <label className="field">
              <span>名称</span>
              <input
                maxLength={120}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="例如：方案讨论"
              />
            </label>
            <label className="field">
              <span>共同目标</span>
              <textarea
                rows={3}
                maxLength={8000}
                value={goal}
                onChange={(e) => setGoal(e.target.value)}
                placeholder="描述这些会话共同要完成什么"
              />
            </label>
            <h3>交接顺序</h3>
            <p className="muted small">
              默认按列表依次交接；也可为每个会话指定下一位。达到步数上限后结束。
            </p>
            {members.map((member, index) => (
              <div className="collaboration-member" key={index}>
                <div className="continuity-section-head">
                  <strong>第 {index + 1} 位会话</strong>
                  <div className="continuity-actions">
                    <button
                      className="icon-btn"
                      aria-label={`上移第 ${index + 1} 位会话`}
                      disabled={index === 0}
                      onClick={() =>
                        setMembers((old) => {
                          const next = [...old];
                          [next[index - 1], next[index]] = [next[index], next[index - 1]];
                          return next;
                        })
                      }
                    >
                      <ArrowUp size={15} />
                    </button>
                    <button
                      className="icon-btn"
                      aria-label={`下移第 ${index + 1} 位会话`}
                      disabled={index === members.length - 1}
                      onClick={() =>
                        setMembers((old) => {
                          const next = [...old];
                          [next[index + 1], next[index]] = [next[index], next[index + 1]];
                          return next;
                        })
                      }
                    >
                      <ArrowDown size={15} />
                    </button>
                    <button
                      className="icon-btn"
                      aria-label={`移除第 ${index + 1} 位会话`}
                      disabled={members.length <= 2}
                      onClick={() => setMembers((old) => old.filter((_, i) => i !== index))}
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                </div>
                <label className="field">
                  <span>会话</span>
                  <select
                    value={member.threadId}
                    onChange={(e) => updateMember(index, { threadId: e.target.value })}
                  >
                    <option value="">选择会话</option>
                    {threads.map((thread) => (
                      <option key={thread.id} value={thread.id}>
                        {shortThreadId(thread.id)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>本会话的要求（可选）</span>
                  <textarea
                    rows={2}
                    maxLength={4000}
                    value={member.instruction}
                    onChange={(e) => updateMember(index, { instruction: e.target.value })}
                    placeholder="例如：提出不同看法，并给出理由"
                  />
                </label>
                <label className="field">
                  <span>下一位会话</span>
                  <select
                    value={member.nextThreadId || ''}
                    onChange={(e) =>
                      updateMember(index, { nextThreadId: e.target.value || undefined })
                    }
                  >
                    <option value="">按列表顺序</option>
                    {members
                      .filter((other) => other.threadId)
                      .map((other, otherIndex) => (
                        <option key={`${other.threadId}-${otherIndex}`} value={other.threadId}>
                          第 {members.indexOf(other) + 1} 位 · {shortThreadId(other.threadId)}
                        </option>
                      ))}
                  </select>
                </label>
              </div>
            ))}
            <div className="continuity-actions">
              <button
                className="secondary"
                disabled={members.length >= 8}
                onClick={() => setMembers((old) => [...old, { threadId: '', instruction: '' }])}
              >
                <Plus size={15} /> 添加会话
              </button>
              <label className="collaboration-count">
                最多执行{' '}
                <input
                  type="number"
                  min={2}
                  max={30}
                  value={maxSteps}
                  onChange={(e) => setMaxSteps(Number(e.target.value))}
                />{' '}
                步
              </label>
            </div>
            <div className="continuity-actions">
              <button
                className="primary"
                disabled={busy || !name.trim() || !goal.trim() || members.some((m) => !m.threadId)}
                onClick={() => void save()}
              >
                {busy ? '保存中…' : '保存协作组'}
              </button>
              {selected && (
                <button
                  className="secondary"
                  onClick={async () => {
                    if (!window.confirm('删除这个协作组及其运行记录？')) return;
                    try {
                      await api(`/collaborations/${selected}`, { method: 'DELETE' });
                      selectGroup(null);
                      await loadGroups();
                    } catch (e) {
                      setError((e as Error).message);
                    }
                  }}
                >
                  删除协作组
                </button>
              )}
            </div>
          </section>
          {selected && (
            <section className="continuity-card">
              <h2>运行协作</h2>
              <label className="field">
                <span>本次任务</span>
                <textarea
                  rows={3}
                  maxLength={8000}
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  placeholder="告诉第一个会话这次要讨论或完成什么"
                />
              </label>
              <button
                className="primary"
                disabled={
                  busy ||
                  !prompt.trim() ||
                  runs.some((item) => !['completed', 'cancelled'].includes(item.status))
                }
                onClick={async () => {
                  setBusy(true);
                  setError('');
                  try {
                    const result = await post<Run>(`/collaborations/${selected}/runs`, { prompt });
                    setPrompt('');
                    setRunId(result.id);
                    setRuns((old) => [result, ...old]);
                  } catch (e) {
                    setError((e as Error).message);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                启动协作
              </button>
              {!!runs.length && (
                <>
                  <h3>运行记录</h3>
                  <label className="field">
                    <span>选择运行</span>
                    <select
                      value={runId}
                      onChange={(e) => {
                        setHandoffs([]);
                        setRunId(e.target.value);
                      }}
                    >
                      {runs.map((item) => (
                        <option key={item.id} value={item.id}>
                          {new Date(item.updatedAt).toLocaleString('zh-CN')} ·{' '}
                          {runStatus(item.status)} · {item.stepsDone} 步
                        </option>
                      ))}
                    </select>
                  </label>
                  {run && (
                    <div className="collaboration-run">
                      <p>
                        <strong>状态：{runStatus(run.status)}</strong> · 已执行 {run.stepsDone} 步
                      </p>
                      {run.error && <p className="muted">{run.error}</p>}
                      <div className="continuity-actions">
                        {['ready', 'starting', 'running'].includes(run.status) && (
                          <button
                            className="secondary"
                            disabled={busy}
                            onClick={() => void operate(run.id, 'pause')}
                          >
                            暂停
                          </button>
                        )}
                        {run.status === 'paused' && (
                          <button
                            className="secondary"
                            disabled={busy}
                            onClick={() => void operate(run.id, 'resume')}
                          >
                            继续
                          </button>
                        )}
                        {!['completed', 'cancelled'].includes(run.status) && (
                          <button
                            className="secondary"
                            disabled={busy}
                            onClick={() => void operate(run.id, 'stop')}
                          >
                            结束运行
                          </button>
                        )}
                      </div>
                      {handoffs.map((item) => (
                        <article className="continuity-item" key={item.id}>
                          <strong>第 {item.step_index + 1} 步交接</strong>
                          <p>{item.content}</p>
                          <small className="muted">
                            {threads.find((thread) => thread.id === item.source_thread_id)?.name ||
                              threads.find((thread) => thread.id === item.source_thread_id)
                                ?.preview ||
                              item.source_thread_id}{' '}
                            →{' '}
                            {item.target_thread_id
                              ? threads.find((thread) => thread.id === item.target_thread_id)
                                  ?.name ||
                                threads.find((thread) => thread.id === item.target_thread_id)
                                  ?.preview ||
                                item.target_thread_id
                              : '结束'}
                          </small>
                        </article>
                      ))}
                    </div>
                  )}
                </>
              )}
            </section>
          )}
        </div>
      </div>
      {error && (
        <p className="error-box" role="alert">
          {error}
        </p>
      )}
    </main>
  );
}
