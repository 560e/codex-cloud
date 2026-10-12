# Linux deployment

[简体中文](../LINUX.md) · [Documentation](INDEX.md) · [Project home](../../README.en.md)

For Linux hosts using systemd. Examples use `/opt/codex-cloud`, account `codexcloud`, and `/var/lib/codex-cloud/data`. Existing installations should retain their actual accounts and paths.

## Option A: installer

From a complete checkout, inspect the environment before installing:

```bash
bash install.sh --check
sudo bash install.sh
```

Check mode installs nothing. Installation prepares selected Node/npm, CLI, Git/Nginx, builds, password and `codex-cloud.service`. For an existing website or certificate, choose `manual` and integrate through [BT Panel](BAOTA.md) or your reverse-proxy manager. See [Installer](INSTALL.md) for flags and certificate handling.

## Option B: manual installation

### 1. Account and tools

Install Node 24+, npm, Git and a compatible CLI. Node must provide `node:sqlite`; the CLI must support App Server:

```bash
node --version
node -e "require('node:sqlite')"
codex --version
command -v node
command -v codex
```

The service cannot use binaries accessible only under `/root`. For a custom tool installation, set actual paths in the service and `CODEX_BIN`.

Create the dedicated account/directories on first installation:

```bash
id codexcloud || sudo useradd --system --create-home \
  --home-dir /var/lib/codex-cloud --shell /usr/sbin/nologin codexcloud
sudo install -d -o codexcloud -g codexcloud -m 0750 \
  /opt/codex-cloud /var/lib/codex-cloud/data /srv/projects
```

Copy the clean source into `/opt/codex-cloud`, owned by `codexcloud`. Set ownership only on application/dedicated data directories; do not recursively change unrelated project ownership.

### 2. Dependencies, build and configuration

Run as the service account, with Node/npm available on its PATH:

```bash
sudo -u codexcloud -H sh -c 'cd /opt/codex-cloud && npm ci --include=dev && npm run build'
sudo -u codexcloud cp /opt/codex-cloud/deploy/linux.env.example /opt/codex-cloud/.env
sudo chmod 600 /opt/codex-cloud/.env
sudoedit /opt/codex-cloud/.env
```

Copy the template only on first installation; do not overwrite an existing `.env`. Review `PUBLIC_ORIGIN`, `CODEX_BIN`, `CODEX_HOME`, `DATA_DIR` and `PROJECT_ROOTS`. See [Configuration](CONFIGURATION.md).

```bash
sudo -u codexcloud -H sh -c 'cd /opt/codex-cloud && npm run password'
```

For the default provider, CLI authentication/configuration must belong to `codexcloud`, not the administrator's root account. Alternatively add a custom provider after bringing up the website.

### 3. Register and check the service

```bash
sudo install -m 0644 /opt/codex-cloud/deploy/codex-cloud.service \
  /etc/systemd/system/codex-cloud.service
sudoedit /etc/systemd/system/codex-cloud.service
```

Check `User/Group`, `WorkingDirectory`, `HOME`, `PATH` and `ExecStart`. The template uses `/usr/bin/node`; replace it if your installation differs.

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now codex-cloud
systemctl status codex-cloud --no-pager
curl --fail http://127.0.0.1:18474/api/auth/status
```

Expect `active (running)` and `configured: true`. On failure inspect `journalctl -u codex-cloud -n 80 --no-pager`; do not launch a second instance against the same data.

### 4. HTTPS

Choose one reverse-proxy manager. For Caddy, adapt `deploy/Caddyfile.linux` to your domain and merge it into the managed configuration. For Nginx, reuse the location in `deploy/baota-nginx.conf`. Both forward to `127.0.0.1:18474`.

Merge with existing sites rather than overwriting them. Validate before reloading, for example:

```bash
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo systemctl reload caddy
```

For Nginx use the appropriate installation's `nginx -t` and reload command. Browser HTTPS access must match `PUBLIC_ORIGIN`.

## Maintenance and OS differences

Wait for idle tasks, approvals and queues before stopping. See [Operations](OPERATIONS.md) for upgrades/restores. Manual templates and installer-generated settings may use different `CODEX_HOME` paths; the actual `.env` is authoritative.

On Ubuntu 24.04, `bwrap: loopback: Failed RTM_NEWADDR` can indicate user-namespace/AppArmor restrictions. `deploy/codex-cloud-codex.apparmor` targets a specific native CLI binary and requires the actual path before administrator installation. Recheck after CLI upgrades. Do not disable global AppArmor or remove workbench data locks to work around path/permission errors.
