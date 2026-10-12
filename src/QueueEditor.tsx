import { useEffect, useState } from 'react';
import { api } from './api';
import { Modal, Spinner } from './components';

type Draft = { text: string; revision: string; retainedParts: number };
export function QueueEditor({ id, onClose }: { id: string; onClose: () => void }) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void api<Draft>(`/queue/${encodeURIComponent(id)}`, { signal: controller.signal })
      .then((value) => {
        setDraft(value);
        setText(value.text);
      })
      .catch((cause: Error) => {
        if (!controller.signal.aborted) setError(cause.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [id]);
  return (
    <Modal
      title="编辑待发送消息"
      onClose={() => {
        if (!saving) onClose();
      }}
    >
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (!draft || saving) return;
          setSaving(true);
          setError('');
          try {
            await api(`/queue/${encodeURIComponent(id)}`, {
              method: 'PATCH',
              body: JSON.stringify({ text, revision: draft.revision }),
            });
            onClose();
          } catch (cause) {
            setError((cause as Error).message);
          } finally {
            setSaving(false);
          }
        }}
      >
        {loading && <Spinner label="正在读取完整消息" />}
        {draft && (
          <>
            <label className="field">
              <span>消息正文</span>
              <textarea
                autoFocus
                rows={9}
                maxLength={100000}
                value={text}
                disabled={saving}
                onChange={(event) => setText(event.target.value)}
              />
            </label>
            <p className="muted small">
              保留原有附件、引用、模型设置和排队顺序。保存前若消息已开始提交，修改不会覆盖已发送内容。
            </p>
          </>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <button type="button" className="secondary" disabled={saving} onClick={onClose}>
            取消
          </button>
          <button
            className="primary"
            disabled={!draft || saving || (!text.trim() && !draft.retainedParts)}
          >
            {saving ? '正在保存…' : '保存修改'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
