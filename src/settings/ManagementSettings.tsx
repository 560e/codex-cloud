import { api } from '../api';
import { useExtensions } from './useExtensions';
import { SkillsPanel } from './SkillsPanel';
import { McpPanel } from './McpPanel';
import { MigrationSettings } from './MigrationSettings';
export function ManagementSettings() {
  const controller = useExtensions();
  const { access, error, message, busy, remove, setRemove, run, load } = controller;
  return (
    <div role="region" className="management-settings" aria-label="扩展与数据迁移">
      {access && (
        <>
          <div className="button-row">
            <button className="secondary" disabled={busy} onClick={() => void run(load)}>
              刷新扩展
            </button>
          </div>
          <p className="muted small">修改扩展和导入导出时需要结束运行任务、处理审批并清空队列。</p>
          <SkillsPanel controller={controller} />
          <McpPanel controller={controller} />
          {remove && (
            <div className="maintenance-confirm">
              <p>
                确认删除 {remove.kind === 'skill' ? 'Skill' : 'MCP'}「{remove.name}」？
              </p>
              <div className="button-row">
                <button
                  className="danger"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await api(
                        `/${remove.kind === 'skill' ? 'skills' : 'mcp'}/${encodeURIComponent(remove.name)}`,
                        { method: 'DELETE' },
                      );
                      setRemove(null);
                      await load();
                    })
                  }
                >
                  确认删除扩展
                </button>
                <button className="secondary" disabled={busy} onClick={() => setRemove(null)}>
                  取消删除
                </button>
              </div>
            </div>
          )}
        </>
      )}
      <MigrationSettings />
      {busy && <p role="status">正在处理，请稍候…</p>}
      {message && <p role="status">{message}</p>}
      {error && (
        <p className="error-box" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
