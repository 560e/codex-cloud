# HTTP 与 WebSocket API

[English](en/API.md) · [文档目录](INDEX.md) · [项目首页](../README.md)

本页面向工作台客户端和集成开发。这里的 `/api/*` 是工作台接口，不是供应商的模型 API。请求结构以 [server/app.ts](../server/app.ts)、[server/management-api.ts](../server/management-api.ts) 的 Zod Schema 为准，响应公共类型见 [shared/types.ts](../shared/types.ts)。

## 通用约定与认证

API 与网页同源，通常使用 JSON。普通请求体上限 1 MiB；文件上传使用 multipart，下载/预览返回二进制。发送空 JSON 请求时使用 `{}`。

只有 `GET /api/auth/status` 和 `POST /api/auth/login` 不要求登录。其他接口使用 `codex_workbench` Cookie；不使用供应商 API Key 认证。所有非 GET/HEAD 请求及 WebSocket 握手必须带与 `PUBLIC_ORIGIN` 一致的 `Origin`，包括登录请求。Cookie 为 HttpOnly、SameSite=Strict，HTTPS 部署使用 Secure。

未登录的状态响应示例：

```json
{ "apiVersion": 4, "authenticated": false, "configured": true }
```

登录请求体为 `{ "password": "<网站密码>", "remember": true }`，成功返回 `{ "ok": true }` 并设置 Cookie。修改密码需要 `{ "current": "<旧密码>", "password": "<新密码>" }`，新密码 8～1024 字符，并撤销旧会话。`configured` 只反映网站密码是否存在。

以下浏览器同源调用示例复用已登录的 Cookie，自动携带实际 Origin：

```javascript
async function api(path, method = 'GET', body) {
  const response = await fetch(path, {
    method,
    credentials: 'same-origin',
    ...(body === undefined
      ? {}
      : {
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(`${response.status}: ${result.error}`);
  return result;
}
```

该 helper 仅用于 JSON 接口，不用于迁移导出、文件预览或下载。

## 错误与重试

应用错误体为 `{ "error": "说明" }`，消息文本可能变化，不应作为稳定枚举解析。

| 状态码    | 常见含义与处理                                         |
| --------- | ------------------------------------------------------ |
| 400       | 参数、路径或请求内容无效，修正后提交                   |
| 401       | 登录失效，重新登录                                     |
| 403       | Origin 或访问边界拒绝，核对来源/配置                   |
| 404       | 资源不存在或导入预览过期                               |
| 409       | 活动任务、维护锁、并发获取或配置变化冲突，读取当前状态 |
| 413 / 415 | 请求过大 / 预览格式不支持                              |
| 429       | 触发限流，等待后重试                                   |
| 501       | 当前 CLI 不支持所请求能力                              |
| 502 / 503 | 上游调用失败 / 尚未初始化或不可用                      |
| 500       | 其他服务端错误，检查日志                               |

提交消息、审批或维护操作超时不表示操作未执行。接口不提供通用幂等键；响应不明确时先查询状态和历史，不自动重放修改请求。

## 项目与会话

| 方法       | 路径                       | 参数/行为                                                                         |
| ---------- | -------------------------- | --------------------------------------------------------------------------------- |
| GET        | `/api/project-directories` | `path` 查询参数，浏览允许目录                                                     |
| GET / POST | `/api/projects`            | 列表返回项目数组；创建见下例                                                      |
| DELETE     | `/api/projects/:id`        | 移除索引，保留磁盘源码                                                            |
| PUT        | `/api/projects/:id/prompt` | `{systemPrompt}`，最多 50000 字符                                                 |
| GET        | `/api/threads`             | `cursor/search/archived/project`；`archived` 为字符串 `true/false`                |
| POST       | `/api/threads`             | `projectId` 与可选执行配置                                                        |
| GET        | `/api/threads/:id`         | 读取历史，可带 `cursor`                                                           |
| POST       | `/api/threads/:id/action`  | `action` 为 `archive/unarchive/fork/rename/pin`；重命名带 `name`，置顶带 `pinned` |
| DELETE     | `/api/threads/:id`         | 必须提交 `{confirm:true}`，永久删除                                               |

归档管理页先读取 `GET /api/projects`，再按项目请求 `GET /api/threads?archived=true&project=<id>`；每个项目分别使用响应中的 `nextCursor` 继续分页。恢复会话提交 `{ "action": "unarchive" }`。成功后服务发布 `workbench/threadsChanged`，已连接的工作台会重新同步普通会话列表。

```javascript
const project = await api('/api/projects', 'POST', {
  name: 'Example project',
  path: '/srv/projects/example',
  create: false,
});
const created = await api('/api/threads', 'POST', {
  projectId: project.id,
  approvalPolicy: 'on-request',
  sandbox: 'workspace-write',
});
const threadId = created.thread.id;
await api(`/api/threads/${encodeURIComponent(threadId)}/messages`, 'POST', {
  text: 'Describe the project structure without changing files.',
});
```

`approvalPolicy` 支持 `untrusted/on-request/never`，`sandbox` 支持 `read-only/workspace-write/danger-full-access`。创建接口默认 sandbox 为 `danger-full-access`，集成调用方应显式选择所需权限。`model` 为可选模型 ID。

## 记忆与协作

`GET /api/features` 返回 `{memory:boolean,collaboration:boolean}`；两个功能默认均为 `false`。`PUT /api/features` 可只提交要修改的开关（至少一个布尔值），未提交的开关保持原值。功能关闭时，对应业务接口返回 409，协作中待交接的运行暂停；已开始的轮次可能继续完成。

| 方法               | 路径                                      | 请求或结果                                                                                    |
| ------------------ | ----------------------------------------- | --------------------------------------------------------------------------------------------- |
| GET / POST         | `/api/memories`                           | GET 可选 `projectId`，结果含全局记忆；POST `{projectId:string\|null,content,sourceThreadId?}` |
| PATCH / DELETE     | `/api/memories/:id`                       | PATCH `{content?,enabled?,projectId?:string\|null}`；DELETE 删除记忆                          |
| GET                | `/api/threads/:id/turns/:turnId/memories` | 返回本轮引用的记忆 ID                                                                         |
| GET / POST         | `/api/collaborations`                     | 列表；POST `{name,goal,members,maxSteps}`                                                     |
| GET / PUT / DELETE | `/api/collaborations/:id`                 | 详情、整体更新、删除及关联运行清理                                                            |
| GET / POST         | `/api/collaborations/:id/runs`            | 运行列表；POST `{prompt}` 启动                                                                |
| GET                | `/api/collaboration-runs/:id`             | 运行状态与当前步骤                                                                            |
| GET                | `/api/collaboration-runs/:id/handoffs`    | 交接记录                                                                                      |
| POST               | `/api/collaboration-runs/:id/actions`     | `{action:"pause"\|"resume"\|"stop"}`                                                          |

`members` 为 2～8 项，每项 `{threadId,instruction,nextThreadId?}`；`nextThreadId` 只能指向本组会话，省略时按列表进入下一位。`maxSteps` 为 2～30。交接仅保存最多 6000 字符的本轮最终回复。运行的 `status` 为 `ready/starting/running/paused/stopping/completed/cancelled`；暂停中的提交状态不明确时需核对原生历史，后端不会重发。

## 项目上下文参数

`POST /api/projects` 额外接受以下可选字段，并在创建响应与项目列表中返回：

| 字段                 | 默认值  | 约束                                                                  |
| -------------------- | ------- | --------------------------------------------------------------------- |
| `contextWindow1M`    | `false` | 布尔值，启用该项目的 1,000,000 Token 窗口覆盖                         |
| `autoCompactPercent` | `90`    | 数字，仅接受 50、60、70、80、90；不依赖 1M 开关，始终设置轮末压缩比例 |

例如创建请求可包含 `"contextWindow1M": true, "autoCompactPercent": 70`，对应自动压缩阈值 700000 Token。无效档位或字符串数字返回 400。配置保存在项目数据库设置中，旧记录缺省为未启用。客户端无需在每次 `/api/threads` 或消息请求中重复发送；后端按会话所属项目应用。

## 消息、队列与交互

`POST /api/threads/:id/messages` 接受：

| 字段                | 类型与限制                                                         |
| ------------------- | ------------------------------------------------------------------ |
| `text`              | 必填字符串，最多 100000 字符；无非空文本时必须有附件               |
| `attachments`       | 本会话的附件 ID 数组，最多 10 个                                   |
| `references`        | 对话引用字符串，最多 5 个、每个 100000 字符                        |
| `fileReferences`    | 项目文件路径数组，最多 10 个、每个 3000 字符                       |
| `model`             | 可选，最多 200 字符                                                |
| `effort`            | `none/minimal/low/medium/high/xhigh/max/ultra`；是否可用取决于模型 |
| `enqueue` / `steer` | 布尔值，默认 false，不能同时 true                                  |

普通发送返回原生任务结果，入队返回 `{queued:true,id}`。返回成功不代表模型已完成；后续状态通过 WebSocket 或历史读取获取。补充指令保持当前轮模型。

| 方法 | 路径                           | 请求                                                                   |
| ---- | ------------------------------ | ---------------------------------------------------------------------- |
| POST | `/api/threads/:id/interrupt`   | `{}`，请求停止                                                         |
| POST | `/api/threads/:id/native-task` | `{type:"compact"}` 或 `{type:"review",target:…}`；target 见协议 Schema |
| POST | `/api/queue/:id`               | `{action:"cancel"}` 或 `{action:"resume"}`                             |
| POST | `/api/requests/:id`            | 按交互类型提交 `decision`、`answers` 或 `content`                      |
| POST | `/api/runtime/force-stop`      | `{}`，影响整个执行器                                                   |

交互答案应按服务器给出的请求类型构造，不能对所有审批使用统一答案。未知或已解决的请求不能当作待处理请求重复回答。

## 供应商与模型目录

| 方法       | 路径                                    | 结果/请求                                              |
| ---------- | --------------------------------------- | ------------------------------------------------------ |
| GET        | `/api/providers/access`                 | 共享管理状态与当前供应商摘要                           |
| GET        | `/api/providers`                        | `{profiles,activeId}`，不包含已保存 Key                |
| POST / PUT | `/api/providers` / `/api/providers/:id` | `name/baseUrl/model/models/apiKey`；PUT 不是部分 PATCH |
| DELETE     | `/api/providers/:id`                    | 当前供应商需先切换走                                   |
| POST       | `/api/providers/active`                 | `{id:"供应商 UUID"}`；`null` 恢复服务器默认            |
| POST       | `/api/providers/:id/models/refresh`     | `{}`，显式请求上游并保存目录                           |
| GET        | `/api/providers/:id/balance`            | 上游支持时返回余额；`default` 指服务器默认             |
| GET        | `/api/models`                           | `{data,nextCursor}`，自定义供应商读取保存的目录        |

新建必须提交 Key；更新时**省略** `apiKey` 保留原 Key，直接提交空字符串会被 Schema 拒绝。界面空输入会转换为省略字段。

获取模型的响应示例（ID、时间为示例）：

```json
{
  "id": "00000000-0000-4000-8000-000000000001",
  "name": "Example provider",
  "baseUrl": "https://provider.example.com/v1",
  "model": "model-a",
  "models": ["model-a", "model-b"],
  "modelsFetchedAt": 1791676800000,
  "hasKey": true
}
```

`modelsFetchedAt` 是毫秒时间戳。成功后发布 `workbench/providerModelsUpdated`，参数为 `{providerId}`。失败保留原数据；并发/配置变化返回 409，上游失败返回 502。路径构造、空列表和手动编辑规则见[供应商](PROVIDERS.md)。旧 `/api/providers/unlock`、`/api/providers/lock` POST 接口仅保留兼容，当前没有独立的供应商密码会话。

## 文件与附件

| 方法       | 路径                                         | 用法                                                                                     |
| ---------- | -------------------------------------------- | ---------------------------------------------------------------------------------------- |
| GET / POST | `/api/threads/:id/attachments`               | 列表 / multipart 上传一个文件                                                            |
| DELETE     | `/api/threads/:id/attachments/:attachmentId` | 删除允许清理的待发送附件                                                                 |
| GET        | `/api/files`                                 | `project` 或 `thread`，`mode=list/read/preview/download/diff`，`path`，列表可带 `offset` |
| GET        | `/api/file-link`                             | `project` 或 `thread`，`target` 文件链接                                                 |
| GET        | `/api/file-search`                           | `project` 或 `thread`，`query` 模糊查询                                                  |

预览例：`/api/files?project=PROJECT_ID&mode=preview&path=images%2Fsample.png`。图片返回字节与 MIME，最大 20 MiB，支持 PNG/JPEG/GIF/WebP/AVIF/BMP/ICO/SVG，SVG 附沙箱 CSP。文本读取最大 2 MiB，目录每页最多 1000 项，附件单文件最大 20 MiB。所有路径仍经过认证与真实路径边界校验。

## 扩展、执行环境与数据

| 方法               | 路径                                              | 用途                                                      |
| ------------------ | ------------------------------------------------- | --------------------------------------------------------- |
| GET / POST         | `/api/status` / `/api/connect`                    | 运行快照 / 连接 CLI（`{}`）                               |
| GET                | `/api/account`, `/api/capabilities`               | 脱敏账户摘要 / CLI 能力                                   |
| GET / PUT          | `/api/skills`                                     | 列表（可带 `project`）/ 保存用户 Skill                    |
| GET / DELETE       | `/api/skills/:name/content` / `/api/skills/:name` | 内容 / 删除                                               |
| POST               | `/api/skills/enabled`                             | `{path,enabled,project?}`                                 |
| GET / PUT / DELETE | `/api/mcp` / `/api/mcp` / `/api/mcp/:name`        | 列表 / 保存 / 删除                                        |
| GET / POST         | `/api/cli` / `/api/cli/update`                    | 当前及最新版本 / `{version,confirm:true}`                 |
| GET                | `/api/usage`                                      | `since` 毫秒时间、`project/thread` 过滤、`page` 从 1 开始 |
| GET / POST         | `/api/maintenance`                                | 统计 / `{action:"cache"或"logs",confirm:true}`            |

Skill/MCP 请求结构见 [server/extensions.ts](../server/extensions.ts)。声明支持的能力仍需供应商实际验证。

迁移流程：`GET /api/migration` 读取路径和格式 → `POST /api/migration/preview` 上传 multipart 归档 → 核对项目映射 → `POST /api/migration/apply` 提交 `{id,confirm:true,projects:{"项目ID":"目标绝对路径"}}`。成功返回 `{ok:true,backups}`，应重新登录和读取快照。预览最多 3 份、有效期 1 小时，重启失效；上传最大 2 GiB。`DELETE /api/migration/:id` 清理预览。`POST /api/migration/export` 返回 gzip 归档，不是 JSON。

## WebSocket 恢复协议

已登录客户端连接同源 `/api/events?after=SEQ`，HTTPS 使用 `wss:`。服务器按顺序发送：

```jsonl
{ "type": "hello", "reset": false, "cursor": 42, "status": {} }
{ "type": "event", "event": { "seq": 42, "method": "workbench/providerModelsUpdated", "params": { "providerId": "example-id" }, "at": 1791676800000 } }
{ "type": "synced", "cursor": 42 }
```

示例中的 `status` 省略具体字段。之后继续推送实时 `event`。客户端保存最后处理的序号，重连时传入 `after`。首次连接或游标过期/有缺口/超过 2000 条重放预算时 `reset:true`，必须重新读取相关快照，并合并期间的新事件。完成条目应替换相应增量，不能重复追加。

登录失效使用关闭码 4001；慢客户端可能收到 1013 并需重新同步。迁移导入后连接关闭，需重新登录。重连只恢复观察状态，不应自动重发消息、审批或其他修改请求。

## 会话内容导出

`GET /api/threads/:id/export?format=txt|markdown|html` 需要已有登录 Cookie，返回 UTF-8 文件附件，内容类型分别为 `text/plain`、`text/markdown`、`text/html`，扩展名为 `.txt`、`.md`、`.html`，并设置 `Cache-Control: no-store`。该接口只导出指定会话内容，不是迁移备份。

后端读取全部原生历史分页及完整条目，按时间先后排序并对重叠轮次去重，不启动模型任务或刷新余额。格式无效返回 400，会话不存在返回 404，已有导出进行中返回 429；内容超过 64 MiB 或历史超过 10000 页返回 413。分页异常使整个请求失败，不返回截断文件。下载连接断开后停止读取后续分页，已发出的原生读取请求可能仍会完成。

## 编辑队列与 HTML 预览

- `GET /api/queue/:id` 返回 `{id,threadId,text,revision,retainedParts}`，仅支持等待执行或已暂停的消息。`text` 是完整可编辑正文，不是 300 字符的队列摘要。
- `PATCH /api/queue/:id` 接受 `{text,revision}`，正文最多 100000 字符，保留正文之外的输入条目与执行选项。消息已移除、正在提交或被其他页面修改时返回 409；只有正文的消息不能保存为空。成功后保持原 ID、创建时间和队列状态。
- `POST /api/html-preview` 接受 `{project,path}` 或 `{thread,path}`，返回 `{url}`，要求登录并通过 Origin 校验。预览授权只保存在内存，有效期一小时，最多保留 64 份。
- `GET /api/html-preview/:token/*` 提供授权项目内允许的静态资源。每次请求校验不可预测的预览凭证及其原登录会话，隔离页面加载资源无需携带 Cookie。退出登录、改密码、到期和服务重启均使授权失效。响应附沙箱 CSP、禁止缓存与隔离源 CORS；拒绝越界、外部符号链接、隐藏路径及不支持的资源类型。HTML 上限 2 MiB，其他允许的资源上限 20 MiB。
