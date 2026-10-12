"""Create separate clean source/deployment directories without compression."""
from datetime import datetime, timezone
from hashlib import sha256
from pathlib import Path
import argparse
import json
import shutil

ROOT = Path(__file__).resolve().parent.parent
TOP_FILES = [
    'install.sh', 'install.ps1',
    'Start-Local.bat', 'Start-Dev.bat', 'Start-Local.command', 'Start-Dev.command',
    'package.json', 'package-lock.json', 'README.md', 'README.en.md',
    '.env.example', '.gitignore', '.prettierrc.json', 'index.html', 'tsconfig.json',
    'tsconfig.server.json', 'vite.config.ts', 'playwright.config.ts',
    'ChatGPT-circle.svg', 'gongzuotai.svg', 'touxiang.jpg',
]
DIRECTORIES = {
    'src': {'.ts', '.tsx', '.css'}, 'server': {'.ts'}, 'shared': {'.ts'},
    'tests': {'.ts'}, 'scripts': {'.ts', '.mjs', '.ps1', '.py'},
    'docs': {'.md'}, 'public': {'.svg', '.js', '.png', '.jpg', '.ico'},
    'deploy': {'.service', '.example', '.conf', '.apparmor'},
}
FORBIDDEN = {'node_modules', 'data', '.test-data', '.git', '__pycache__',
             'test-results', 'playwright-report', 'backups', 'deploy-backups',
             '.installer', '.tools', 'artifacts', 'baota'}
SOURCE_GUIDE = """# 源码包 / Source bundle

[中文文档](docs/INDEX.md) · [English documentation](docs/en/INDEX.md)

Node.js 24+、npm 与 Codex CLI。依赖需在目标系统安装。
Requires Node.js 24+, npm and Codex CLI. Install dependencies on the target OS.

```bash
npm ci --include=dev
npm run password
npm run build
npm run start:local
```

本地访问 / Local URL: http://127.0.0.1:18473 。

Windows: Start-Dev.bat / Start-Local.bat。macOS: Start-Dev.command / Start-Local.command。

源码包不含 dist、依赖、凭据或运行数据。生产部署见文档。
Source bundles exclude dist, dependencies, credentials and runtime data. See the documentation for production deployment.
"""
DEPLOY_GUIDE = """# 部署包 / Deployment bundle

[中文文档](docs/DEPLOYMENT.md) · [English documentation](docs/en/DEPLOYMENT.md)

含源码与 dist；不含依赖、凭据或运行数据。目标系统需 Node.js 24+、npm、Codex CLI。
Includes source and dist; excludes dependencies, credentials and runtime data. Requires Node.js 24+, npm and Codex CLI on the target system.

本地首次使用 / First local use:

```bash
npm ci --include=dev
npm run password
npm run start:local
```

生产部署配置 HTTPS 与服务管理器后使用 npm start。升级保留配置和数据。
For production, configure HTTPS and a service manager, then use npm start. Preserve configuration and data during upgrades.

PACKAGE-MANIFEST.json 提供文件 SHA-256 / contains file SHA-256 hashes.
"""


def collect():
    selected = {ROOT / name for name in TOP_FILES}
    for folder, extensions in DIRECTORIES.items():
        for file in (ROOT / folder).rglob('*'):
            if file.is_file() and file.suffix.lower() in extensions:
                selected.add(file)
    for name in ['Caddyfile', 'Caddyfile.local', 'Caddyfile.linux']:
        selected.add(ROOT / 'deploy' / name)
    return selected


def safe_relative(file):
    if file.is_symlink():
        raise RuntimeError(f'Symlink is not allowed: {file}')
    file.resolve().relative_to(ROOT)
    relative = file.relative_to(ROOT)
    if any(part in FORBIDDEN for part in relative.parts):
        raise RuntimeError(f'Private/generated file: {relative}')
    if file.name == '.env' or file.suffix in {'.log', '.sqlite', '.db', '.pem', '.key', '.zip'}:
        raise RuntimeError(f'Private/generated file: {relative}')
    return relative


def main():
    now = datetime.now(timezone.utc)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, help='Refresh an existing delivery directory under artifacts/')
    args = parser.parse_args()
    output = args.output.resolve() if args.output else ROOT / 'artifacts' / f'codex-cloud-交付包-{now:%Y%m%d-%H%M%S}'
    output.relative_to(ROOT / 'artifacts')
    if output.exists() and not (
        args.output and (output / '说明.md').is_file()
        and all((output / kind / 'PACKAGE-MANIFEST.json').is_file() for kind in ['源码包', '部署包'])
    ):
        raise RuntimeError('Output exists and is not a recognized delivery directory')
    output.mkdir(parents=True, exist_ok=True)
    files = collect()
    built = {file for file in (ROOT / 'dist').rglob('*') if file.is_file()}
    for required in ['dist/server/index.js', 'dist/client/index.html', 'dist/server/app.js']:
        if ROOT / required not in built:
            raise RuntimeError('Missing build result; run npm run build first: ' + required)
    if 'provider-password' in json.loads((ROOT / 'package.json').read_text())['scripts']:
        raise RuntimeError('Old provider password command remains')
    summary = {}
    for kind, selected, guide in [
        ('源码包', files, SOURCE_GUIDE),
        ('部署包', files | built, DEPLOY_GUIDE),
    ]:
        folder = output / kind
        folder.mkdir(exist_ok=True)
        allowed = {safe_relative(file).as_posix() for file in selected} | {'使用说明.md', 'PACKAGE-MANIFEST.json'}
        for existing in folder.rglob('*'):
            if existing.is_symlink() or (existing.is_file() and existing.relative_to(folder).as_posix() not in allowed):
                raise RuntimeError('Unexpected file in existing delivery directory: ' + str(existing))
        for file in sorted(selected):
            relative = safe_relative(file)
            dest = folder / relative
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(file, dest)
            dest.chmod(0o755 if file.suffix in {'.sh', '.command'} else 0o644)
        (folder / '使用说明.md').write_text(guide, encoding='utf-8')
        manifest = {
            'createdAt': now.isoformat(), 'packageType': kind, 'nodeMajor': 24,
            'files': {
                file.relative_to(folder).as_posix(): {
                    'bytes': file.stat().st_size, 'sha256': sha256(file.read_bytes()).hexdigest(),
                }
                for file in sorted(folder.rglob('*')) if file.is_file() and file.name != 'PACKAGE-MANIFEST.json'
            },
        }
        (folder / 'PACKAGE-MANIFEST.json').write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        for name, item in manifest['files'].items():
            content = (folder / name).read_bytes()
            if len(content) != item['bytes'] or sha256(content).hexdigest() != item['sha256']:
                raise RuntimeError('Manifest verification failed: ' + name)
        summary[kind] = {'files': len(manifest['files']) + 1,
                         'bytes': sum(f.stat().st_size for f in folder.rglob('*') if f.is_file())}
    (output / '说明.md').write_text(
        '# Codex Cloud 交付包\n\n'
        '源码包：完整开发源码，不含构建产物。\n\n'
        '部署包：源码及最新构建产物，可按其中的使用说明部署。\n\n'
        '两个包均不含真实配置、密码、密钥、会话、附件、日志、依赖目录或旧打包文件。'
        '首次使用需安装依赖并设置网站登录密码。文档入口为各子目录 docs/INDEX.md，包含使用、配置、架构、部署、开发、运维、API、测试验收与交付说明。\n', encoding='utf-8')
    print(json.dumps({'directory': str(output), 'compressed': False, 'packages': summary}, ensure_ascii=False))


if __name__ == '__main__':
    main()
