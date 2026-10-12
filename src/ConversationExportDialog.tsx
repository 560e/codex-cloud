import { useEffect, useRef, useState } from 'react';
import { Modal } from './components';

const formats = [
  { value: 'txt', name: 'TXT', description: '纯文本，方便阅读和复制', extension: 'txt' },
  {
    value: 'markdown',
    name: 'Markdown',
    description: '保留 Markdown 内容，方便编辑整理',
    extension: 'md',
  },
  { value: 'html', name: 'HTML', description: '独立网页，可离线打开和打印', extension: 'html' },
] as const;

export function ConversationExportDialog({
  thread,
  onClose,
}: {
  thread: { id: string; title: string };
  onClose: () => void;
}) {
  const [format, setFormat] = useState<(typeof formats)[number]['value']>('markdown');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const close = () => {
    controller.current?.abort();
    onClose();
  };
  return (
    <Modal title="导出当前会话" onClose={close}>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (busy) return;
          setBusy(true);
          setError('');
          const request = new AbortController();
          controller.current = request;
          try {
            const response = await fetch(
              `/api/threads/${encodeURIComponent(thread.id)}/export?format=${format}`,
              {
                credentials: 'same-origin',
                signal: request.signal,
              },
            );
            if (!response.ok) {
              if (response.status === 401) window.dispatchEvent(new Event('session-expired'));
              const result = await response.json().catch(() => null);
              throw new Error(result?.error || `导出失败 (${response.status})`);
            }
            const blob = await response.blob();
            if (request.signal.aborted) return;
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = `conversation-${new Date().toISOString().replace(/[:.]/g, '-')}.${formats.find((f) => f.value === format)!.extension}`;
            document.body.append(link);
            link.click();
            link.remove();
            setTimeout(() => URL.revokeObjectURL(url), 60_000);
            onClose();
          } catch (cause) {
            if (!request.signal.aborted)
              setError(cause instanceof Error ? cause.message : '导出失败，请重试');
          } finally {
            if (!request.signal.aborted) setBusy(false);
          }
        }}
      >
        <p className="export-conversation-title">{thread.title}</p>
        <p className="muted">
          导出当前会话的完整历史，包括未加载的旧消息、工具输出和文件改动。运行中的回复仅包含已生成内容；图片和附件保留引用。
        </p>
        <fieldset className="conversation-export-formats" disabled={busy}>
          <legend>导出格式</legend>
          {formats.map((option) => (
            <label key={option.value} className="conversation-export-option">
              <input
                type="radio"
                name="export-format"
                value={option.value}
                checked={format === option.value}
                onChange={() => setFormat(option.value)}
              />
              <span>
                <strong>{option.name}</strong>
                <span className="muted small">{option.description}</span>
              </span>
            </label>
          ))}
        </fieldset>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <button type="button" className="secondary" onClick={close}>
            {busy ? '取消导出' : '取消'}
          </button>
          <button className="primary" disabled={busy}>
            {busy ? '正在导出…' : '导出文件'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
