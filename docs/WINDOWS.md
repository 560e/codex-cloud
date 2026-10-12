# Windows 安装与后台运行

[English](en/WINDOWS.md) · [文档目录](INDEX.md) · [项目首页](../README.md)

Windows 支持终端内本地运行，以及通过计划任务后台运行。后台账户的文件权限、CLI 配置和 Windows 登录凭据与网站密码是不同概念。

## 本地运行

安装 Node 24+、Git 和兼容 CLI，进入源码目录：

```powershell
Set-Location 'D:\Projects\codex-cloud'
node --version
codex --version
npm.cmd ci --include=dev
npm.cmd run password
npm.cmd run dev
```

打开 `http://127.0.0.1:18473`。日常构建版先执行 `npm.cmd run build`，再运行 `npm.cmd run start:local`。也可使用根目录 `.bat` 启动器；它们不替代首次安装和构建。

## 后台运行：安装向导

```powershell
Set-Location 'D:\Services\codex-cloud'
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 --check
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

根据向导选择程序/数据目录、反代模式、域名与证书。需要注册后台任务时提供所选 Windows 账户所需的任务凭据。该账户必须能够访问 Node、CLI、数据和项目；不能只依赖另一个登录用户的 PATH 或认证目录。

向导使用任务名 `CodexCloud`。公网模式通常由 Nginx 提供 443，后端保持 `127.0.0.1:18474`；`skip` 模式直接使用回环 18474，与本地快捷入口的 18473 不同。

```powershell
Get-ScheduledTask -TaskName CodexCloud
Get-ScheduledTaskInfo -TaskName CodexCloud
Start-ScheduledTask -TaskName CodexCloud
curl.exe --fail http://127.0.0.1:18474/api/auth/status
```

确认任务状态和接口都正常后，再验证 HTTPS、登录与真实任务。检查任务触发器及“用户未登录时运行”设置是否符合需求，实际退出登录或重启一次完成验收。

## 配置与维护

编辑程序目录的 `.env`；Windows 路径推荐 `D:/CodexCloud/data` 形式。等待任务空闲后停止计划任务，确认其 Node/CLI 子进程退出，再更新程序：

```powershell
Stop-ScheduledTask -TaskName CodexCloud
# 完成配置/程序更新后
Start-ScheduledTask -TaskName CodexCloud
```

只关闭浏览器不会停止任务。Windows 账户密码变化后，应更新计划任务凭据。后端日志通常在 `DATA_DIR/logs`，安装器日志在程序目录 `.installer/install.log`；更完整的备份与更新步骤见[运维](OPERATIONS.md)。

## 可选：已有 Caddy 流程

仓库保留自有 PEM 证书的 Caddy 启动器。此流程要求预装 Node/npm、CLI 和 Caddy，并由你负责证书续期：

```powershell
.\scripts\Install-Workbench.ps1 -PublicOrigin 'https://codex.example.com:18473' `
  -TlsCert 'D:\Certificates\fullchain.pem' -TlsKey 'D:\Certificates\privkey.pem'
.\scripts\Start-Workbench.ps1 -CaddyBin 'C:\Tools\caddy.exe'
```

手动实例验证后先停止，再注册后台任务：

```powershell
.\scripts\Register-Startup.ps1 -CaddyBin 'C:\Tools\caddy.exe'
Start-ScheduledTask -TaskName CodexPrivateWorkbench
```

该方案使用任务名 `CodexPrivateWorkbench`，示例公网端口为 18473。不要同时启动两种方案占用相同后端端口。脚本保留已有 `.env`，首次生成时保留模板注释。

## 故障定位

`npm.ps1` 被拦截时改用 `npm.cmd`。计划任务能运行而网页不可达时，先查本机后端，再查 Nginx/Caddy 和防火墙。终端可调用 CLI、计划任务却失败时，优先比较运行账户、PATH、`CODEX_BIN` 和 `CODEX_HOME`。
