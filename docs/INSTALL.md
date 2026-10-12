# 安装向导参考

[English](en/INSTALL.md) · [文档目录](INDEX.md) · [项目首页](../README.md)

安装向导面向长期运行的实例，负责准备运行工具、安装应用、配置网站和注册后台服务。它需要完整源码目录；不要只下载 `install.sh` 或 `install.ps1`。本地热更新开发使用[本地指南](LOCAL.md)。

## 检查与执行

```bash
# Linux / macOS：只检查，不修改系统
bash install.sh --check
bash install.sh --dry-run

# Linux 正式安装
sudo bash install.sh

# macOS 正式安装：使用登录用户
bash install.sh
```

```powershell
# Windows
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 --check
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

`--check` 和 `--dry-run` 当前都检查已有环境并输出安装流程，不安装依赖或启动服务。若没有合适 Node，检查入口只提示要求；正式入口才下载专用运行环境并核对 SHA-256。

## 安装会做什么

1. 检查平台、架构、Node/npm，选择下载网络。
2. 确定程序目录、数据目录、端口、站点模式，读取已有配置。
3. 检查既有任务和实例，必要时停止可管理的空闲服务。
4. 准备 CLI、Git/Nginx，安装依赖并构建应用。
5. 创建带注释的 `.env`；首次设置网站密码，已有密码不重置。
6. 生成反代配置，按选择复用证书或执行 ACME HTTP-01。
7. 注册平台服务和适用的续期任务，检查后端及 HTTPS。

日志写入目标目录 `.installer/install.log`，安装状态写入 `.installer/state.json`。中断后先检查日志和服务状态，再修正问题重跑；安装器不是完整的事务式系统回滚工具。

## 参数

参数使用 `--名称=值`；布尔开关直接追加。

| 参数                               | 作用                                               |
| ---------------------------------- | -------------------------------------------------- |
| `--prefix=路径`                    | 目标程序目录                                       |
| `--data=路径`                      | 持久化数据目录                                     |
| `--port=18474`                     | 后端回环端口，安装器接受 1024～65535               |
| `--network=cn\|global\|custom`     | 下载网络选择                                       |
| `--registry=https://...`           | 自定义 npm registry                                |
| `--mode=auto\|manual\|skip`        | 自动网站配置、仅生成模板、或本机 HTTP 模式         |
| `--domain=codex.example.com`       | 公网域名，不带协议或路径                           |
| `--cert=路径 --key=路径`           | 成对提供已有证书链与私钥                           |
| `--email=邮箱 --accept-acme-terms` | 自动申请证书所需邮箱及条款确认                     |
| `--nginx-site-dir=路径`            | 指定 Nginx 站点配置目录                            |
| `--no-service`                     | 不注册后台和续期任务；自行管理进程与续期           |
| `--update-config`                  | 允许备份并更新现有网站/路径配置                    |
| `--replace-site`                   | 允许更新由本安装流程管理的已有站点文件             |
| `--stop-existing`                  | 允许停止已检查为空闲的既有 systemd 服务            |
| `--noninteractive`                 | 非交互模式；首次密码通过 `WORKBENCH_PASSWORD` 注入 |
| `--acme-staging`                   | 使用 ACME 测试环境；证书不受浏览器信任             |

自动模式面向独立新站点。检测到其他工具已配置同域名时应使用 `manual`，而不是让两个工具同时管理站点。`manual` 的输出是 `deploy/nginx-codex-cloud.conf`，仍需管理员接入。`skip` 不配置公网 HTTPS，服务地址为回环后端端口；当前流程仍会检查 Nginx 并生成模板。

## 下载与平台要求

安装入口固定 Node `24.21.0`，CLI 安装固定 `0.159.3`，已有兼容工具可复用。`cn` 使用 npmmirror，`global` 使用官方源；更换 registry 不修改全局 npm 设置。Node 镜像、运行目录和强制准备选项见[环境变量参考](CONFIGURATION.md)。

Linux 自动引导要求官方二进制支持的 x64/ARM64 与 glibc ≥ 2.28；CentOS 7、Alpine/musl 不适用该下载路径。macOS 使用登录账户及 Homebrew 补齐 Git/Nginx。Windows 使用专用 Node/Nginx 安装目录，Git 可通过 winget 准备。

npm 镜像不代理 GitHub、证书服务或供应商；这些地址仍需独立可达。应用的 `.env` 出站代理配置不等于安装器所有外部程序的网络配置。

## 证书与已有配置

ACME HTTP-01 要求域名 A/AAAA 指向部署主机，80 端口从公网可达；HTTPS 使用 443。已提供的证书应继续由原系统续期。自动证书任务定期检查，余期不足 30 天时尝试续期；macOS 用户任务无法自动获得 root Nginx 的重载权限。

已有 `.env` 默认可保留，显式更新前保存副本。配置目录、数据目录和网站密码都不应因程序升级被重新创建。更新生产实例前仍应执行[完整备份和维护流程](OPERATIONS.md)。
