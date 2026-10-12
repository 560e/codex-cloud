# 环境配置参考

[English](en/CONFIGURATION.md) · [文档目录](INDEX.md) · [项目首页](../README.md)

运行配置放在应用工作目录的 `.env`。源码仓库只提供模板：[通用示例](../.env.example)、[Linux 示例](../deploy/linux.env.example)。模板有逐项注释；真实 `.env` 不属于源码仓库。

## 加载位置与优先级

后端通过 `dotenv` 在启动时读取 `.env`。相同名称的进程环境变量优先，不会被文件覆盖。systemd 的 `WorkingDirectory`、Windows 任务的程序目录或 macOS LaunchAgent 的工作目录决定读取哪个文件。

例如源码位于 `~/projects/codex-cloud`、服务运行在 `/opt/codex-cloud`，应编辑后者的 `.env`。修改后必须重启后端；切换供应商或刷新网页不会重新加载环境配置。仅修改 `.env` 无需 `systemctl daemon-reload`，修改 systemd 单元或覆盖配置时才需要。

`npm run start:local` 会覆盖网络相关值为回环 HTTP/18473，但继续使用配置的数据目录、CLI 和代理。开发服务不会替你覆盖生产 `.env`。

## 监听与站点

下表的默认值是**未设置变量时的代码默认值**，可能与面向 HTTPS 的模板不同。

| 变量            | 默认值                   | 含义与约束                                           |
| --------------- | ------------------------ | ---------------------------------------------------- |
| `HOST`          | `127.0.0.1`              | Node 监听地址；同机反代通常保持回环                  |
| `PORT`          | `18474`                  | 后端端口，整数 1～65535                              |
| `PUBLIC_ORIGIN` | `http://127.0.0.1:18473` | 浏览器来源地址；协议、主机和端口须与实际访问一致     |
| `COOKIE_SECURE` | `false`                  | 仅接受字符串 `true/false`；HTTPS 时必须为 `true`     |
| `TRUST_PROXY`   | `false`                  | 为 `true` 时信任同机回环反代的来源头；不控制出站代理 |

公网来源要求 HTTPS 与 Secure Cookie。域名、IP、`localhost` 和 `127.0.0.1` 不是同一个 Origin。标准 443 可省略端口，非标准端口必须填写。

## 数据、CLI 与资源

| 变量                      | 默认值                         | 含义与约束                                                             |
| ------------------------- | ------------------------------ | ---------------------------------------------------------------------- |
| `DATA_DIR`                | `./data`                       | SQLite、附件、供应商密钥及日志；相对进程工作目录解析                   |
| `CODEX_BIN`               | 自动查找                       | CLI 启动文件路径；工作台管理的已安装 CLI 版本可优先使用                |
| `CODEX_HOME`              | CLI 自身默认值                 | CLI 配置、认证和原生会话目录；与服务账户一致                           |
| `CODEX_CLOUD_SKILLS_HOME` | 服务账户的 `~/.agents/skills`  | 工作台用户 Skills 的读写和迁移目录；自定义路径需另核对 CLI 的发现配置  |
| `PROJECT_ROOTS`           | 当前工作目录所在文件系统根目录 | 可添加项目的父目录；多个路径以分号分隔，显式空值表示不限制根目录       |
| `MAX_CONCURRENT_TURNS`    | `3`                            | 全实例并发上限，整数 1～16；同项目和跨项目会话均可并行，单个会话仍串行 |
| `SESSION_DAYS`            | `7`                            | “记住登录”的有效天数，整数 1～90；普通登录为 12 小时                   |
| `EVENT_RETENTION_DAYS`    | `7`                            | 事件重放记录保留天数，整数 1～30；不是原生会话正文保留期               |

Windows 路径推荐写作 `D:/Projects`。包含空格或 `#` 的值使用双引号。服务账户需要对数据目录有写权限，对项目和 CLI 有相应访问权限。`PROJECT_ROOTS` 是项目选择边界，不能替代操作系统权限或执行器沙箱。

更名前配置的 Skills 目录变量仍可读取；新名称 `CODEX_CLOUD_SKILLS_HOME` 优先。升级时保留现有目录，之后可在 `.env` 中改用新变量名。

## 出站代理

```dotenv
HTTP_PROXY=http://proxy.example.com:3128
HTTPS_PROXY=http://proxy.example.com:3128
NO_PROXY=localhost,127.0.0.1,::1,[::1]
```

将地址替换为自己的 HTTP/HTTPS 代理。`HTTPS_PROXY` 指 HTTPS 目标所用代理，并不要求代理地址本身使用 `https://`。HTTP CONNECT 代理应保留 `http://`。

后端在加载 `.env` 后配置 `fetch`，供应商子进程继承同一环境。模型发现、余额查询和 CLI 更新元数据使用此设置；子工具是否遵循代理取决于该工具自身。无需添加 `NODE_USE_ENV_PROXY=1`。

支持小写 `http_proxy/https_proxy/no_proxy`，后端优先读取小写值；避免大小写冲突。建议 HTTP/HTTPS 同时设置，避免不同客户端的缺省规则不一致。本配置入口只支持 HTTP/HTTPS 代理，不接受 SOCKS 地址。

`NO_PROXY` 使用逗号分隔直连主机。保留回环地址，内网供应商按需追加。禁用代理须同时检查 `.env`、服务环境和小写变量；只设置 `NODE_USE_ENV_PROXY=0` 不会禁用本项目的代理初始化。已有 `ALL_PROXY` 还可能影响 CLI/子工具。

## 项目级上下文设置

“添加项目”中的自动压缩滑条独立于 1M 复选框，支持 50、60、70、80、90 五档，默认 90，保存到 SQLite 而非 `.env`。已登记项目的会话传入 `model_post_turn_compact_threshold_percent`：CLI 在最终回复完成后，按当前模型的可用上下文窗口检查是否达到比例并压缩。CLI 原有压缩保护仍生效，可能提前触发；切换模型无需维护固定容量表。

勾选 1M 时额外设置 `model_context_window=1000000` 和 `model_auto_compact_token_limit=1000000×百分比/100`，例如 70% 对应 700000 Token。界面仅在开启 1M 时显示这个 Token 阈值。未勾选时保留 CLI 原有窗口和 Token 上限配置，百分比仍然生效。

配置按项目应用于会话新建、恢复、分叉和排队执行，不改写全局 `config.toml`。已有项目缺省为 1M 关闭、比例 90%；未归属登记项目的会话沿用 CLI 默认设置。百分比配置已核对 CLI 0.159.3 与上游 0.159.0 配置 Schema；旧版 CLI 可能忽略该字段，应升级后使用。模型与供应商仍须实际支持所选窗口。

## 安装与特殊启动变量

| 变量                              | 使用方                 | 用途                                                 |
| --------------------------------- | ---------------------- | ---------------------------------------------------- |
| `WORKBENCH_PASSWORD`              | 密码脚本、安装器       | 非交互设置网站密码；通过执行环境临时注入，不写入仓库 |
| `CADDY_TLS_CERT`、`CADDY_TLS_KEY` | Windows Caddy 启动脚本 | 已有 PEM 证书和私钥文件路径                          |
| `CODEX_CLOUD_INSTALL_NETWORK`     | 安装入口               | `cn/global/custom` 下载网络                          |
| `CODEX_CLOUD_NODE_MIRROR`         | 安装入口               | 自定义 Node 下载源，要求 HTTPS                       |
| `CODEX_CLOUD_RUNTIME_DIR`         | 安装入口               | 专用 Node 运行环境目录                               |
| `CODEX_CLOUD_FORCE_NODE`          | Linux/macOS 安装入口   | `1` 强制准备专用 Node                                |

供应商 Key 在网页中管理，加密保存在数据库；不要新增自定义 `API_KEY` 环境变量并假定工作台会读取它。更多行为见[供应商指南](PROVIDERS.md)。
