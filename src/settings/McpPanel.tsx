import { api } from '../api';
import type { ExtensionsController } from './useExtensions';
import type { Mcp } from './extension-types';
export function McpPanel({ controller }: { controller: ExtensionsController }) {
  const {
    setMessage,
    busy,
    servers,
    mcpDraft,
    setMcpDraft,
    args,
    setArgs,
    env,
    setEnv,
    editingMcp,
    setRemove,
    run,
    load,
    editMcp,
  } = controller;
  return (
    <section className="settings-section">
      <h3>MCP 服务器</h3>
      <button className="secondary" disabled={busy} onClick={() => editMcp()}>
        新增 MCP
      </button>
      <div className="management-list">
        {servers.map((server) => (
          <div className="management-item" key={server.name}>
            <div>
              <strong>{server.name}</strong>
            </div>
            <div className="button-row">
              <button
                className="secondary"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await api('/mcp', {
                      method: 'PUT',
                      body: JSON.stringify({ ...server, enabled: !server.enabled }),
                    });
                    await load();
                  })
                }
              >
                {server.enabled ? '停用' : '启用'}
              </button>
              <button className="secondary" disabled={busy} onClick={() => editMcp(server)}>
                编辑
              </button>
              <button
                className="secondary"
                disabled={busy}
                onClick={() => setRemove({ kind: 'mcp', name: server.name })}
              >
                删除
              </button>
            </div>
          </div>
        ))}
      </div>
      {mcpDraft && (
        <form
          className="management-editor"
          onSubmit={(event) => {
            event.preventDefault();
            void run(async () => {
              const vars: Record<string, string> = {};
              for (const line of env.split(/\r?\n/).filter((v) => v.trim())) {
                const separator = line.indexOf('=');
                if (separator < 1) throw new Error('环境变量请按每行 NAME=value 填写');
                vars[line.slice(0, separator).trim()] = line.slice(separator + 1);
              }
              await api('/mcp', {
                method: 'PUT',
                body: JSON.stringify({
                  ...mcpDraft,
                  args: args.split(/\r?\n/).filter(Boolean),
                  env: vars,
                }),
              });
              setMcpDraft(null);
              await load();
              setMessage('MCP 配置已保存并重新加载');
            });
          }}
        >
          <label className="field">
            <span>服务器名称</span>
            <input
              aria-label="MCP 名称"
              required
              value={mcpDraft.name}
              readOnly={editingMcp}
              pattern="[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}"
              onChange={(e) => setMcpDraft({ ...mcpDraft, name: e.target.value })}
            />
          </label>
          <label className="field">
            <span>连接方式</span>
            <select
              aria-label="MCP 连接方式"
              value={mcpDraft.transport}
              onChange={(e) =>
                setMcpDraft({ ...mcpDraft, transport: e.target.value as Mcp['transport'] })
              }
            >
              <option value="stdio">本机命令（stdio）</option>
              <option value="http">HTTP</option>
            </select>
          </label>
          {mcpDraft.transport === 'stdio' ? (
            <>
              <label className="field">
                <span>启动命令</span>
                <input
                  aria-label="MCP 启动命令"
                  value={mcpDraft.command}
                  required
                  onChange={(e) => setMcpDraft({ ...mcpDraft, command: e.target.value })}
                />
              </label>
              <label className="field">
                <span>启动参数（每行一个）</span>
                <textarea
                  aria-label="MCP 启动参数"
                  rows={3}
                  value={args}
                  onChange={(e) => setArgs(e.target.value)}
                />
              </label>
              <label className="field">
                <span>环境变量（每行 NAME=value）</span>
                <textarea
                  aria-label="MCP 环境变量"
                  rows={3}
                  value={env}
                  onChange={(e) => setEnv(e.target.value)}
                />
              </label>
            </>
          ) : (
            <>
              <label className="field">
                <span>服务器 URL</span>
                <input
                  aria-label="MCP URL"
                  required
                  type="url"
                  value={mcpDraft.url}
                  onChange={(e) => setMcpDraft({ ...mcpDraft, url: e.target.value })}
                />
              </label>
              <label className="field">
                <span>访问令牌环境变量名（可选）</span>
                <input
                  aria-label="MCP 令牌环境变量"
                  value={mcpDraft.bearerTokenEnvVar}
                  onChange={(e) => setMcpDraft({ ...mcpDraft, bearerTokenEnvVar: e.target.value })}
                />
              </label>
            </>
          )}
          <label className="option">
            <input
              type="checkbox"
              checked={mcpDraft.enabled}
              onChange={(e) => setMcpDraft({ ...mcpDraft, enabled: e.target.checked })}
            />
            启用 MCP
          </label>
          <div className="button-row">
            <button className="primary" disabled={busy}>
              保存 MCP
            </button>
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => setMcpDraft(null)}
            >
              取消编辑
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
