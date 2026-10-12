# 运维指南

[English](en/OPERATIONS.md) · [文档目录](INDEX.md) · [项目首页](../README.md)

维护前先确认实际程序目录、服务账户、`DATA_DIR`、`CODEX_HOME` 和项目根目录。源码副本与运行目录可以不同。以下 systemd 示例使用服务名 `codex-cloud`；其他平台的启停命令见 [Windows](WINDOWS.md) 和 [macOS](MACOS.md)。

## 状态检查与日志

```bash
systemctl status codex-cloud --no-pager
journalctl -u codex-cloud -n 80 --no-pager
curl --fail http://127.0.0.1:18474/api/auth/status
```

`configured: true` 表示已设置网站密码，不能证明 CLI 或供应商可用。按后端接口 → HTTPS 登录 → WebSocket → CLI → 真实模型任务的顺序检查。

服务标准输出进入 journal；CLI 诊断在 `DATA_DIR/logs/codex-diagnostic.log`。应用文件日志按 10 MiB 轮转、保留 5 份，并有 14 天/256 MiB 的维护清理预算；反代日志另行管理。导出诊断前检查是否含项目内容或私有路径。

`npm run doctor` 需在程序目录、以服务账户和实际环境执行。它检查 CLI 启动及模型/账户/会话读取，不发送模型任务；它使用 CLI 配置，不应当作数据库中当前自定义供应商的完整验收。

## 出站代理检查与停用

变量说明见[配置参考](CONFIGURATION.md)。用不带 Key 的请求先检查网络：

```bash
curl --proxy http://proxy.example.com:3128 --noproxy '' \
  --head --connect-timeout 10 --max-time 20 https://provider.example.com/
```

CONNECT 200 只表示建立隧道；上游 401/403/404 可能说明网络可达，但不代表认证或模型可用。重启后，在网页获取模型并运行一条真实任务验证完整链路。

若 `.env` 修改无效，查看服务覆盖文件位置：

```bash
systemctl show codex-cloud -p ActiveState -p MainPID -p DropInPaths
```

检查同名服务变量及小写代理变量。进程环境覆盖 `.env` 的同名项，小写代理变量优先。仅修改 `.env` 后重启即可；修改 systemd 单元或覆盖文件后才需 `daemon-reload`。

停用代理时，移除 `.env` 和服务环境中的 `HTTP_PROXY`、`HTTPS_PROXY` 及对应小写项；同时检查子工具可能读取的 `ALL_PROXY`。保留其余服务设置，重载已修改的服务配置并重启。仅设置 `NODE_USE_ENV_PROXY=0` 不会关闭本项目主动配置的代理。代理失败不会自动直连重试。

## 备份范围与离线导出

| 内容                                         | 迁移备份包含情况         |
| -------------------------------------------- | ------------------------ |
| 工作台数据库、附件、供应商加密材料           | 包含                     |
| 支持的 CLI 配置、认证、原生历史与用户 Skills | 包含；检查导出警告和清单 |
| 项目源码、Git 仓库和未提交改动               | 不包含，单独备份         |
| 应用 `.env`、服务单元、反代和 TLS 配置       | 不包含，单独备份         |
| Node、CLI 二进制、依赖和构建文件             | 不包含，可按记录版本重装 |

迁移包含凭据，应存放于受限目录。不要只复制正在使用的 SQLite 主文件；WAL 数据和 `providers.key` 都可能影响恢复。使用应用提供的备份，或在全部相关进程停止后做一致的目录备份。

等待任务、审批和队列空闲，停止服务：

```bash
sudo systemctl stop codex-cloud
```

然后以服务账户进入运行目录，确保加载与服务相同的配置。以下路径是示例，备份目录须可写且限制其他账户访问：

```bash
cd /opt/codex-cloud
npm run backup -- /protected/backups/codex-cloud-before-upgrade.tar.gz
npm run migrate -- inspect /protected/backups/codex-cloud-before-upgrade.tar.gz
```

这些脚本使用 `dist`，首次使用前需已构建。目标归档必须不存在。核对输出文件数、警告、项目清单和原路径，再复制到独立存储。若只是备份，完成后启动服务并检查状态。在线导出可使用“设置 → 扩展与迁移”，由后端维护锁协调。

## 恢复或迁移到新机器

1. 安装所需 Node/CLI，准备兼容版本的程序并构建。
2. 单独复制项目源码，保留需要的未提交改动；准备服务账户权限、`.env` 与 HTTPS。
3. 检查迁移包，生成项目 ID 到新绝对路径的映射。ID 来自 `inspect` 的 `mapping` 字段，不是项目显示名称。
4. 停止目标服务并备份目标已有数据；以目标服务账户导入。

`mapping.json` 示例：

```json
{ "project-id-from-inspect": "/srv/projects/my-app" }
```

```bash
npm run migrate -- import /protected/backups/codex-cloud-before-upgrade.tar.gz \
  --mapping /protected/backups/mapping.json \
  --data-dir /var/lib/codex-cloud/data \
  --codex-home /var/lib/codex-cloud/.codex \
  --skills-home /var/lib/codex-cloud/.agents/skills
```

显式路径必须与目标服务实际配置一致，数据、CLI 和 Skills 目录不能相互包含。路径映射不搬运项目源码。保存导入返回的备份路径，确认成功后再启动目标服务；使用备份内的网站密码登录，核对历史、附件、供应商和项目路径，并执行测试任务。

网页导入同样先上传校验、逐项映射，再确认应用；预览最多保留 1 小时，重启后失效。归档上传上限 2 GiB，反代上传限制也须允许。不要删除数据锁绕过正在运行的实例。

## 升级与回滚

1. 记录当前代码版本、Node/CLI 版本和配置路径，在独立目录安装依赖、执行检查并构建新版本。
2. 等待空闲，备份数据、项目及应用配置，停止服务。
3. 更新程序和依赖，保留实际 `.env`、数据和服务权限。依赖安装用 `npm ci --include=dev`，不要跨系统复制 `node_modules`。
4. 发布相匹配的前后端构建。原目录覆盖静态资源时先复制新资源，最后替换 `index.html`，暂留旧哈希资源供已打开页面加载。
5. 启动服务，检查 HTTPS、登录、实时事件、历史、附件和一条真实任务。

回滚前确认旧程序能读取升级后的数据格式。不能确认时，停止服务后将旧程序与升级前配套数据一起恢复；这会放弃备份之后的数据，应先保存当前状态。不要把更新源码目录理解为已经部署。

## 密码、清理与故障定位

忘记网站密码时，在实际程序目录以服务账户运行 `npm run password`。新密码撤销旧登录。不要删除数据库重置密码，也不要单独删除 `providers.key`。

缓存清理不删除 CLI 原生历史，不压缩模型上下文；日志清理不清理反向代理日志。会话永久删除与这两类维护不同。

| 现象                  | 检查顺序                                              |
| --------------------- | ----------------------------------------------------- |
| 反代 502              | 后端状态 → 监听端口 → 反代目标 → 日志                 |
| 登录或 WebSocket 失败 | 实际访问 Origin → Secure Cookie → HTTPS → Upgrade 头  |
| CLI 未连接            | 服务账户 → Node/CLI 路径 → HOME/CODEX_HOME → 诊断日志 |
| 数据目录已占用        | 是否存在另一实例或未退出进程；确认退出后再启动        |
| 切换/维护返回冲突     | 活动任务、审批、队列及维护操作是否完成                |
| 历史缺失              | 是否使用正确 CODEX_HOME，原生历史是否随迁移恢复       |
| 图片打不开            | 路径权限、格式、20 MiB 限制、浏览器解码               |
