# Local use and development

[简体中文](../LOCAL.md) · [Documentation](INDEX.md) · [Project home](../../README.en.md)

Use this guide to run the workbench on your computer. Public hosting follows [Production deployment](DEPLOYMENT.md). Development mode uses the real CLI and provider; automated tests use a separate mock environment.

## 1. Prepare tools

Install Node.js 24+ with npm, Git, and your project's toolchain. From the repository root:

```bash
node --version
npm --version
npm install -g @openai/codex@0.159.3
codex --version
npm ci --include=dev
```

Skip global CLI installation if a compatible version exists. On Windows, use `npm.cmd` if PowerShell blocks `npm.ps1`. Do not copy `node_modules` across operating systems.

## 2. Choose data storage and set a password

A fresh checkout uses defaults and writes data to `./data`. To isolate development data, create `.env` **before** setting the password:

```dotenv
HOST=127.0.0.1
PORT=18474
PUBLIC_ORIGIN=http://127.0.0.1:18473
COOKIE_SECURE=false
TRUST_PROXY=false
DATA_DIR=./data/development
```

```bash
npm run password
```

Input is hidden and entered twice. The command operates on the current `DATA_DIR`. If startup still reports an unconfigured password, check that both commands use the same working directory and settings. Resetting the password revokes existing logins.

## 3. Choose a launch mode

| Mode        | Command                                     | Address                             | Use                                                |
| ----------- | ------------------------------------------- | ----------------------------------- | -------------------------------------------------- |
| Development | `npm run dev`                               | `http://127.0.0.1:18473`            | Live editing; Vite 18473 proxies to backend 18474  |
| Local build | `npm run build`, then `npm run start:local` | `http://127.0.0.1:18473`            | Everyday use; backend serves built assets directly |
| Production  | `npm start`                                 | Defined by `.env` and reverse proxy | Background hosting                                 |

Run only one mode at a time. Stop with `Ctrl+C`; closing the browser does not stop the backend or active tasks.

Windows shortcuts are `Start-Dev.bat` and `Start-Local.bat`; macOS uses the corresponding `.command` files. They do not install dependencies, build or initialize a password. On macOS, run `chmod +x Start-Dev.command Start-Local.command` if needed.

## 4. Complete a first task

1. Sign in with the website password.
2. Add an existing project directory accessible to the current account.
3. Save a provider, fetch its models and activate it, or verify the default CLI configuration.
4. Start with a simple read-only task and confirm streaming, tool output and completion.

A conversation with failed model calls points to provider/network settings. Tools unable to read files point to paths or execution permissions. Neither is established merely by a successful website login.

## Troubleshooting

| Symptom                                | Action                                                                                       |
| -------------------------------------- | -------------------------------------------------------------------------------------------- |
| `EADDRINUSE`                           | Stop existing development/local/background instances; inspect ports 18473 and 18474          |
| Login or WebSocket origin errors       | Use the configured origin consistently; do not alternate between `localhost` and `127.0.0.1` |
| Built version ignores edits            | Stop the old process, rebuild, then restart                                                  |
| Startup fails after dependency changes | Run `npm ci --include=dev` in this directory                                                 |
| Finder cannot find Node                | Run `bash Start-Dev.command` in a terminal with nvm/Homebrew initialized                     |
| CLI unavailable                        | Check `codex --version` as the workbench account; set `CODEX_BIN` if required                |

See [Configuration](CONFIGURATION.md) for variables and [Development](RD.md) for contribution checks.
