import { useCallback, useEffect, useState } from 'react';
import { ArchiveRestore, ChevronDown, RotateCcw } from 'lucide-react';
import type { Project, Thread, ThreadPage } from '../../shared/types';
import { api, post } from '../api';
import { shortThreadId } from '../thread-id';

type ProjectArchive = {
  project: Project;
  threads: Thread[];
  nextCursor: string | null;
  loading: boolean;
  loadingMore: boolean;
  error?: string;
};

const message = (error: unknown) => (error instanceof Error ? error.message : '请求失败');

function threadTitle(thread: Thread) {
  return thread.name?.trim() || thread.preview?.trim() || '新会话';
}

function updatedAt(value: number) {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(value);
}

export function ArchivedThreads() {
  const [groups, setGroups] = useState<ProjectArchive[]>([]);
  const [loading, setLoading] = useState(true);
  const [pageError, setPageError] = useState('');
  const [restoring, setRestoring] = useState<Set<string>>(() => new Set());

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setPageError('');
    try {
      const projects = await api<Project[]>('/projects', { signal });
      setGroups(
        projects.map((project) => ({
          project,
          threads: [],
          nextCursor: null,
          loading: true,
          loadingMore: false,
        })),
      );
      const pages = await Promise.allSettled(
        projects.map((project) =>
          api<ThreadPage>(`/threads?archived=true&project=${encodeURIComponent(project.id)}`, {
            signal,
          }),
        ),
      );
      if (signal?.aborted) return;
      setGroups(
        projects.map((project, index) => {
          const result = pages[index];
          return result.status === 'fulfilled'
            ? {
                project,
                threads: result.value.data,
                nextCursor: result.value.nextCursor || null,
                loading: false,
                loadingMore: false,
              }
            : {
                project,
                threads: [],
                nextCursor: null,
                loading: false,
                loadingMore: false,
                error: message(result.reason),
              };
        }),
      );
    } catch (error) {
      if (!signal?.aborted) setPageError(message(error));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  async function loadMore(group: ProjectArchive) {
    if (!group.nextCursor || group.loadingMore) return;
    setGroups((current) =>
      current.map((item) =>
        item.project.id === group.project.id
          ? { ...item, loadingMore: true, error: undefined }
          : item,
      ),
    );
    try {
      const page = await api<ThreadPage>(
        `/threads?archived=true&project=${encodeURIComponent(group.project.id)}&cursor=${encodeURIComponent(group.nextCursor)}`,
      );
      setGroups((current) =>
        current.map((item) =>
          item.project.id === group.project.id
            ? {
                ...item,
                threads: [...item.threads, ...page.data],
                nextCursor: page.nextCursor || null,
                loadingMore: false,
              }
            : item,
        ),
      );
    } catch (error) {
      setGroups((current) =>
        current.map((item) =>
          item.project.id === group.project.id
            ? { ...item, loadingMore: false, error: message(error) }
            : item,
        ),
      );
    }
  }

  async function restore(projectId: string, threadId: string) {
    setRestoring((current) => new Set(current).add(threadId));
    setGroups((current) =>
      current.map((item) => (item.project.id === projectId ? { ...item, error: undefined } : item)),
    );
    try {
      await post(`/threads/${encodeURIComponent(threadId)}/action`, { action: 'unarchive' });
      setGroups((current) =>
        current.map((item) =>
          item.project.id === projectId
            ? { ...item, threads: item.threads.filter((thread) => thread.id !== threadId) }
            : item,
        ),
      );
    } catch (error) {
      setGroups((current) =>
        current.map((item) =>
          item.project.id === projectId ? { ...item, error: message(error) } : item,
        ),
      );
    } finally {
      setRestoring((current) => {
        const next = new Set(current);
        next.delete(threadId);
        return next;
      });
    }
  }

  const visible = groups.filter(
    (group) => group.loading || group.threads.length > 0 || group.error || group.nextCursor,
  );

  return (
    <section className="settings-section archived-threads" aria-label="归档会话管理">
      <div className="archived-intro">
        <div>
          <h3>按项目查看归档会话</h3>
          <p className="muted">恢复后，会话会重新出现在对应项目的最近会话中。</p>
        </div>
        <button className="secondary" onClick={() => void load()} disabled={loading}>
          <RotateCcw size={15} />
          {loading ? '正在刷新…' : '刷新'}
        </button>
      </div>
      {pageError && (
        <div className="archived-state error-text" role="alert">
          {pageError}
          <button className="text-button" onClick={() => void load()}>
            重试
          </button>
        </div>
      )}
      {!pageError && loading && groups.length === 0 && (
        <div className="archived-state muted">正在读取归档会话…</div>
      )}
      {!pageError && !loading && visible.length === 0 && (
        <div className="archived-empty">
          <ArchiveRestore size={28} />
          <strong>暂无归档会话</strong>
          <span>从会话菜单归档的内容会按项目显示在这里。</span>
        </div>
      )}
      <div className="archived-projects">
        {visible.map((group) => (
          <details className="archived-project" key={group.project.id} open>
            <summary>
              <ChevronDown size={16} />
              <span>
                <strong>{group.project.name}</strong>
                <small>{group.project.path}</small>
              </span>
              <b>{group.loading ? '…' : `${group.threads.length}${group.nextCursor ? '+' : ''}`}</b>
            </summary>
            {group.error && (
              <div className="archived-group-error error-text" role="alert">
                {group.error}
              </div>
            )}
            <div className="archived-list">
              {group.threads.map((thread) => (
                <article className="archived-thread" key={thread.id}>
                  <div>
                    <strong title={threadTitle(thread)}>{threadTitle(thread)}</strong>
                    <span>更新于 {updatedAt(thread.updatedAt)}</span>
                    <span title={`会话 ID：${thread.id}`}>会话 ID：{shortThreadId(thread.id)}</span>
                  </div>
                  <button
                    className="secondary"
                    disabled={restoring.has(thread.id)}
                    onClick={() => void restore(group.project.id, thread.id)}
                  >
                    <ArchiveRestore size={15} />
                    {restoring.has(thread.id) ? '正在恢复…' : '恢复'}
                  </button>
                </article>
              ))}
              {group.nextCursor && (
                <button
                  className="secondary archived-more"
                  disabled={group.loadingMore}
                  onClick={() => void loadMore(group)}
                >
                  {group.loadingMore ? '正在加载…' : '加载更多'}
                </button>
              )}
            </div>
          </details>
        ))}
      </div>
    </section>
  );
}
