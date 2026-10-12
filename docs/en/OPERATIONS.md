# Operations

[简体中文](../OPERATIONS.md) · [Documentation](INDEX.md) · [Project home](../../README.en.md)

Before maintenance, identify the actual application directory, service account, `DATA_DIR`, `CODEX_HOME` and project roots. A source checkout may differ from the running installation. These systemd examples use `codex-cloud`; see [Windows](WINDOWS.md) and [macOS](MACOS.md) for their service commands.

## Health and logs

```bash
systemctl status codex-cloud --no-pager
journalctl -u codex-cloud -n 80 --no-pager
curl --fail http://127.0.0.1:18474/api/auth/status
```

`configured: true` means a website password exists; it does not verify the CLI or provider. Check backend response → HTTPS login → WebSocket → CLI → a real model task.

Service output goes to the journal. CLI diagnostics are in `DATA_DIR/logs/codex-diagnostic.log`. Application file logs rotate at 10 MiB with five retained files and a 14-day/256 MiB maintenance budget; reverse-proxy logs are managed separately. Inspect diagnostics for project content and private paths before sharing them.

Run `npm run doctor` from the application directory using the service account and environment. It checks CLI startup and model/account/history reads without sending a model task. It uses CLI configuration, so it is not a complete test of the active custom provider stored in the workbench database.

## Check or disable the outbound proxy

See [Configuration](CONFIGURATION.md) for variables. First test network connectivity without a key:

```bash
curl --proxy http://proxy.example.com:3128 --noproxy '' \
  --head --connect-timeout 10 --max-time 20 https://provider.example.com/
```

CONNECT 200 establishes a tunnel only. An upstream 401/403/404 can establish reachability, but not authentication or model access. After restarting, fetch models and run a real task through the UI to check the complete route.

If editing `.env` has no effect, locate service overrides:

```bash
systemctl show codex-cloud -p ActiveState -p MainPID -p DropInPaths
```

Check service variables and lowercase proxy variables. The process environment overrides identical `.env` names; lowercase proxy variables take precedence. Restart after editing `.env`. Run `daemon-reload` only when the systemd unit or a drop-in changed.

To disable the proxy, remove `HTTP_PROXY`, `HTTPS_PROXY` and lowercase equivalents from both `.env` and the service environment. Check `ALL_PROXY`, which some child tools read. Preserve unrelated settings, reload changed service configuration and restart. `NODE_USE_ENV_PROXY=0` alone does not disable the proxy configured by this application. Proxy failures do not trigger direct-connection retries.

## Backup scope and offline export

| Content                                                                     | Migration archive                      |
| --------------------------------------------------------------------------- | -------------------------------------- |
| Workbench database, attachments and provider encryption material            | Included                               |
| Supported CLI configuration, authentication, native history and user Skills | Included; review warnings and manifest |
| Project sources, Git repositories and uncommitted changes                   | Separate backup required               |
| Application `.env`, service units, reverse-proxy and TLS configuration      | Separate backup required               |
| Node, CLI binaries, dependencies and build outputs                          | Reinstall using recorded versions      |

Archives contain credentials and belong in restricted storage. Copying only a live SQLite main file can omit WAL data; `providers.key` is also needed. Use application backups or consistent directory backups after all relevant processes stop.

Wait for tasks, approvals and queues to become idle, then stop the service:

```bash
sudo systemctl stop codex-cloud
```

As the service account, enter the running application directory and load the same configuration as the service. The example backup directory must be writable and access-restricted:

```bash
cd /opt/codex-cloud
npm run backup -- /protected/backups/codex-cloud-before-upgrade.tar.gz
npm run migrate -- inspect /protected/backups/codex-cloud-before-upgrade.tar.gz
```

These scripts require an existing `dist` build. The archive destination must not exist. Review file counts, warnings, project entries and original paths, then copy the archive to separate storage. For a backup-only operation, restart the service and check health afterward. Online export is available under Settings → Extensions and migration and is coordinated by the backend maintenance lock.

## Restore or migrate

1. Install Node/CLI, prepare a compatible application version and build it.
2. Copy project sources separately, including required uncommitted changes. Prepare account permissions, `.env` and HTTPS.
3. Inspect the archive and create a mapping from project IDs to new absolute paths. IDs come from the `inspect` output's `mapping` field, not display names.
4. Stop the target service, back up its existing state and import as its service account.

Example `mapping.json`:

```json
{ "project-id-from-inspect": "/srv/projects/my-app" }
```

```bash
npm run migrate -- import /protected/backups/codex-cloud-before-upgrade.tar.gz \
  --mapping /protected/backups/mapping.json \
  --data-dir /var/lib/codex-cloud/data \
  --codex-home /var/lib/codex-cloud/.codex \
  --skills-home /var/lib/codex-cloud/.agents/skills
```

Explicit paths must match the target service. Data, CLI and Skills directories cannot contain one another. Mapping paths does not transfer project files. Record returned backup paths, start the service after success and sign in using the archived website password. Verify history, attachments, providers and project paths, then run a test task.

Web imports also require upload validation, path mapping and confirmation. Previews expire after one hour or a restart. Uploads are limited to 2 GiB and require compatible reverse-proxy limits. Do not remove the data lock to bypass a running instance.

## Upgrade and rollback

1. Record the current code, Node/CLI versions and configuration locations. Install dependencies, check and build the new version in a separate directory.
2. Wait for idle, back up application data, project files and configuration, then stop the service.
3. Update the program and dependencies while preserving `.env`, data and permissions. Use `npm ci --include=dev`; do not copy `node_modules` across operating systems.
4. Publish matching frontend/backend builds. When replacing static files in place, copy new assets first, switch `index.html` last and temporarily retain old hashed assets for open pages.
5. Restart and verify HTTPS, login, live events, history, attachments and a real task.

Before rolling back, establish whether the old program can read the upgraded data format. If uncertain, stop the service and restore the old program with its matching pre-upgrade data. This discards later data, so preserve the current state first. Updating a source checkout is not deployment.

## Passwords, cleanup and diagnosis

To reset a forgotten website password, run `npm run password` as the service account in the actual application directory. This revokes previous logins. Do not delete the database or independently remove `providers.key`.

Cache cleanup does not delete CLI native history or compact model context. Log cleanup does not remove reverse-proxy logs. Permanent conversation deletion is a separate operation.

| Symptom                        | Check in order                                                        |
| ------------------------------ | --------------------------------------------------------------------- |
| Reverse-proxy 502              | Backend state → listening port → proxy target → logs                  |
| Login or WebSocket failure     | Actual Origin → Secure Cookie → HTTPS → Upgrade headers               |
| CLI disconnected               | Account → Node/CLI path → HOME/CODEX_HOME → diagnostics               |
| Data directory busy            | Another instance or surviving process; confirm exit before restarting |
| Switching/maintenance conflict | Active tasks, approvals, queues and maintenance operations            |
| Missing history                | Correct CODEX_HOME and restored native history                        |
| Image unavailable              | Permissions, format, 20 MiB limit and browser decoding                |
