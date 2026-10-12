# 源码仓库与交付包

[English](en/SERVER-SOURCE.md) · [文档目录](INDEX.md) · [项目首页](../README.md)

源码仓库用于审阅、开发和构建；部署包用于向目标机器交付程序；迁移备份用于保存运行状态。三者的内容和保密要求不同，不能把运行目录整体上传到 GitHub。

## GitHub 仓库应保留什么

| 保留                                          | 原因                           |
| --------------------------------------------- | ------------------------------ |
| `src/`、`server/`、`shared/`                  | 应用源码与公共协议             |
| `tests/`、测试配置                            | 可重复的回归测试，使用合成样例 |
| `scripts/`、安装入口、通用 `deploy/` 模板     | 构建、安装、维护与跨平台启动   |
| `package.json`、`package-lock.json`、编译配置 | 依赖版本和可复现构建所需       |
| README、`docs/`、`.env.example`               | 使用说明与无真实值的配置模板   |
| 应用实际引用的图片/图标                       | UI 构建和显示所需资源          |

测试代码不是测试运行数据；锁文件也不是已安装的依赖。删除这些文件会损害维护与构建能力。

不要提交实际 `.env`、API Key、Cookie、证书私钥、数据库、CLI 认证/历史、用户附件、项目数据、日志、备份、`node_modules`、`dist`、`.test-data`、测试报告或历史交付包。占位模板可保留，真实部署生成的配置应独立保存。

`.gitignore` 只防止新增文件被误加入，不会从 Git 历史或已跟踪文件中移除内容。发布前检查暂存清单和内容；如秘密曾进入提交，需要移除历史中的秘密并轮换对应凭据。

## 仅导出干净源码

在项目根目录执行，只需 Python 3，无需先安装依赖或构建：

```bash
python3 scripts/export-source.py
# 也可通过 npm 别名执行，不需要 npm install：
npm run export:source
# 可选：指定一个尚不存在的新目录。
python3 scripts/export-source.py --output ../codex-cloud-source-release
```

默认输出 `artifacts/codex-cloud-source-<UTC 时间戳>/`，命令打印绝对路径、文件数量与组合 SHA-256。已有目录一律拒绝覆盖；再次执行会生成新目录，不会自动刷新旧副本。脚本校验复制内容后才报告成功，输出目录可直接作为 GitHub 仓库根目录。

`scripts/source-files.txt` 是经过审阅的明确文件清单，包含允许公开的部署模板。新增或删除源码文件时须同步维护该清单。未列出的文件即使扩展名像代码也不会被导出；脚本还拒绝运行数据路径、缺失文件及符号链接，包括父目录链接。保留有注释的 `.env.example` 模板和合成测试代码，排除真实配置、测试运行产物、依赖、编译文件、日志与数据库。脚本无法替你清除被手工写进允许文件中的密钥，发布前仍应审阅源码内容。

可执行 `python3 -B tests/export-source.test.py`，用合成样例验证污染文件排除、重复导出与覆盖保护。

## 提交前检查

在干净源码目录安装依赖并验证：

```bash
npm ci --include=dev
npm run verify
```

浏览器测试前需准备 Chromium 和系统依赖，见[测试与验收](VALIDATION.md)。已有 Git 仓库可用以下只读命令审阅：

```bash
git status --short
git diff --stat
git diff --cached --name-only
git diff --cached --check
git ls-files
```

逐项核对文件清单、配置模板和示例地址。检查代码内是否残留私有域名、服务器地址、绝对用户路径、测试 Key 或真实业务数据；测试夹具应明确使用合成值。确认中文/英文文档相互链接且没有失效路径。

## 构建与目录交付

需要 Python 3，命令在项目根目录执行：

```bash
npm ci --include=dev
npm run check
npm run build
python3 scripts/package-clean.py
```

脚本创建 `artifacts/codex-cloud-交付包-时间戳/`，其中：

- `源码包/`：完整开发源码，不含构建文件。
- `部署包/`：源码加当前 `dist`，仍不含依赖或运行数据。
- 每个包附使用说明与 `PACKAGE-MANIFEST.json`，清单记录文件大小和 SHA-256；脚本复制后再次核对。

这个脚本输出目录，不压缩，也不会替你重新构建；缺少必要构建结果时会失败。`--output` 只用于刷新 `artifacts/` 下已识别的交付目录，存在额外文件时拒绝覆盖。更推荐为新版本生成新目录。

## ZIP 部署包

```bash
python3 scripts/package-baota.py
```

该脚本先运行构建，再输出 `baota/codex-cloud-baota-时间戳.zip` 和 `.zip.sha256`，归档内包含源码、构建结果和文件清单。它执行归档 CRC 与内容检查，但不代替测试，也不是数据库迁移备份。安装依赖在目标系统执行，不携带构建机器的 `node_modules`。

两个打包脚本都按目录/扩展名收集文件，并检查部分路径/文件类型。这些检查不等于内容级秘密扫描；不应在 `deploy/` 等被收集目录下放置私人配置后直接打包。

## 发布与来源记录

交付时记录代码版本、Node/CLI 版本、验证结果和归档摘要。源码目录改变不会自动修改生产程序；实际发布按[运维流程](OPERATIONS.md)保留配置与数据、切换构建并验收。不要把迁移包、真实配置或服务器日志作为公开 Release 附件。
