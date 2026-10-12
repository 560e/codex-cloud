# 开发指南

[English](en/RD.md) · [文档目录](INDEX.md) · [项目首页](../README.md)

先按[本地使用](LOCAL.md)准备 Node 24+、依赖、网站密码和隔离项目。开发服务同时启动 Vite 与后端；测试不应指向生产数据或生产项目。

## 常用命令

| 命令                                      | 用途与前提                                     |
| ----------------------------------------- | ---------------------------------------------- |
| `npm run dev`                             | Vite 18473 + 后端 18474，前后端开发重载        |
| `npm run typecheck`                       | 前端/共享代码与服务端 TypeScript 检查          |
| `npm run format` / `npm run format:check` | 格式化 / 只检查格式                            |
| `npm test`                                | `tests/*.test.ts` 单元与集成测试               |
| `npm run build`                           | 类型检查、Vite 前端构建、服务端编译            |
| `npm run test:e2e`                        | Playwright 浏览器测试，需已构建和安装 Chromium |
| `npm run check`                           | 类型 + 格式 + 单元/集成测试                    |
| `npm run verify`                          | check + build + 浏览器测试                     |

首次准备浏览器：`npx playwright install chromium`；Linux 缺系统库时由管理员按 Playwright 的系统依赖要求安装。测试服务占用 18479，使用模拟 CLI 和 `.test-data`，不复用已有同端口服务。

## 从改动目标定位代码

| 改动                 | 入口                                                                                                                                                      |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 会话页面、流式状态   | [src/App.tsx](../src/App.tsx)、[shared/events.ts](../shared/events.ts)、[src/event-batch.ts](../src/event-batch.ts)                                       |
| 输入、草稿与文件引用 | [src/ComposerInput.tsx](../src/ComposerInput.tsx)、[src/drafts.ts](../src/drafts.ts)                                                                      |
| 设置与供应商         | [src/settings/](../src/settings/)、[src/ProviderSettings.tsx](../src/ProviderSettings.tsx)、[server/providers.ts](../server/providers.ts)                 |
| 文件与图片           | [src/files/](../src/files/)、[server/files.ts](../server/files.ts)、[shared/image-preview.ts](../shared/image-preview.ts)                                 |
| API 与执行调度       | [server/app.ts](../server/app.ts)、[server/management-api.ts](../server/management-api.ts)、[server/workbench.ts](../server/workbench.ts)                 |
| CLI 协议             | [server/codex.ts](../server/codex.ts)、[shared/protocol.ts](../shared/protocol.ts)、[tests/mock-codex.ts](../tests/mock-codex.ts)                         |
| 数据与迁移           | [server/store.ts](../server/store.ts)、[server/migration.ts](../server/migration.ts)                                                                      |
| 安装与打包           | [scripts/install/](../scripts/install/)、[scripts/package-clean.py](../scripts/package-clean.py)、[scripts/package-baota.py](../scripts/package-baota.py) |

模块之间的职责与执行约束见[系统架构](ARCHITECTURE.md)。

## 功能变更流程

1. 明确触发条件、输入、持久化状态和失败行为。例如模型获取失败应保留原列表，而不是用空数组覆盖。
2. 涉及外部输入时，先调整边界 Schema 和公共类型，再修改服务逻辑与界面。为成功、加载、空结果和错误提供对应状态。
3. 确认并发/重启/断线行为。任务启动、审批和迁移不能靠自动重发来处理不确定结果。
4. 选择能覆盖行为差异的测试，运行受影响检查，再完成仓库要求的验证。
5. 同步中文、英文文档与 `.env.example`；配置默认值应来自代码，部署推荐值单独说明。

API 变更要核对认证、Origin、参数限制、响应结构和事件同步。持久化变更要考虑已有数据库升级、旧数据读取、备份与恢复。供应商 Key 不放入日志、响应或命令行参数。UI 变更检查桌面/移动布局、亮暗主题、键盘焦点和切换页面时的草稿行为。

## 定向验证示例

供应商和代理：

```bash
npx tsx --test tests/providers.test.ts tests/proxy.test.ts
npm run build
npx playwright test tests/e2e/providers.spec.ts
```

文件和图片：

```bash
npx tsx --test tests/image-preview.test.ts tests/file-links.test.ts tests/files.test.ts
npm run build
npx playwright test tests/e2e/image-preview.spec.ts tests/e2e/file-links.spec.ts tests/e2e/changes.spec.ts
```

模拟测试不能证明上游兼容或系统沙箱有效。CLI/供应商/平台变更的真实验收步骤见[测试与验收](VALIDATION.md)。不要为了消除失败而跳过相关测试或把开发机器路径写入源码。

## 提交与文档要求

提交说明描述可观察的问题、改后行为和实际验证结果；未验证的平台要明确标注。不要把构建结果、运行日志、真实 `.env`、凭据、测试输出或一次性修复脚本放入仓库。

文档按读者任务组织：README 提供入口，配置参考集中解释变量，平台页负责安装，运维页负责恢复。命令注明工作目录、账户和必要前提；中英文保持约束和示例一致。避免把阶段性对话记录或临时测试计数写成长期产品说明。
