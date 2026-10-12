# Installer reference

[简体中文](../INSTALL.md) · [Documentation](INDEX.md) · [Project home](../../README.en.md)

The installer prepares runtime tools, application files, a website and background services for long-lived instances. Run it from a complete source directory; downloading only the entry script is insufficient. Use [Local use](LOCAL.md) for live development.

## Inspect and run

```bash
# Linux / macOS: inspect without changing the system
bash install.sh --check
bash install.sh --dry-run

# Linux installation
sudo bash install.sh

# macOS installation: logged-in user
bash install.sh
```

```powershell
# Windows
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 --check
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

`--check` and `--dry-run` currently inspect the existing environment and describe the workflow; neither installs dependencies nor starts services. Without suitable Node, check mode reports requirements. Normal installation can download a dedicated runtime and verify SHA-256.

## Installation workflow

1. Inspect OS, architecture and Node/npm; choose the download network.
2. Select program/data directories, port and site mode; read existing configuration.
3. Check active tasks/instances and stop a manageable idle service where requested.
4. Prepare CLI, Git/Nginx, dependencies and the application build.
5. Create annotated `.env`; initialize a password only when none exists.
6. Generate proxy configuration and reuse certificates or perform ACME HTTP-01.
7. Register platform services/renewal tasks and check the backend and HTTPS.

Logs are in `.installer/install.log`, with state in `.installer/state.json` under the target directory. After interruption, inspect logs and service state before fixing and rerunning. The installer is not a transactional rollback system for every OS change.

## Options

Use `--name=value`; boolean flags have no value.

| Option                                | Purpose                                                        |
| ------------------------------------- | -------------------------------------------------------------- |
| `--prefix=path`                       | Target program directory                                       |
| `--data=path`                         | Persistent data directory                                      |
| `--port=18474`                        | Loopback backend port, installer range 1024–65535              |
| `--network=cn\|global\|custom`        | Download network                                               |
| `--registry=https://...`              | Custom npm registry                                            |
| `--mode=auto\|manual\|skip`           | Automatic site, template only, or local HTTP                   |
| `--domain=codex.example.com`          | Public domain without scheme/path                              |
| `--cert=path --key=path`              | Existing certificate chain and key, provided together          |
| `--email=address --accept-acme-terms` | Email and terms acceptance for automatic certificates          |
| `--nginx-site-dir=path`               | Nginx site configuration directory                             |
| `--no-service`                        | No background/renewal registration; manage these yourself      |
| `--update-config`                     | Back up and update existing website/path settings              |
| `--replace-site`                      | Replace an existing site file owned by this installation flow  |
| `--stop-existing`                     | Stop an existing systemd service after idle checks             |
| `--noninteractive`                    | Noninteractive mode; initial password via `WORKBENCH_PASSWORD` |
| `--acme-staging`                      | ACME test environment; certificates are not browser-trusted    |

Automatic mode targets a new independent site. If another tool owns the same domain, choose `manual`. Its output, `deploy/nginx-codex-cloud.conf`, still needs administrator activation. `skip` omits public HTTPS and uses the loopback backend port; the current workflow still inspects Nginx and generates a template.

## Downloads and platforms

Bootstrap pins Node `24.21.0`, and CLI installation pins `0.159.3`; compatible existing tools may be reused. `cn` uses npmmirror and `global` official sources. Registry selection does not alter global npm settings. See [Configuration](CONFIGURATION.md) for runtime-directory and mirror variables.

Linux bootstrap requires supported x64/ARM64 binaries and glibc ≥ 2.28; this download path is unsuitable for CentOS 7 or Alpine/musl. macOS uses the logged-in account and Homebrew for Git/Nginx. Windows uses dedicated Node/Nginx directories and can prepare Git via winget.

An npm mirror does not proxy GitHub, certificate services or model providers. Those endpoints need their own connectivity. Application `.env` proxies are not a universal installer-network setting.

## Certificates and existing settings

ACME HTTP-01 requires correct domain A/AAAA records and public port 80; HTTPS uses 443. Supplied certificates remain the responsibility of their existing renewal system. Automatic renewal checks expiry and attempts renewal below 30 days. A macOS user task cannot assume permission to reload root-owned Nginx.

An existing `.env` can be retained; explicit updates create a backup first. Program upgrades should not recreate data directories or reset passwords. Follow the [backup and maintenance procedure](OPERATIONS.md) before updating a production instance.
