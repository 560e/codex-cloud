# Development guide

[简体中文](../RD.md) · [Documentation](INDEX.md) · [Project home](../../README.en.md)

Prepare Node 24+, dependencies, a website password and an isolated project using [Local use](LOCAL.md). The development command starts Vite and the backend together. Tests must not target production data or projects.

## Commands

| Command                                   | Purpose and prerequisites                                    |
| ----------------------------------------- | ------------------------------------------------------------ |
| `npm run dev`                             | Vite on 18473 and backend on 18474, with development reloads |
| `npm run typecheck`                       | Frontend/shared and server TypeScript checks                 |
| `npm run format` / `npm run format:check` | Format / check formatting                                    |
| `npm test`                                | Unit and integration tests in `tests/*.test.ts`              |
| `npm run build`                           | Type checking, Vite build and server compilation             |
| `npm run test:e2e`                        | Playwright tests; requires a build and Chromium              |
| `npm run check`                           | Types, formatting and unit/integration tests                 |
| `npm run verify`                          | Check, build and browser tests                               |

Install the browser with `npx playwright install chromium`. On Linux, have an administrator install missing system libraries as required by Playwright. The fixture uses port 18479, a mock CLI and `.test-data`; it does not reuse an existing service on that port.

## Code navigation

| Change                            | Entry points                                                                                                                                                       |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Conversations and streaming state | [src/App.tsx](../../src/App.tsx), [shared/events.ts](../../shared/events.ts), [src/event-batch.ts](../../src/event-batch.ts)                                       |
| Composer, drafts and references   | [src/ComposerInput.tsx](../../src/ComposerInput.tsx), [src/drafts.ts](../../src/drafts.ts)                                                                         |
| Settings and providers            | [src/settings/](../../src/settings/), [src/ProviderSettings.tsx](../../src/ProviderSettings.tsx), [server/providers.ts](../../server/providers.ts)                 |
| Files and images                  | [src/files/](../../src/files/), [server/files.ts](../../server/files.ts), [shared/image-preview.ts](../../shared/image-preview.ts)                                 |
| API and scheduling                | [server/app.ts](../../server/app.ts), [server/management-api.ts](../../server/management-api.ts), [server/workbench.ts](../../server/workbench.ts)                 |
| CLI protocol                      | [server/codex.ts](../../server/codex.ts), [shared/protocol.ts](../../shared/protocol.ts), [tests/mock-codex.ts](../../tests/mock-codex.ts)                         |
| Storage and migration             | [server/store.ts](../../server/store.ts), [server/migration.ts](../../server/migration.ts)                                                                         |
| Installation and packaging        | [scripts/install/](../../scripts/install/), [scripts/package-clean.py](../../scripts/package-clean.py), [scripts/package-baota.py](../../scripts/package-baota.py) |

See [Architecture](ARCHITECTURE.md) for boundaries and execution constraints.

## Feature workflow

1. Define the trigger, inputs, persisted state and failure behavior. For example, a failed catalog fetch must preserve the previous list rather than overwrite it with an empty array.
2. Update boundary schemas and shared types before service/UI code when external inputs change. Represent loading, success, empty and error states explicitly.
3. Check concurrency, restart and disconnect behavior. Do not handle uncertain task starts, approvals or imports through automatic resubmission.
4. Select tests that cover observable behavior changes, run affected checks and complete required repository validation.
5. Update both documentation languages and `.env.example`. Derive defaults from code and distinguish deployment recommendations.

API changes require reviewing authentication, Origin, limits, response contracts and events. Persistent changes require existing-database upgrades, old-data reads, backup and restore behavior. Keep provider keys out of logs, responses and command-line arguments. UI changes require desktop/mobile layout, both themes, keyboard focus and draft retention checks.

## Targeted verification

Providers and proxy behavior:

```bash
npx tsx --test tests/providers.test.ts tests/proxy.test.ts
npm run build
npx playwright test tests/e2e/providers.spec.ts
```

Files and images:

```bash
npx tsx --test tests/image-preview.test.ts tests/file-links.test.ts tests/files.test.ts
npm run build
npx playwright test tests/e2e/image-preview.spec.ts tests/e2e/file-links.spec.ts tests/e2e/changes.spec.ts
```

Mocks do not establish upstream compatibility or operating-system sandbox behavior. Follow [Testing and acceptance](VALIDATION.md) for CLI/provider/platform changes. Do not skip relevant failures or embed development-machine paths to obtain a passing result.

## Commits and documentation

Describe the observable problem, resulting behavior and checks actually performed. Identify unverified platforms. Exclude builds, runtime logs, real `.env` files, credentials, test outputs and one-off repair scripts from commits.

Organize documentation by reader task: README for entry points, Configuration for variables, platform guides for installation and Operations for recovery. State command directories, accounts and prerequisites. Keep constraints and examples aligned across languages; avoid turning conversational diaries or temporary test counts into permanent product claims.
