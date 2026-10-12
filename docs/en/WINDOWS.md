# Windows installation and background operation

[简体中文](../WINDOWS.md) · [Documentation](INDEX.md) · [Project home](../../README.en.md)

Windows supports terminal-based local use and scheduled-task background operation. File permissions, CLI configuration and Windows task credentials are separate from the website password.

## Local use

Install Node 24+, Git and a compatible CLI, then enter the checkout:

```powershell
Set-Location 'D:\Projects\codex-cloud'
node --version
codex --version
npm.cmd ci --include=dev
npm.cmd run password
npm.cmd run dev
```

Open `http://127.0.0.1:18473`. For a local build, run `npm.cmd run build`, then `npm.cmd run start:local`. Root-level `.bat` launchers are shortcuts, not replacements for initial installation/build.

## Background operation with the installer

```powershell
Set-Location 'D:\Services\codex-cloud'
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 --check
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

Choose application/data paths, reverse-proxy mode, domain and certificates. Supply the selected Windows account's task credentials when registering background operation. That account must access Node, CLI, data and projects; another user's PATH or authentication directory is insufficient.

The installer uses task name `CodexCloud`. Public mode normally exposes Nginx on 443 with a backend at `127.0.0.1:18474`. `skip` mode uses loopback 18474, unlike the local shortcuts on 18473.

```powershell
Get-ScheduledTask -TaskName CodexCloud
Get-ScheduledTaskInfo -TaskName CodexCloud
Start-ScheduledTask -TaskName CodexCloud
curl.exe --fail http://127.0.0.1:18474/api/auth/status
```

Verify the task and local endpoint before HTTPS, login and a real task. Inspect triggers and “run whether user is logged on or not” settings. Test an actual logout/reboot to confirm the intended behavior.

## Configuration and maintenance

Edit `.env` in the program directory; prefer paths such as `D:/CodexCloud/data`. Wait for idle state, stop the task and confirm its Node/CLI children exit before updating:

```powershell
Stop-ScheduledTask -TaskName CodexCloud
# After updating configuration/program files
Start-ScheduledTask -TaskName CodexCloud
```

Closing a browser does not stop tasks. Update scheduled-task credentials after changing the Windows account password. Backend logs normally live in `DATA_DIR/logs`; installer logs are in `.installer/install.log`. See [Operations](OPERATIONS.md) for backups and upgrade procedures.

## Optional existing Caddy workflow

The repository also retains a Caddy launcher for supplied PEM certificates. Preinstall Node/npm, CLI and Caddy, and manage certificate renewal separately:

```powershell
.\scripts\Install-Workbench.ps1 -PublicOrigin 'https://codex.example.com:18473' `
  -TlsCert 'D:\Certificates\fullchain.pem' -TlsKey 'D:\Certificates\privkey.pem'
.\scripts\Start-Workbench.ps1 -CaddyBin 'C:\Tools\caddy.exe'
```

After verifying and stopping the manual instance, register its task:

```powershell
.\scripts\Register-Startup.ps1 -CaddyBin 'C:\Tools\caddy.exe'
Start-ScheduledTask -TaskName CodexPrivateWorkbench
```

This flow uses task name `CodexPrivateWorkbench` and public port 18473 in the example. Do not run both flows against the same backend port. Existing `.env` is retained; new files preserve template comments.

## Troubleshooting

Use `npm.cmd` when PowerShell blocks `npm.ps1`. If the task runs but the site is unreachable, test the loopback backend before the reverse proxy and firewall. If the CLI works in a terminal but fails in a scheduled task, compare accounts, PATH, `CODEX_BIN` and `CODEX_HOME` first.
