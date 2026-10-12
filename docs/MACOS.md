# macOS 安装与后台运行

[English](en/MACOS.md) · [文档目录](INDEX.md) · [项目首页](../README.md)

本地运行适合日常开发；后台方式使用当前登录用户的 LaunchAgent。需要无人登录、长期在线的服务器时，应选择适合的系统服务方案，而不是依赖此用户任务。

## 本地初始化

安装匹配 Apple Silicon/Intel 的 Node 24+，准备 Git 和兼容 CLI。在源码目录执行：

```bash
npm ci --include=dev
npm run password
chmod +x Start-Dev.command Start-Local.command
npm run dev
```

访问 `http://127.0.0.1:18473`。构建版执行 `npm run build` 后用 `npm run start:local`。`.command` 文件可双击启动，但 nvm 用户宜从初始化好的终端运行，以获得正确 PATH。

## 安装后台实例

以普通登录账户运行，不对整个安装入口使用 sudo：

```bash
bash install.sh --check
bash install.sh
```

向导通过专用运行环境或已有安装使用 Node，Git/Nginx 可由 Homebrew 补齐。默认程序目录为 `~/codex-cloud`；具体数据和 CLI 目录以生成的 `.env` 为准。需要系统权限的步骤由安装器单独请求。

后端任务文件为 `~/Library/LaunchAgents/com.codexcloud.workbench.plist`。用户登录后加载，睡眠时不保证持续可用。Nginx 由 Homebrew 或管理员单独管理。

## 检查、停止与恢复

```bash
launchctl print "gui/$(id -u)/com.codexcloud.workbench"
curl --fail http://127.0.0.1:18474/api/auth/status
```

配置变更后，在任务空闲时重启已加载服务：

```bash
launchctl kickstart -k "gui/$(id -u)/com.codexcloud.workbench"
```

升级或离线备份需要停止并解除 KeepAlive，再加载：

```bash
launchctl bootout "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.codexcloud.workbench.plist"
# 完成维护后
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.codexcloud.workbench.plist"
```

标准输出/错误写入数据目录的 `server.out.log` 和 `server.err.log`；执行器诊断在 `DATA_DIR/logs`。如果手动终端可运行而后台失败，检查 plist 中的 Node 路径、工作目录、PATH 与目录权限。

## HTTPS 与系统权限

证书和站点模式见[安装器参考](INSTALL.md)。自动续期使用 `com.codexcloud.certificate.plist`；root 管理的 Nginx 重载需要管理员权限，不应假定用户 LaunchAgent 可以直接完成。

macOS 对桌面、文稿、外置磁盘等目录可能有额外访问控制。项目应放在后台账户可稳定访问的位置，并在该运行方式下验证读取、写入和工具执行。系统升级、Node 路径变化或 CLI 升级后，再做一次[平台验收](VALIDATION.md)。
