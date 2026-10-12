# Executor API coverage

[简体中文](../CODEX-API-COVERAGE.md) · [Documentation](INDEX.md) · [Project home](../../README.en.md)

The workbench integrates coding tasks through a backend-owned Codex App Server. This page distinguishes native methods, workbench-owned features and capabilities without a complete UI. CLI export counts are not a measure of product completeness.

## Integrated capabilities

| Capability                               | Main native methods or requests                                                                                | Integration notes                                      |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| List, read and resume conversations      | `thread/list`, `thread/read`, `thread/turns/list`, `thread/resume`                                             | Pagination differences and native history              |
| Create, fork, archive, rename and delete | `thread/start`, `thread/fork`, `thread/archive`, `thread/unarchive`, `thread/name/set`, `thread/delete`        | Pinning uses the workbench index                       |
| Send, steer and stop                     | `turn/start`, `turn/steer`, `turn/interrupt`                                                                   | Also subject to conversation locks and global capacity |
| Native review and compaction             | `review/start`, `thread/compact/start`                                                                         | Unsupported methods return explicit errors             |
| Models and capabilities                  | `model/list`, `modelProvider/capabilities/read`                                                                | Custom-provider catalogs persist separately            |
| Account and configuration reads          | `account/read`, `config/read`                                                                                  | Browser receives redacted summaries                    |
| File-reference search                    | `fuzzyFileSearch`                                                                                              | Backend rechecks project boundaries                    |
| Skills and MCP status                    | `skills/list`, `skills/config/write`, `mcpServerStatus/list`                                                   | Workbench coordinates local writes and maintenance     |
| Command/file/permission approval         | `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `item/permissions/requestApproval` | Responses depend on the request type                   |
| Questions and MCP input                  | `item/tool/requestUserInput`, `mcpServer/elicitation/request`                                                  | Uses actual question and input structures              |

Notification handling covers turn/item lifecycle, text/tool deltas, plans, diffs, usage and resolved interactions. Reasoning displays only content supplied by the interface. Forwarding an unknown notification does not establish UI support for its semantics.

## Workbench-owned features

Projects, website login, provider profiles/catalogs, queues, usage aggregation, file/image previews, Git diffs, migration and log maintenance primarily belong to the web application. They are not complete implementations of similarly named native APIs. For example, queues use SQLite and previews use the workbench file API.

## Features without complete integration

Real-time audio, remote control, native goals, native queues, a plugin marketplace, full filesystem watching and advanced approval workflows lack complete product interfaces. The workbench does not promise parity with every CLI or desktop feature. Unknown server requests receive an unsupported response, not automatic approval.

## Versions and verification

The installer pins CLI `0.159.3`; `0.155.1` references identify a historical protocol baseline. Installation, initialization or capability queries alone do not verify a real task.

When upgrading the CLI or adding a provider:

1. Inspect actual methods and fields in [server/codex.ts](../../server/codex.ts), [server/workbench.ts](../../server/workbench.ts) and [shared/protocol.ts](../../shared/protocol.ts).
2. Compare requests, responses, notifications and approvals with the target CLI's protocol definitions, retaining explicit compatibility branches.
3. Update the [mock executor](../../tests/mock-codex.ts) and affected regressions; do not change mocks merely to satisfy assertions.
4. Verify streaming, tools, approvals, interruption, history recovery and the target upstream in an isolated project.
5. Record CLI/Node/OS versions, provider type, passed checks and unverified areas following [Acceptance](VALIDATION.md).
