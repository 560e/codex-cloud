# 执行器接口覆盖

[English](en/CODEX-API-COVERAGE.md) · [文档目录](INDEX.md) · [项目首页](../README.md)

工作台通过后端持有的 Codex App Server 接入编程任务。这里区分“已接入的原生方法”“工作台自行实现的能力”和“未提供完整界面的能力”，不以 CLI 导出的接口总数推算产品完成度。

## 已接入的能力

| 用户能力                     | 主要原生方法或请求                                                                                             | 集成说明                           |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| 会话列表、读取与恢复         | `thread/list`、`thread/read`、`thread/turns/list`、`thread/resume`                                             | 处理分页能力差异和原生历史         |
| 新建、分叉、归档、改名、删除 | `thread/start`、`thread/fork`、`thread/archive`、`thread/unarchive`、`thread/name/set`、`thread/delete`        | 置顶由工作台索引维护               |
| 发送、补充与停止             | `turn/start`、`turn/steer`、`turn/interrupt`                                                                   | 同时受工作台会话互斥与全局并发限制 |
| 原生审查与压缩               | `review/start`、`thread/compact/start`                                                                         | 不支持的方法返回明确错误           |
| 模型与能力查询               | `model/list`、`modelProvider/capabilities/read`                                                                | 自定义供应商目录另行持久化         |
| 账户与配置读取               | `account/read`、`config/read`                                                                                  | 浏览器只接收脱敏摘要               |
| 文件引用搜索                 | `fuzzyFileSearch`                                                                                              | 后端再次执行项目边界校验           |
| Skills 与 MCP 状态           | `skills/list`、`skills/config/write`、`mcpServerStatus/list`                                                   | 本地保存与维护操作由工作台协调     |
| 命令/文件/权限审批           | `item/commandExecution/requestApproval`、`item/fileChange/requestApproval`、`item/permissions/requestApproval` | 按请求类型生成响应                 |
| 追问与 MCP 输入              | `item/tool/requestUserInput`、`mcpServer/elicitation/request`                                                  | 使用实际问题与输入结构             |

通知处理覆盖轮次/条目生命周期、文本和工具增量、计划、diff、用量及交互解决状态。思考区只显示接口实际提供的内容；转发未知通知并不表示界面理解或支持其语义。

## 工作台自行提供的能力

项目管理、网站登录、供应商配置与目录缓存、队列、用量汇总、文件/图片预览、Git 差异、迁移和日志维护主要属于 Web 应用层。它们不应被标记为同名原生 API 的完整实现。例如队列存放在 SQLite，文件预览使用工作台自己的文件接口。

## 未完整提供的能力

实时音频、远程控制、原生目标管理、原生队列、插件市场、全套文件监听和高级审批工作流没有完整产品入口。工作台不承诺复刻 CLI 或桌面端的全部功能。未知服务器交互请求返回不支持，不自动批准。

## 版本与验证方法

安装器固定 CLI `0.159.3`；代码中的 `0.155.1` 是历史协议基线。安装成功、初始化成功或能力查询成功都不能替代真实任务验证。

升级 CLI 或接入新供应商时：

1. 对照 [server/codex.ts](../server/codex.ts)、[server/workbench.ts](../server/workbench.ts)、[shared/protocol.ts](../shared/protocol.ts) 检查实际方法和字段。
2. 用目标 CLI 的协议定义核对请求、响应、通知和审批结构，保留明确的兼容分支。
3. 更新 [模拟执行器](../tests/mock-codex.ts) 与受影响回归；不能只修改 mock 来使断言通过。
4. 在隔离项目中验证流式输出、工具调用、审批、停止、历史恢复及目标供应商。
5. 记录 CLI/Node/系统版本、供应商类型、通过项和未验证项，按[验收指南](VALIDATION.md)归档。
