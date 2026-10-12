# HTTP and WebSocket API

[简体中文](../API.md) · [Documentation](INDEX.md) · [Project home](../../README.en.md)

This reference is for workbench clients and integrations. Its `/api/*` routes belong to the workbench, not the upstream model provider. Request contracts are defined by Zod schemas in [server/app.ts](../../server/app.ts) and [server/management-api.ts](../../server/management-api.ts); shared responses are in [shared/types.ts](../../shared/types.ts).

## Conventions and authentication

APIs share the website origin and normally use JSON. Ordinary request bodies are limited to 1 MiB; uploads use multipart and downloads/previews return bytes. Send `{}` for empty JSON requests.

Only `GET /api/auth/status` and `POST /api/auth/login` are public. Other routes require the `codex_workbench` cookie, not a provider API key. All non-GET/HEAD requests and WebSocket handshakes require an `Origin` matching `PUBLIC_ORIGIN`, including login. Cookies are HttpOnly and SameSite=Strict, with Secure enabled for HTTPS.

Example unauthenticated status:

```json
{ "apiVersion": 4, "authenticated": false, "configured": true }
```

Login accepts `{ "password": "<website password>", "remember": true }`, returns `{ "ok": true }` and sets a cookie. Password changes accept `{ "current": "<old password>", "password": "<new password>" }`; new passwords are 8–1,024 characters and revoke previous sessions. `configured` indicates website-password initialization only.

This browser helper reuses the signed-in cookie and the browser's actual Origin:

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

Use it only for JSON routes, not migration export, file previews or downloads.

## Errors and retries

Application errors return `{ "error": "description" }`. Message text can change; do not parse it as a stable error enum.

| Status    | Common meaning and handling                                                 |
| --------- | --------------------------------------------------------------------------- |
| 400       | Invalid input, path or content; correct the request                         |
| 401       | Session expired; sign in                                                    |
| 403       | Origin or access boundary rejected                                          |
| 404       | Missing resource or expired import preview                                  |
| 409       | Task, maintenance, concurrent-fetch or configuration conflict; reread state |
| 413 / 415 | Payload too large / unsupported preview format                              |
| 429       | Rate limit; wait before retrying                                            |
| 501       | Installed CLI lacks the requested capability                                |
| 502 / 503 | Upstream failure / uninitialized or unavailable service                     |
| 500       | Other server failure; inspect logs                                          |

A timeout does not prove a message, approval or maintenance operation was not executed. There is no general idempotency-key contract. Read current state/history after uncertain results instead of automatically replaying mutations.

## Projects and conversations

| Method     | Path                       | Parameters/behavior                                                             |
| ---------- | -------------------------- | ------------------------------------------------------------------------------- |
| GET        | `/api/project-directories` | `path` query; browse allowed directories                                        |
| GET / POST | `/api/projects`            | List returns a project array; creation example below                            |
| DELETE     | `/api/projects/:id`        | Remove the index, retain source files                                           |
| PUT        | `/api/projects/:id/prompt` | `{systemPrompt}`, up to 50,000 characters                                       |
| GET        | `/api/threads`             | `cursor/search/archived/project`; `archived` is the string `true/false`         |
| POST       | `/api/threads`             | `projectId` plus optional execution configuration                               |
| GET        | `/api/threads/:id`         | Read history, optionally with `cursor`                                          |
| POST       | `/api/threads/:id/action`  | `archive/unarchive/fork/rename/pin`; use `name` for rename and `pinned` for pin |
| DELETE     | `/api/threads/:id`         | Requires `{confirm:true}`; permanent deletion                                   |

The archive settings page reads `GET /api/projects`, then requests `GET /api/threads?archived=true&project=<id>` for each project. Each project advances independently with the returned `nextCursor`. Restore sends `{ "action": "unarchive" }`. A successful restore publishes `workbench/threadsChanged`, allowing connected workbenches to refresh their regular conversation lists.

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

`approvalPolicy` accepts `untrusted/on-request/never`; `sandbox` accepts `read-only/workspace-write/danger-full-access`. The creation API defaults to `danger-full-access`; integrations should explicitly select permissions. `model` is an optional model ID.

## Memory and collaboration

`GET /api/features` returns `{memory:boolean,collaboration:boolean}`. Both values default to `false`. `PUT /api/features` accepts one or both booleans; omitted switches keep their current values. Disabled feature routes return 409; disabling collaboration pauses subsequent handoffs while an already started turn may still finish.

| Method             | Path                                      | Request or result                                                                                       |
| ------------------ | ----------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| GET / POST         | `/api/memories`                           | Optional GET `projectId` includes global notes; POST `{projectId:string\|null,content,sourceThreadId?}` |
| PATCH / DELETE     | `/api/memories/:id`                       | PATCH `{content?,enabled?,projectId?:string\|null}`; DELETE removes a note                              |
| GET                | `/api/threads/:id/turns/:turnId/memories` | Memory IDs used for that turn                                                                           |
| GET / POST         | `/api/collaborations`                     | List; POST `{name,goal,members,maxSteps}`                                                               |
| GET / PUT / DELETE | `/api/collaborations/:id`                 | Read, replace or delete with its run records                                                            |
| GET / POST         | `/api/collaborations/:id/runs`            | List runs; POST `{prompt}` starts a run                                                                 |
| GET                | `/api/collaboration-runs/:id`             | Run status and current step                                                                             |
| GET                | `/api/collaboration-runs/:id/handoffs`    | Handoff history                                                                                         |
| POST               | `/api/collaboration-runs/:id/actions`     | `{action:"pause"\|"resume"\|"stop"}`                                                                    |

`members` has 2–8 entries shaped `{threadId,instruction,nextThreadId?}`. The optional target must be a member; omitted targets follow list order. `maxSteps` is 2–30. A handoff stores at most 6,000 characters of the completed turn's final reply. Run states are `ready/starting/running/paused/stopping/completed/cancelled`. An uncertain submission must be checked against native history before continuing; it is not resent automatically.

## Project context parameters

`POST /api/projects` also accepts these optional fields, returned in creation responses and project lists:

| Field                | Default | Constraint                                                           |
| -------------------- | ------- | -------------------------------------------------------------------- |
| `contextWindow1M`    | `false` | Boolean; enables the project's 1,000,000-token window override       |
| `autoCompactPercent` | `90`    | Number; 50, 60, 70, 80 or 90; applies independently of the 1M toggle |

For example, `"contextWindow1M": true, "autoCompactPercent": 70` selects 700000 tokens. Invalid stops and numeric strings return 400. Settings persist in the project database; older records default to disabled. Clients do not repeat these fields in thread or message requests: the backend applies the owning project's configuration.

## Messages, queues and interactions

`POST /api/threads/:id/messages` accepts:

| Field               | Type and limits                                                                      |
| ------------------- | ------------------------------------------------------------------------------------ |
| `text`              | Required string, up to 100,000 characters; attachments are required if text is blank |
| `attachments`       | IDs belonging to this conversation, at most 10                                       |
| `references`        | At most 5 quoted strings, 100,000 characters each                                    |
| `fileReferences`    | At most 10 project paths, 3,000 characters each                                      |
| `model`             | Optional, at most 200 characters                                                     |
| `effort`            | `none/minimal/low/medium/high/xhigh/max/ultra`; support depends on the model         |
| `enqueue` / `steer` | Booleans, default false; cannot both be true                                         |

A normal send returns the native task result; enqueue returns `{queued:true,id}`. Success does not mean the model has finished. Observe WebSocket events or reread history. Steering retains the current turn's model.

| Method | Path                           | Request                                                                          |
| ------ | ------------------------------ | -------------------------------------------------------------------------------- |
| POST   | `/api/threads/:id/interrupt`   | `{}`, request interruption                                                       |
| POST   | `/api/threads/:id/native-task` | `{type:"compact"}` or `{type:"review",target:…}`; see protocol schema for target |
| POST   | `/api/queue/:id`               | `{action:"cancel"}` or `{action:"resume"}`                                       |
| POST   | `/api/requests/:id`            | Type-specific `decision`, `answers` or `content`                                 |
| POST   | `/api/runtime/force-stop`      | `{}`, affects the whole executor                                                 |

Construct interaction answers from the received request type, not a universal approval response. Unknown or resolved requests are not pending work to answer again.

## Providers and model catalogs

| Method     | Path                                    | Response/request                                               |
| ---------- | --------------------------------------- | -------------------------------------------------------------- |
| GET        | `/api/providers/access`                 | Shared management state and active-provider summary            |
| GET        | `/api/providers`                        | `{profiles,activeId}`, without saved keys                      |
| POST / PUT | `/api/providers` / `/api/providers/:id` | `name/baseUrl/model/models/apiKey`; PUT is not a partial PATCH |
| DELETE     | `/api/providers/:id`                    | Switch away from an active provider first                      |
| POST       | `/api/providers/active`                 | `{id:"provider UUID"}`; `null` restores server defaults        |
| POST       | `/api/providers/:id/models/refresh`     | `{}`, explicitly fetch and persist the upstream catalog        |
| GET        | `/api/providers/:id/balance`            | Balance when supported; `default` selects server defaults      |
| GET        | `/api/models`                           | `{data,nextCursor}`; custom providers use saved catalogs       |

A new profile requires a key. On update, **omit** `apiKey` to retain it; an empty string fails validation. The UI converts its blank edit input into an omitted field.

Example refresh response with illustrative ID and timestamp:

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

`modelsFetchedAt` is a millisecond timestamp. Success publishes `workbench/providerModelsUpdated` with `{providerId}`. Failures retain saved data; concurrency/configuration conflicts return 409 and upstream failures return 502. See [Providers](PROVIDERS.md) for URL construction, empty lists and manual editing. Legacy POST `/api/providers/unlock` and `/api/providers/lock` remain compatibility no-ops; there is no separate provider-password session.

## Files and attachments

| Method     | Path                                         | Usage                                                                                        |
| ---------- | -------------------------------------------- | -------------------------------------------------------------------------------------------- |
| GET / POST | `/api/threads/:id/attachments`               | List / multipart upload of one file                                                          |
| DELETE     | `/api/threads/:id/attachments/:attachmentId` | Remove an eligible unsent attachment                                                         |
| GET        | `/api/files`                                 | `project` or `thread`, `mode=list/read/preview/download/diff`, `path`; lists accept `offset` |
| GET        | `/api/file-link`                             | `project` or `thread`, `target` link                                                         |
| GET        | `/api/file-search`                           | `project` or `thread`, `query`                                                               |

Example: `/api/files?project=PROJECT_ID&mode=preview&path=images%2Fsample.png`. Image previews return bytes with a MIME type, up to 20 MiB, for PNG/JPEG/GIF/WebP/AVIF/BMP/ICO/SVG. SVG includes a sandbox CSP. Text reads allow 2 MiB, directory pages 1,000 entries and individual attachments 20 MiB. Authentication and real-path boundaries still apply.

## Extensions, runtime and data

| Method             | Path                                              | Purpose                                                                 |
| ------------------ | ------------------------------------------------- | ----------------------------------------------------------------------- |
| GET / POST         | `/api/status` / `/api/connect`                    | Runtime snapshot / connect CLI (`{}`)                                   |
| GET                | `/api/account`, `/api/capabilities`               | Redacted account summary / CLI capabilities                             |
| GET / PUT          | `/api/skills`                                     | List, optionally with `project` / save a user Skill                     |
| GET / DELETE       | `/api/skills/:name/content` / `/api/skills/:name` | Read content / delete                                                   |
| POST               | `/api/skills/enabled`                             | `{path,enabled,project?}`                                               |
| GET / PUT / DELETE | `/api/mcp` / `/api/mcp` / `/api/mcp/:name`        | List / save / delete                                                    |
| GET / POST         | `/api/cli` / `/api/cli/update`                    | Current/latest version / `{version,confirm:true}`                       |
| GET                | `/api/usage`                                      | `since` in milliseconds, `project/thread` filters, `page` starting at 1 |
| GET / POST         | `/api/maintenance`                                | Statistics / `{action:"cache" or "logs",confirm:true}`                  |

Skill/MCP request schemas are in [server/extensions.ts](../../server/extensions.ts). Declared capabilities still require verification against the provider.

Migration flow: `GET /api/migration` for paths and format → multipart `POST /api/migration/preview` → review project mappings → `POST /api/migration/apply` with `{id,confirm:true,projects:{"project ID":"absolute target path"}}`. Success returns `{ok:true,backups}`; sign in again and reload snapshots. Up to three previews are retained for one hour and are lost on restart. Uploads allow 2 GiB. `DELETE /api/migration/:id` removes a preview. `POST /api/migration/export` returns a gzip archive, not JSON.

## WebSocket recovery

Authenticated clients connect to same-origin `/api/events?after=SEQ`, using `wss:` with HTTPS. The server sends:

```jsonl
{ "type": "hello", "reset": false, "cursor": 42, "status": {} }
{ "type": "event", "event": { "seq": 42, "method": "workbench/providerModelsUpdated", "params": { "providerId": "example-id" }, "at": 1791676800000 } }
{ "type": "synced", "cursor": 42 }
```

The example omits `status` fields. Live `event` messages continue afterward. Store the last processed sequence and pass it as `after` on reconnect. A first connection, expired/gapped cursor or replay exceeding 2,000 events produces `reset:true`; reload relevant snapshots and merge events received during loading. Completed items replace their streamed increments rather than being appended twice.

Expired sessions close with code 4001. Slow clients can receive 1013 and must resynchronize. Migration imports close connections and require login again. Reconnection restores observation state; it must not automatically resend messages, approvals or other mutations.

## Conversation content export

`GET /api/threads/:id/export?format=txt|markdown|html` requires the existing login cookie. It returns a UTF-8 attachment (`text/plain`, `text/markdown` or `text/html`), with `.txt`, `.md` or `.html` filename and `Cache-Control: no-store`. This is a single conversation content export, not a migration backup.

The server reads every native history page with full items, restores chronological order and removes overlapping turn IDs. It does not start a model turn or refresh balances. Invalid formats return 400, missing conversations 404, a concurrent export 429, and content above 64 MiB (or 10,000 history pages) 413. Pagination errors fail the request without returning a truncated attachment. A disconnected download cancels subsequent page reads; an in-flight native read may still complete.

## Queue editing and HTML previews

- `GET /api/queue/:id` returns `{id,threadId,text,revision,retainedParts}` for queued or paused messages. `text` is the full editable body, not the 300-character preview.
- `PATCH /api/queue/:id` accepts `{text,revision}` with at most 100000 text characters. It preserves non-body input parts and execution options. Missing, submitting or concurrently changed rows return 409; a text-only message cannot be saved empty. Saving keeps the row ID, creation time and state.
- `POST /api/html-preview` accepts `{project,path}` or `{thread,path}` and returns `{url}`. It requires login and the normal Origin check. Preview grants are held in memory, last one hour and are bounded to 64 active grants.
- `GET /api/html-preview/:token/*` serves allowed static resources beneath the authorized project. The unguessable grant and its original login session are checked on every request; frame asset requests do not need session cookies. Logout, password changes, expiration and service restart invalidate access. Responses use sandbox CSP, no-store caching and CORS for the opaque frame origin. Traversal, external symlinks, hidden paths and unsupported resource types are rejected. HTML is limited to 2 MiB; other allowed assets to 20 MiB.
