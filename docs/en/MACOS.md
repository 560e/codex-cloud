# macOS installation and background operation

[简体中文](../MACOS.md) · [Documentation](INDEX.md) · [Project home](../../README.en.md)

Local use is suitable for daily development. Background operation uses the logged-in user's LaunchAgent. For unattended availability without user login, choose an appropriate system-service deployment instead of relying on this user task.

## Local setup

Install Node 24+ for Apple Silicon or Intel, Git and a compatible CLI. In the source directory:

```bash
npm ci --include=dev
npm run password
chmod +x Start-Dev.command Start-Local.command
npm run dev
```

Open `http://127.0.0.1:18473`. For a build, run `npm run build` followed by `npm run start:local`. The `.command` launchers can be double-clicked; nvm users should launch from an initialized terminal to obtain the intended PATH.

## Install a background instance

Use the normal logged-in account, not sudo for the entire entry point:

```bash
bash install.sh --check
bash install.sh
```

The installer uses an existing or dedicated Node runtime and may prepare Git/Nginx through Homebrew. The default program directory is `~/codex-cloud`; generated `.env` defines actual data and CLI paths. Individual privileged steps request permission separately.

The backend task is `~/Library/LaunchAgents/com.codexcloud.workbench.plist`. It loads after login and does not guarantee service during sleep. Nginx is managed separately by Homebrew or an administrator.

## Inspect, stop and restore

```bash
launchctl print "gui/$(id -u)/com.codexcloud.workbench"
curl --fail http://127.0.0.1:18474/api/auth/status
```

When idle, restart a loaded service after configuration changes:

```bash
launchctl kickstart -k "gui/$(id -u)/com.codexcloud.workbench"
```

For upgrades/offline backups, unload it to prevent KeepAlive restarts, then reload:

```bash
launchctl bootout "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.codexcloud.workbench.plist"
# After maintenance
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.codexcloud.workbench.plist"
```

Standard output/error go to `server.out.log` and `server.err.log` in the data directory; executor diagnostics are under `DATA_DIR/logs`. When terminal execution works but background startup fails, inspect the plist's Node path, working directory, PATH and directory permissions.

## HTTPS and OS permissions

See [Installer](INSTALL.md) for site/certificate modes. Renewal uses `com.codexcloud.certificate.plist`. Reloading root-managed Nginx still requires administrator permission; a user LaunchAgent cannot assume it.

macOS may impose extra restrictions on Desktop, Documents or external disks. Store projects where the background account has stable access, and verify reads, writes and tools in that execution context. Repeat [platform acceptance](VALIDATION.md) after OS, Node-path or CLI changes.
