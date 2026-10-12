# Configuration reference

[简体中文](../CONFIGURATION.md) · [Documentation](INDEX.md) · [Project home](../../README.en.md)

Runtime configuration belongs in `.env` in the application's working directory. The repository contains only annotated [general](../../.env.example) and [Linux](../../deploy/linux.env.example) templates. Actual `.env` files are not source files.

## Location and precedence

The backend loads `.env` through `dotenv` at startup. Existing process variables with the same name take precedence. The systemd `WorkingDirectory`, Windows application directory or LaunchAgent working directory determines which file is read.

If source is at `~/projects/codex-cloud` and the service runs at `/opt/codex-cloud`, edit the latter. Restart the backend after changes; refreshing a page or switching providers does not reload environment settings. Editing `.env` does not require `systemctl daemon-reload`; changing a systemd unit or drop-in does.

`npm run start:local` forces loopback HTTP on port 18473 while retaining data, CLI and proxy settings. Development mode does not replace a production `.env` automatically.

## Listener and website

Defaults below are **code defaults when a variable is absent**, not necessarily values in the HTTPS deployment templates.

| Variable        | Default                  | Meaning and constraints                                                          |
| --------------- | ------------------------ | -------------------------------------------------------------------------------- |
| `HOST`          | `127.0.0.1`              | Node listener; keep loopback for a local reverse proxy                           |
| `PORT`          | `18474`                  | Backend port, integer 1–65535                                                    |
| `PUBLIC_ORIGIN` | `http://127.0.0.1:18473` | Browser origin; scheme, host and port must match actual access                   |
| `COOKIE_SECURE` | `false`                  | String `true/false`; must be `true` for HTTPS                                    |
| `TRUST_PROXY`   | `false`                  | Trusts loopback reverse-proxy headers when `true`; unrelated to outbound proxies |

Public origins require HTTPS and Secure cookies. A domain, an IP, `localhost` and `127.0.0.1` are different origins. Omit standard port 443 or include any nonstandard port explicitly.

## Data, CLI and resources

| Variable                  | Default                              | Meaning and constraints                                                                                              |
| ------------------------- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `DATA_DIR`                | `./data`                             | SQLite, uploads, provider encryption key and logs; relative to the working directory                                 |
| `CODEX_BIN`               | Auto-detected                        | CLI entry point; an installed workbench-managed CLI may take precedence                                              |
| `CODEX_HOME`              | CLI default                          | CLI configuration, authentication and native history; use the intended service account                               |
| `CODEX_CLOUD_SKILLS_HOME` | Service account's `~/.agents/skills` | User Skills storage and migration path; verify CLI discovery separately when overriding                              |
| `PROJECT_ROOTS`           | Working directory's filesystem root  | Allowed project parent directories; semicolon-separated; an explicit empty value removes root restrictions           |
| `MAX_CONCURRENT_TURNS`    | `3`                                  | Instance concurrency, integer 1–16; same/cross-project conversations run in parallel, each conversation stays serial |
| `SESSION_DAYS`            | `7`                                  | Remembered-login lifetime, integer 1–90 days; ordinary sessions last 12 hours                                        |
| `EVENT_RETENTION_DAYS`    | `7`                                  | Event replay retention, integer 1–30 days; not native conversation retention                                         |

Prefer forward slashes in Windows paths, such as `D:/Projects`. Quote values containing spaces or `#`. The service account needs write access to data and appropriate access to projects/CLI. `PROJECT_ROOTS` controls project selection; it does not replace OS permissions or executor sandboxing.

The Skills directory setting from before the rename remains readable; `CODEX_CLOUD_SKILLS_HOME` takes precedence. Keep the existing directory during an upgrade, then switch the variable name in `.env` when convenient.

## Outbound proxies

```dotenv
HTTP_PROXY=http://proxy.example.com:3128
HTTPS_PROXY=http://proxy.example.com:3128
NO_PROXY=localhost,127.0.0.1,::1,[::1]
```

Use your own HTTP/HTTPS proxy. `HTTPS_PROXY` chooses a proxy for HTTPS destinations; it does not require an HTTPS proxy URL. Keep `http://` for an HTTP CONNECT proxy.

The backend configures `fetch` after reading `.env`; provider subprocesses inherit the same environment. Model discovery, balances and CLI update metadata use it. Child tools honor proxies only if they support these variables. `NODE_USE_ENV_PROXY=1` is unnecessary.

Lowercase `http_proxy/https_proxy/no_proxy` are supported and preferred by the backend; avoid conflicting values. Set both HTTP and HTTPS variables to avoid client-specific fallback differences. This configuration entry accepts HTTP/HTTPS proxies, not SOCKS URLs.

`NO_PROXY` is a comma-separated list of direct hosts. Retain loopback entries and add internal providers as needed. To disable proxying, check `.env`, service variables and lowercase equivalents. `NODE_USE_ENV_PROXY=0` alone does not disable this application's initialization. Existing `ALL_PROXY` may still affect the CLI or child tools.

## Per-project context settings

The Add project slider is independent of the 1M checkbox. It accepts 50, 60, 70, 80 or 90 (default 90), stored in SQLite rather than `.env`. Every indexed project passes `model_post_turn_compact_threshold_percent` to the CLI: after a final response, the CLI checks the selected percentage of the current model's usable context window. Native compaction safeguards still apply and may trigger earlier. Changing models does not require a hardcoded capacity table.

Enabling 1M additionally sets `model_context_window=1000000` and `model_auto_compact_token_limit=1000000×percentage/100`; at 70%, the latter is 700000 tokens. The UI shows this token limit only with 1M enabled. Without 1M, it retains the CLI's window and token-limit configuration, while still applying the percentage.

These per-thread overrides apply on creation, resume, fork and queued execution without rewriting global `config.toml`. Existing indexed projects default to 1M off and 90%; conversations outside indexed projects retain CLI defaults. The percentage setting is verified against CLI 0.159.3 and its upstream 0.159.0 configuration schema; older CLIs may ignore it and should be upgraded. Models and providers must actually support the selected window.

## Installation and special launch variables

| Variable                          | Consumer                    | Purpose                                                                       |
| --------------------------------- | --------------------------- | ----------------------------------------------------------------------------- |
| `WORKBENCH_PASSWORD`              | Password script/installer   | Noninteractive website password; inject temporarily rather than committing it |
| `CADDY_TLS_CERT`, `CADDY_TLS_KEY` | Windows Caddy launcher      | Paths to existing PEM certificate/private key                                 |
| `CODEX_CLOUD_INSTALL_NETWORK`     | Installer entry point       | `cn/global/custom` download network                                           |
| `CODEX_CLOUD_NODE_MIRROR`         | Installer entry point       | Custom HTTPS Node download source                                             |
| `CODEX_CLOUD_RUNTIME_DIR`         | Installer entry point       | Dedicated Node runtime directory                                              |
| `CODEX_CLOUD_FORCE_NODE`          | Linux/macOS installer entry | `1` forces a dedicated Node runtime                                           |

Provider keys are managed in the website and encrypted in the database. An arbitrary `API_KEY` variable is not a provider configuration interface. See [Providers](PROVIDERS.md).
