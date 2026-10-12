import { useEffect, useState } from 'react';
import { api, post } from './api';
import { Modal } from './components';
import { Select } from './controls';
import type { ReviewTarget } from '../shared/protocol';

export function NativeTaskDialog({
  threadId,
  type,
  onClose,
  onStarted,
}: {
  threadId: string;
  type: 'review' | 'compact';
  onClose: () => void;
  onStarted: () => void;
}) {
  const [targetType, setTargetType] = useState('uncommittedChanges');
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <Modal
      title={type === 'review' ? '原生代码审查' : '压缩会话上下文'}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          let target: ReviewTarget = { type: 'uncommittedChanges' };
          if (targetType === 'baseBranch') target = { type: 'baseBranch', branch: value.trim() };
          if (targetType === 'commit') target = { type: 'commit', sha: value.trim(), title: null };
          if (targetType === 'custom') target = { type: 'custom', instructions: value.trim() };
          setBusy(true);
          setError('');
          void post(
            `/threads/${threadId}/native-task`,
            type === 'review' ? { type, target } : { type },
          )
            .then(() => {
              onStarted();
              onClose();
            })
            .catch((e: Error) => setError(e.message))
            .finally(() => setBusy(false));
        }}
      >
        {type === 'review' ? (
          <>
            <p className="muted">
              在当前会话中启动代码审查，结果保留在历史中。会调用当前供应商模型，可使用现有审批和停止按钮。
            </p>
            <Select
              label="审查范围"
              value={targetType}
              onChange={(value) => {
                setTargetType(value);
                setValue('');
              }}
              options={[
                { value: 'uncommittedChanges', label: '未提交的修改' },
                { value: 'baseBranch', label: '相对某个分支的修改' },
                { value: 'commit', label: '指定提交' },
                { value: 'custom', label: '自定义审查要求' },
              ]}
            />
            {targetType !== 'uncommittedChanges' && (
              <label className="field">
                <span>
                  {targetType === 'baseBranch'
                    ? '基准分支'
                    : targetType === 'commit'
                      ? '提交 SHA'
                      : '审查要求'}
                </span>
                <textarea
                  required
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  rows={targetType === 'custom' ? 4 : 2}
                  maxLength={targetType === 'custom' ? 10000 : 200}
                />
              </label>
            )}
            <p className="muted small">
              修改、分支和提交审查需要 Git 项目；普通目录可选择自定义审查要求。
            </p>
          </>
        ) : (
          <p>
            Codex
            将整理当前会话的模型上下文，历史消息仍保留。压缩会调用模型，完成前占用当前项目的执行名额；后续消息可排队等待。
          </p>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <button type="button" className="secondary" disabled={busy} onClick={onClose}>
            取消
          </button>
          <button className="primary" disabled={busy}>
            {busy ? '正在提交…' : type === 'review' ? '开始审查' : '开始压缩'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function FileReferencePicker({
  threadId,
  projectId,
  selected,
  onSelect,
  onClose,
}: {
  threadId: string | null;
  projectId: string;
  selected: string[];
  onSelect: (path: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [files, setFiles] = useState<{ path: string; name: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    setFiles([]);
    setError('');
    setBusy(Boolean(query.trim()));
    if (!query.trim()) return () => controller.abort();
    const timer = setTimeout(() => {
      const params = new URLSearchParams({
        query: query.trim(),
        ...(threadId ? { thread: threadId } : { project: projectId }),
      });
      void api<{ files: { path: string; name: string }[] }>(`/file-search?${params}`, {
        signal: controller.signal,
      })
        .then((result) => {
          if (!controller.signal.aborted) setFiles(result.files);
        })
        .catch((e: Error) => {
          if (!controller.signal.aborted) setError(e.message);
        })
        .finally(() => {
          if (!controller.signal.aborted) setBusy(false);
        });
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, threadId, projectId]);
  return (
    <Modal title="引用项目文件" onClose={onClose}>
      <label className="field">
        <span>搜索文件名或路径</span>
        <input autoFocus value={query} maxLength={200} onChange={(e) => setQuery(e.target.value)} />
      </label>
      <p className="muted small">
        搜索当前项目，最多展示 50 个结果。选择后按需读取文件；不复制文件内容，最多引用 10 个文件。
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <p role="status">
        {busy
          ? '正在搜索…'
          : !query.trim()
            ? '输入文件名开始搜索'
            : !error && !files.length
              ? '没有匹配的文件'
              : `已选 ${selected.length} / 10`}
      </p>
      <div className="file-reference-results">
        {files.map((file) => (
          <button
            key={file.path}
            className="secondary"
            disabled={selected.includes(file.path) || selected.length >= 10}
            onClick={() => onSelect(file.path)}
          >
            <span>{file.path}</span>
            {selected.includes(file.path) && <small>已引用</small>}
          </button>
        ))}
      </div>
      <div className="modal-actions">
        <button className="primary" onClick={onClose}>
          完成
        </button>
      </div>
    </Modal>
  );
}
