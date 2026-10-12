import { useEffect, useState } from 'react';
import { api, post } from '../api';
import { Trash2 } from 'lucide-react';
import type { RuntimeStatus, StorageInfo, CleanupResult } from '../../shared/types';
import { shortThreadId } from '../thread-id';
export function DataSettings({
  status,
  refresh,
  onUsage,
}: {
  status: RuntimeStatus | null;
  refresh: () => void;
  onUsage: () => void;
}) {
  const [error, setError] = useState('');
  const [storage, setStorage] = useState<StorageInfo | null>(null);
  const [maintenanceConfirm, setMaintenanceConfirm] = useState<{
    action: 'cache' | 'logs' | 'delete';
    id?: string;
  } | null>(null);
  const [cleaning, setCleaning] = useState(false);
  const [cleanResult, setCleanResult] = useState('');
  const loadStorage = () =>
    api<StorageInfo>('/maintenance')
      .then(setStorage)
      .catch((e) => setError(e.message));
  useEffect(() => {
    void loadStorage();
  }, []);
  const bytesLabel = (bytes: number) =>
    bytes >= 1048576
      ? `${(bytes / 1048576).toFixed(1)} MB`
      : bytes >= 1024
        ? `${(bytes / 1024).toFixed(1)} KB`
        : `${bytes} B`;
  return (
    <>
      <section className="settings-section">
        <h3>Token 统计</h3>
        <button className="secondary" onClick={onUsage}>
          查看 Token 统计
        </button>
      </section>
      <div className="settings-section maintenance-section">
        <h3>
          <Trash2 size={16} />
          服务器数据清理
        </h3>
        <p className="muted small">实际清理服务器上的文件和数据库内容，不是清空页面显示。</p>
        <p className="maintenance-path">数据目录：{storage?.directory || '正在读取…'}</p>
        <div className="maintenance-row">
          <div>
            <strong>清除缓存</strong>
            <p>
              删除数据库中的事件回放缓存及过期登录记录，清空服务器会话读取缓存。会话历史和附件保留。
            </p>
            <small>{storage?.events ?? '—'} 条事件缓存；执行任务时不可清理。</small>
          </div>
          <button
            className="secondary"
            disabled={cleaning || !!status?.active.length}
            onClick={() => {
              setCleanResult('');
              setMaintenanceConfirm({ action: 'cache' });
            }}
          >
            清除缓存
          </button>
        </div>
        <div className="maintenance-row">
          <div>
            <strong>清除日志</strong>
            <p>清空数据目录 logs 下的工作台及部署日志文件。运行服务产生的新日志会继续写入。</p>
            <small>
              {storage?.logFiles ?? '—'} 个日志文件 · {bytesLabel(storage?.logBytes || 0)}
            </small>
          </div>
          <button
            className="secondary"
            disabled={cleaning}
            onClick={() => {
              setCleanResult('');
              setMaintenanceConfirm({ action: 'logs' });
            }}
          >
            清除日志
          </button>
        </div>
        {storage?.pendingDeletions?.map((item: { id: string }) => (
          <div className="maintenance-row" key={item.id}>
            <div>
              <strong>待完成的会话删除</strong>
              <p title={`会话 ID：${item.id}`}>{shortThreadId(item.id)}</p>
            </div>
            <button
              className="secondary"
              disabled={cleaning}
              onClick={() => setMaintenanceConfirm({ action: 'delete', id: item.id })}
            >
              继续清理
            </button>
          </div>
        ))}
        {maintenanceConfirm && (
          <div className="maintenance-confirm">
            <p>
              {maintenanceConfirm.action === 'cache'
                ? '确认从服务器数据库清除缓存？原始会话历史会在需要时重新读取。'
                : maintenanceConfirm.action === 'logs'
                  ? '确认清空服务器日志文件？现有日志内容将无法恢复。'
                  : '确认继续永久删除该会话的历史、相关数据库记录和上传附件？'}
            </p>
            <div className="button-row">
              <button
                className="secondary"
                disabled={cleaning}
                onClick={() => setMaintenanceConfirm(null)}
              >
                取消清理
              </button>
              <button
                className="danger"
                disabled={cleaning}
                onClick={async () => {
                  setCleaning(true);
                  setError('');
                  setCleanResult('');
                  try {
                    if (maintenanceConfirm.action === 'delete') {
                      await api(`/threads/${encodeURIComponent(maintenanceConfirm.id!)}`, {
                        method: 'DELETE',
                        body: JSON.stringify({ confirm: true }),
                      });
                      setCleanResult('会话及相关数据已永久删除。');
                    } else {
                      const result = await post<CleanupResult>('/maintenance', {
                        action: maintenanceConfirm.action,
                        confirm: true,
                      });
                      setCleanResult(
                        maintenanceConfirm.action === 'cache'
                          ? `已从服务器数据库清除 ${result.events} 条事件缓存，并清空读取缓存。`
                          : `已清空 ${result.cleared} 个日志文件，清理 ${bytesLabel(result.bytes || 0)}。${result.failed?.length ? '未能清理：' + result.failed.join('、') + '；请解除文件占用后重试。' : ''}`,
                      );
                    }
                    setMaintenanceConfirm(null);
                    await loadStorage();
                    refresh();
                  } catch (e) {
                    setError((e as Error).message);
                    await loadStorage();
                  } finally {
                    setCleaning(false);
                  }
                }}
              >
                {cleaning ? '正在清理…' : '确认清理'}
              </button>
            </div>
          </div>
        )}
        {cleanResult && (
          <p className="maintenance-result" role="status">
            {cleanResult}
          </p>
        )}
      </div>
      {error && (
        <div role="alert" className="error-box">
          {error}
        </div>
      )}
    </>
  );
}
