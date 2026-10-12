# Testing and acceptance

[简体中文](../VALIDATION.md) · [Documentation](INDEX.md) · [Project home](../../README.en.md)

This page defines reproducible checks and acceptance criteria, not the result of a particular run. Record code version, environment, commands, passes/failures and unverified scope for each release. Historical test counts do not describe the current state.

## Automated verification

Use an isolated source checkout with Node 24+:

```bash
npm ci --include=dev
npm run check
npm run build
npx playwright install chromium
npm run test:e2e
```

With browsers already prepared, `npm run verify` runs check, build and e2e. Linux may require Playwright system dependencies. Fixtures use `.test-data`, port 18479 and a mock CLI; ensure no other service occupies the port.

| Layer                        | Evidence provided                                               | What it does not establish               |
| ---------------------------- | --------------------------------------------------------------- | ---------------------------------------- |
| Types and formatting         | Type contracts and formatting rules                             | Runtime or upstream availability         |
| Unit/integration tests       | Tested storage, boundaries, protocol, queues and provider logic | Compatibility with every OS/CLI version  |
| Browser tests                | User flows and state rendering against a mock executor          | Real models, TLS or service installation |
| Real CLI/provider acceptance | Complete requests and tools in the tested environment           | Other providers/platforms also passing   |

See [Development](RD.md) for targeted commands. Preserve failure reproduction details and relevant logs. Browser traces/screenshots belong in test outputs, outside the source repository.

## Behavioral acceptance

| Area                   | Action and expected result                                                                                                                                                                                                          |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authentication         | No default password; protected routes reject anonymous users; wrong-Origin mutations fail; password changes invalidate sessions                                                                                                     |
| Projects/conversations | Path permissions/boundaries apply; removing projects preserves files; permanent conversation deletion requires confirmation                                                                                                         |
| Execution              | Same/cross-project conversations run concurrently; pending starts count toward capacity; each conversation stays serial; queues use freed slots; uncertain responses never trigger duplicate starts                                 |
| Queues                 | Normal completion advances; failure, interruption and restart pause; manual resume does not duplicate tasks                                                                                                                         |
| Interactions           | Command/file/permission approvals and questions render fully; accepted answers cannot take effect twice                                                                                                                             |
| Reconnection           | Tasks continue; restored history has no duplication/loss; expired cursors trigger snapshots                                                                                                                                         |
| Files                  | Traversal, external symlinks and Git internals are constrained; read/upload limits apply                                                                                                                                            |
| Images/layout          | Desktop/mobile preview, zoom, close and focus restoration work; damaged/oversized images show useful errors                                                                                                                         |
| Providers              | Saved keys are not returned; activation requires idle; executor startup failures have rollback handling                                                                                                                             |
| Catalog fetching       | Only explicit fetch contacts upstream; success persists and updates menus; reload/restart do not refresh; failures preserve list/time                                                                                               |
| Proxy                  | Backend requests use the proxy after `.env` loads; environment precedence and NO_PROXY work; verify real CLI requests separately                                                                                                    |
| Migration              | Validate and map before applying; database, attachments, keys and supported native history restore correctly                                                                                                                        |
| Project context        | 1M off by default; slider works and persists without 1M; five 50%–90% stops with correct token counts; persistence and migration restore settings; creation/resume/fork/queues use the owning project without cross-project leakage |

Catalog tests should also cover empty catalogs, duplicate IDs, limits, malformed responses, incomplete pages, concurrent fetches and changes/deletion during requests. Use isolated mocks for these boundaries rather than sending batches of deliberately failing requests to real providers.

## Real CLI and model verification

Prepare a dedicated project and credentials, using the same account, CLI path and environment as the service:

```bash
npm run doctor
npm run smoke:codex
```

`doctor` does not send a model task. `smoke:codex` calls a real model in an ephemeral read-only conversation for a simple round trip and can incur usage. Both use CLI configuration directly; neither loads the active custom provider from the workbench database, so neither replaces UI acceptance.

Activate the target provider in the website, send a message and inspect streaming. Then verify tools, approvals, interruption and history recovery inside the dedicated project. If a proxy is required, test through the actual service-process environment. Catalog and balance success are insufficient acceptance criteria.

## Deployment and platform acceptance

- The HTTPS URL matches `PUBLIC_ORIGIN`; login, cookies and WebSocket work.
- A task can finish after the browser closes, and reopening restores state correctly.
- The service account accesses project/data/CLI/Skills paths and the actual sandbox behaves as expected.
- Verify Linux startup after reboot, Windows behavior after logout/reboot, and macOS after user login according to the selected service mode. A macOS user LaunchAgent does not guarantee service before login or during sleep.
- Restore a backup to an isolated target, verify paths, attachments, history and provider decryption, then run a task.

Linux results do not establish Windows/macOS support. Mock results do not establish real-provider compatibility. The project offers no hardware-independent performance SLA.

## Release evidence

Record commit/package digest, date, OS/architecture, Node/CLI versions, commands, pass/fail results, provider type, deployment/restore verification and known limits. Redact keys, cookies, user content and private paths in logs. Put product behavior changes in the [Changelog](RELEASE.md); keep execution evidence in release records or CI results.
