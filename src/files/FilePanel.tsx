import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  Check,
  ChevronRight,
  Download,
  File,
  Folder,
  FolderOpen,
  RefreshCw,
  X,
  Image as ImageIcon,
} from 'lucide-react';
import { api } from '../api';
import { Diff, MessageItem, Spinner } from '../components';
import { CodeBlock, Select } from '../controls';
import type { GitChanges, Thread, FilePage } from '../../shared/types';
import type { ResolvedFileLink } from '../../shared/file-links';
import { imageMime } from '../../shared/image-preview';
import { ImagePreview } from './ImagePreview';
import { HtmlPreview } from './HtmlPreview';
type Entry = { name: string; path: string; directory: boolean };
function FileSource({
  content,
  file,
  line,
  column,
}: {
  content: string;
  file: string;
  line?: number;
  column?: number;
}) {
  const mark = useRef<HTMLSpanElement>(null);
  const position = useMemo(() => {
    if (!line) return null;
    let start = 0;
    for (let n = 1; n < line; n++) {
      const next = content.indexOf('\n', start);
      if (next < 0) return null;
      start = next + 1;
    }
    const end = content.indexOf('\n', start);
    const last = end < 0 ? content.length : end;
    return { start, end: last, column: Math.min(column || 1, last - start + 1) };
  }, [content, line, column]);
  useEffect(() => {
    mark.current?.scrollIntoView({ block: 'center', inline: 'nearest' });
  }, [content, line, column]);
  return (
    <>
      {line && (
        <p className="muted small" role="status">
          {position
            ? `已定位第 ${line} 行${column ? `（第 ${position.column} 列）` : ''}`
            : `文件不足 ${line} 行，已打开文件`}
        </p>
      )}
      <CodeBlock
        preClassName="source-preview"
        text={content}
        language={file.split('.').at(-1) || 'text'}
      >
        {position && (
          <code>
            {content.slice(0, position.start)}
            <mark className="source-line-target" data-line={line}>
              {content.slice(position.start, position.start + position.column - 1)}
              <span ref={mark}>
                {content.slice(
                  position.start + position.column - 1,
                  Math.min(position.start + position.column, position.end),
                ) || '\u200b'}
              </span>
              {content.slice(
                Math.min(position.start + position.column, position.end),
                position.end,
              )}
            </mark>
            {content.slice(position.end)}
          </code>
        )}
      </CodeBlock>
    </>
  );
}
export function FilePanel({
  thread,
  threadId,
  projectId,
  onClose,
  target,
}: {
  thread?: Thread | null;
  threadId?: string;
  projectId?: string;
  onClose: () => void;
  target?: { href: string; id: number };
}) {
  const [tab, setTab] = useState<'files' | 'diff'>('files');
  const [directory, setDirectory] = useState('');
  const [entries, setEntries] = useState<Entry[]>([]);
  const [offset, setOffset] = useState(0);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [totalFiles, setTotalFiles] = useState(0);
  const [file, setFile] = useState<string | null>(null);
  const [content, setContent] = useState('');
  const [htmlMode, setHtmlMode] = useState<'preview' | 'source'>('preview');
  const htmlFile = !!file && /\.html?$/i.test(file);
  const [diff, setDiff] = useState<GitChanges | null>(null);
  const [changeTurnId, setChangeTurnId] = useState('');
  const changes = useMemo(
    () =>
      (thread?.id === threadId ? thread?.turns || [] : [])
        .filter(
          (turn) =>
            turn.diff?.trim() ||
            turn.items.some((item) => item.type === 'fileChange' && item.changes?.length),
        )
        .slice()
        .reverse(),
    [thread?.turns, thread?.id, threadId],
  );
  const changeTurn = changes.find((turn) => turn.id === changeTurnId) || changes[0];
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [opening, setOpening] = useState(Boolean(target));
  const [linkError, setLinkError] = useState('');
  const [location, setLocation] = useState<{ line?: number; column?: number }>({});
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    setHtmlMode(location.line ? 'source' : 'preview');
  }, [file, location.line, location.column]);
  const base = threadId
    ? `thread=${encodeURIComponent(threadId)}`
    : `project=${encodeURIComponent(projectId || '')}`;
  useEffect(() => {
    setOffset(0);
  }, [base, tab, directory, file, revision]);
  useEffect(() => {
    setDirectory('');
    setFile(null);
  }, [threadId, projectId]);
  useEffect(() => {
    if (!target) return;
    const controller = new AbortController();
    setOpening(true);
    setLinkError('');
    void api<ResolvedFileLink>(`/file-link?${base}&target=${encodeURIComponent(target.href)}`, {
      signal: controller.signal,
    })
      .then((result) => {
        if (controller.signal.aborted) return;
        setTab('files');
        setDirectory(
          result.directory ? result.path : result.path.split('/').slice(0, -1).join('/'),
        );
        setFile(result.directory ? null : result.path);
        setLocation({ line: result.line, column: result.column });
      })
      .catch((e: Error) => {
        if (!controller.signal.aborted) setLinkError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setOpening(false);
      });
    return () => controller.abort();
  }, [base, target]);
  useEffect(() => {
    if (opening || linkError) return;
    let live = true;
    const controller = new AbortController();
    setBusy(true);
    setError('');
    if (tab === 'files' && file && (imageMime(file) || (htmlFile && htmlMode === 'preview'))) {
      setBusy(false);
      return () => controller.abort();
    }
    const mode = tab === 'diff' ? 'diff' : file ? 'read' : 'list';
    void api<FilePage | GitChanges | { content: string; size: number }>(
      `/files?${base}&mode=${mode}&path=${encodeURIComponent(file || directory)}&offset=${offset}`,
      {
        signal: controller.signal,
      },
    )
      .then((r) => {
        if (!live) return;
        if ('kind' in r) setDiff(r);
        else if ('content' in r) setContent(r.content);
        else {
          setEntries((old) =>
            offset
              ? [
                  ...old,
                  ...r.entries.filter((entry: Entry) => !old.some((e) => e.path === entry.path)),
                ]
              : r.entries,
          );
          setNextOffset(r.nextOffset);
          setTotalFiles(r.total);
        }
      })
      .catch((e) => {
        if (live) setError(e.message);
      })
      .finally(() => {
        if (live) setBusy(false);
      });
    return () => {
      live = false;
      controller.abort();
    };
  }, [base, tab, directory, file, revision, offset, opening, linkError, htmlFile, htmlMode]);
  return (
    <aside className="file-panel">
      <div className="panel-header">
        <div className="panel-tabs">
          <button className={tab === 'files' ? 'active' : ''} onClick={() => setTab('files')}>
            文件
          </button>
          <button className={tab === 'diff' ? 'active' : ''} onClick={() => setTab('diff')}>
            改动
          </button>
        </div>
        <div className="button-row">
          <button
            className="icon-btn"
            aria-label="刷新文件"
            onClick={() => setRevision((r) => r + 1)}
          >
            <RefreshCw size={15} />
          </button>
          <button className="icon-btn" aria-label="关闭详情" onClick={onClose}>
            <X size={17} />
          </button>
        </div>
      </div>
      <div className="file-panel-content">
        {tab === 'files' && (
          <>
            <div className="file-breadcrumb">
              <button
                className="icon-btn"
                aria-label="上一级"
                onClick={() => {
                  setLocation({});
                  setLinkError('');
                  if (file) setFile(null);
                  else setDirectory(directory.split('/').slice(0, -1).join('/'));
                }}
              >
                <ArrowLeft size={15} />
              </button>
              <span>{file || directory || '项目根目录'}</span>
              {file && (
                <a
                  className="icon-btn"
                  aria-label="下载文件"
                  href={`/api/files?${base}&mode=download&path=${encodeURIComponent(file)}`}
                >
                  <Download size={15} />
                </a>
              )}
            </div>
            {htmlFile && (
              <div className="html-preview-tabs" role="group" aria-label="HTML 查看方式">
                <button
                  className={htmlMode === 'preview' ? 'active' : ''}
                  aria-pressed={htmlMode === 'preview'}
                  onClick={() => setHtmlMode('preview')}
                >
                  预览
                </button>
                <button
                  className={htmlMode === 'source' ? 'active' : ''}
                  aria-pressed={htmlMode === 'source'}
                  onClick={() => setHtmlMode('source')}
                >
                  源码
                </button>
              </div>
            )}
            {!busy &&
              !opening &&
              !linkError &&
              !error &&
              (file ? (
                htmlFile && htmlMode === 'preview' ? (
                  <HtmlPreview key={`${base}:${file}:${revision}`} base={base} file={file} />
                ) : imageMime(file) ? (
                  <ImagePreview
                    key={`${base}:${file}:${revision}`}
                    file={file}
                    src={`/api/files?${base}&mode=preview&path=${encodeURIComponent(file)}&revision=${revision}`}
                  />
                ) : (
                  <FileSource
                    key={file}
                    content={content}
                    file={file}
                    line={location.line}
                    column={location.column}
                  />
                )
              ) : (
                <div className="file-list">
                  {entries.length ? (
                    entries.map((entry) => (
                      <button
                        key={entry.path}
                        onClick={() => {
                          setLocation({});
                          if (entry.directory) setDirectory(entry.path);
                          else setFile(entry.path);
                        }}
                      >
                        {entry.directory ? (
                          <Folder size={16} />
                        ) : imageMime(entry.name) ? (
                          <ImageIcon size={16} />
                        ) : (
                          <File size={16} />
                        )}
                        <span>{entry.name}</span>
                        {entry.directory && <ChevronRight size={13} />}
                      </button>
                    ))
                  ) : (
                    <div className="panel-empty">
                      <FolderOpen size={24} />
                      <p>目录中还没有文件</p>
                    </div>
                  )}
                </div>
              ))}
          </>
        )}
        {tab === 'files' && !file && !busy && !error && totalFiles > 1000 && (
          <div className="small">
            已显示 {entries.length} / {totalFiles} 项
            {nextOffset !== null && (
              <button className="text-button" onClick={() => setOffset(nextOffset)}>
                加载更多文件
              </button>
            )}
          </div>
        )}
        {tab === 'diff' && (
          <section className="conversation-changes">
            <h3>对话中的本地改动</h3>
            <p className="change-source-note">
              Codex 执行时记录的文件差异，无需 Git 或 GitHub。记录不会随之后的手动修改而更新。
            </p>
            {changeTurn ? (
              <>
                <Select
                  label="改动记录"
                  value={
                    changeTurnId && changes.some((turn) => turn.id === changeTurnId)
                      ? changeTurnId
                      : ''
                  }
                  onChange={setChangeTurnId}
                  options={[
                    { value: '', label: '最近有改动的一轮' },
                    ...changes.map((turn, index) => ({
                      value: turn.id,
                      label: `改动记录 ${changes.length - index}${turn.status === 'inProgress' ? ' · 执行中' : turn.status === 'failed' ? ' · 执行失败' : turn.status === 'interrupted' ? ' · 已停止' : ''}`,
                    })),
                  ]}
                />
                {changeTurn.diff?.trim() ? (
                  <Diff key={changeTurn.id} text={changeTurn.diff} />
                ) : (
                  changeTurn.items
                    .filter((item) => item.type === 'fileChange' && item.changes?.length)
                    .map((item) => <MessageItem key={item.id} item={item} />)
                )}
              </>
            ) : (
              <div className="change-empty">
                <p>
                  {threadId
                    ? '当前加载的对话中暂无文件改动记录。'
                    : '打开项目中的一个会话，即可查看其文件改动记录。'}
                </p>
                <p>
                  普通文件夹没有历史版本基线，无法还原未被记录的手动修改。较早的对话记录可在加载历史消息后查看。
                </p>
              </div>
            )}
          </section>
        )}
        {tab === 'diff' && !busy && !error && diff && (
          <section className="workspace-changes">
            <h3>本地工作区</h3>
            {diff.kind !== 'git' ? (
              <p className="change-source-note">{diff.message}</p>
            ) : (
              <>
                <p className="change-source-note">
                  本机 Git 跟踪的当前文件差异，无需绑定 GitHub。刷新可重新读取磁盘状态。
                </p>
                <>
                  {!diff.status ? (
                    <div className="panel-empty">
                      <Check size={24} />
                      <p>本地 Git 工作区没有待提交改动</p>
                    </div>
                  ) : (
                    <>
                      <div className="file-label">Git 状态（包含未跟踪文件）</div>
                      <pre className="git-status">{diff.status}</pre>
                      {diff.unstaged && (
                        <>
                          <div className="file-label">未暂存</div>
                          <Diff text={diff.unstaged} />
                        </>
                      )}
                      {diff.staged && (
                        <>
                          <div className="file-label">已暂存</div>
                          <Diff text={diff.staged} />
                        </>
                      )}
                    </>
                  )}
                </>
              </>
            )}
          </section>
        )}
        {(busy || opening) && (
          <div className="panel-empty">
            <Spinner />
          </div>
        )}
        {(linkError || error) && (
          <div className="error-box" role="alert">
            {linkError || error}
          </div>
        )}
      </div>
    </aside>
  );
}
