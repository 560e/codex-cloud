# 本地使用与开发

[English](en/LOCAL.md) · [文档目录](INDEX.md) · [项目首页](../README.md)

本页适用于在自己的电脑上运行工作台。公网部署使用[生产部署指南](DEPLOYMENT.md)。本地开发默认会使用真实 CLI 和供应商；自动化测试的模拟执行器是另一套环境。

## 1. 准备工具

安装 Node.js 24+（含 npm）、Git 和项目自身需要的工具链。在仓库根目录检查：

```bash
node --version
npm --version
npm install -g @openai/codex@0.159.3
codex --version
npm ci --include=dev
```

已有兼容 CLI 可跳过全局安装。Windows 如果 PowerShell 拦截 `npm.ps1`，使用 `npm.cmd`。不要从其他操作系统复制 `node_modules`。

## 2. 配置数据并设置密码

全新源码目录可直接使用默认配置，数据写入 `./data`。若要隔离开发数据，**先**创建 `.env`，**再**设置密码：

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

密码输入不回显，需要输入两次。此命令操作当前 `DATA_DIR`；如果启动后仍提示未设置密码，先检查两个命令是否使用了相同工作目录和配置。再次设置密码会撤销旧登录。

## 3. 选择启动模式

| 模式       | 命令                                     | 地址                     | 适用情况                              |
| ---------- | ---------------------------------------- | ------------------------ | ------------------------------------- |
| 开发       | `npm run dev`                            | `http://127.0.0.1:18473` | 修改代码；Vite 18473 代理到后端 18474 |
| 本机构建版 | `npm run build` 后 `npm run start:local` | `http://127.0.0.1:18473` | 日常使用；后端直接提供构建页面        |
| 生产启动   | `npm start`                              | 由 `.env` 与反代决定     | 后台部署，不用于替代上述本机模式      |

同一时刻只运行一种模式，按 `Ctrl+C` 停止。关闭网页不会停止后端或正在执行的任务。

Windows 快捷入口为 `Start-Dev.bat`、`Start-Local.bat`；macOS 为同名 `.command`。它们不会自动安装依赖、构建或初始化密码。macOS 可先执行 `chmod +x Start-Dev.command Start-Local.command`。

## 4. 完成首次任务

1. 使用设置的网站密码登录。
2. 添加一个本机存在且当前账户可访问的项目目录。
3. 在设置中保存供应商，获取模型并切换使用；或确认默认 CLI 配置可用。
4. 先发送一个只读取项目的简单任务，确认流式回复、工具输出和任务完成状态正常。

如果会话出现但模型调用失败，检查供应商配置与网络；如果工具无法读取文件，检查项目路径和执行权限。这两类问题与网站能否登录相互独立。

## 常见问题

| 现象                      | 检查与处理                                                           |
| ------------------------- | -------------------------------------------------------------------- |
| `EADDRINUSE`              | 停止已有开发/本机/后台实例，再检查 18473 和 18474                    |
| 登录或 WebSocket 来源错误 | 地址统一为配置的 Origin，不混用 `localhost` 与 `127.0.0.1`           |
| 修改代码后构建版没变化    | 停止旧进程，重新 `npm run build` 后启动                              |
| 修改依赖后启动失败        | 在当前目录重新 `npm ci --include=dev`                                |
| Finder 启动找不到 Node    | 从已初始化 nvm/Homebrew 的终端运行 `bash Start-Dev.command`          |
| CLI 不可用                | 用启动工作台的同一账户检查 `codex --version`，必要时设置 `CODEX_BIN` |

环境变量详解见[配置参考](CONFIGURATION.md)，贡献代码前的验证流程见[开发指南](RD.md)。
