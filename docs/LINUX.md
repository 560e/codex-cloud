# Linux 部署

[English](en/LINUX.md) · [文档目录](INDEX.md) · [项目首页](../README.md)

适用于使用 systemd 的 Linux 主机。本页以程序目录 `/opt/codex-cloud`、服务账户 `codexcloud`、数据目录 `/var/lib/codex-cloud/data` 为例；已有部署应沿用实际路径，不重复初始化账号或数据。

## 路径 A：安装向导

在完整源码目录执行检查，再开始安装：

```bash
bash install.sh --check
sudo bash install.sh
```

检查模式不安装软件。正式安装会按选择准备 Node/npm、CLI、Git/Nginx、构建、网站密码与 `codex-cloud.service`。已有站点或证书时选择 `manual`，按[宝塔指南](BAOTA.md)或自己的反代管理方式接入。参数和证书行为见[安装器参考](INSTALL.md)。

## 路径 B：手动安装

### 1. 准备运行账户与工具

先安装 Node 24+、npm、Git 和兼容 CLI。Node 必须能导入 `node:sqlite`，CLI 必须支持 App Server：

```bash
node --version
node -e "require('node:sqlite')"
codex --version
command -v node
command -v codex
```

服务账户不能使用只位于 `/root` 下的 Node/CLI。若使用自定义安装目录，把真实可执行文件路径写入服务单元及 `CODEX_BIN`。

首次创建账户和目录：

```bash
id codexcloud || sudo useradd --system --create-home \
  --home-dir /var/lib/codex-cloud --shell /usr/sbin/nologin codexcloud
sudo install -d -o codexcloud -g codexcloud -m 0750 \
  /opt/codex-cloud /var/lib/codex-cloud/data /srv/projects
```

将干净源码复制到 `/opt/codex-cloud` 并交由 `codexcloud` 所有。只对应用与专属数据目录设置权限，不递归修改已有业务项目的所有权。

### 2. 安装依赖、构建与配置

以下命令以服务账户运行，Node/npm 必须在该账户的 PATH 中：

```bash
sudo -u codexcloud -H sh -c 'cd /opt/codex-cloud && npm ci --include=dev && npm run build'
sudo -u codexcloud cp /opt/codex-cloud/deploy/linux.env.example /opt/codex-cloud/.env
sudo chmod 600 /opt/codex-cloud/.env
sudoedit /opt/codex-cloud/.env
```

复制 `.env` 的命令仅用于首次安装；已有配置不要覆盖。至少核对：`PUBLIC_ORIGIN`、`CODEX_BIN`、`CODEX_HOME`、`DATA_DIR`、`PROJECT_ROOTS`。完整解释见[配置参考](CONFIGURATION.md)。

```bash
sudo -u codexcloud -H sh -c 'cd /opt/codex-cloud && npm run password'
```

如果使用服务器默认供应商，CLI 认证/配置应属于 `codexcloud`，而非管理员终端的 root 账户。也可在网站上线后添加自定义供应商。

### 3. 注册并验证服务

```bash
sudo install -m 0644 /opt/codex-cloud/deploy/codex-cloud.service \
  /etc/systemd/system/codex-cloud.service
sudoedit /etc/systemd/system/codex-cloud.service
```

核对 `User/Group`、`WorkingDirectory`、`HOME`、`PATH` 和 `ExecStart`。模板使用 `/usr/bin/node`；与实际安装不一致时必须修改。

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now codex-cloud
systemctl status codex-cloud --no-pager
curl --fail http://127.0.0.1:18474/api/auth/status
```

预期服务为 `active (running)`，接口返回 `configured: true`。失败时查看 `journalctl -u codex-cloud -n 80 --no-pager`，不要重复启动另一份实例。

### 4. 接入 HTTPS

选择一种反代管理方式。Caddy 可使用 `deploy/Caddyfile.linux`，替换域名后合并到自己的配置；Nginx 可复用 `deploy/baota-nginx.conf` 中的 location 内容。两者均转发到 `127.0.0.1:18474`。

已有站点必须合并配置，避免覆盖同机其他服务。检查通过后再重载，例如：

```bash
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo systemctl reload caddy
```

Nginx 则使用对应安装的 `nginx -t` 与重载命令。浏览器 HTTPS 地址应与 `PUBLIC_ORIGIN` 完全一致。

## 维护与系统差异

停止前等待任务、审批和队列空闲；升级及数据恢复见[运维](OPERATIONS.md)。手动 systemd 模板和向导生成的 `CODEX_HOME` 可能不同，始终以实际 `.env` 为准。

Ubuntu 24.04 如果执行器报 `bwrap: loopback: Failed RTM_NEWADDR`，核对用户命名空间与 AppArmor 限制。`deploy/codex-cloud-codex.apparmor` 是针对单一 CLI 二进制路径的模板，须改为本机真实路径后由管理员安装；升级 CLI 后重新核对。不要通过关闭全局 AppArmor 或绕过工作台数据锁来解决路径/权限问题。
