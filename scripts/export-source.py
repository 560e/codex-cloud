#!/usr/bin/env python3
"""Export reviewed source files into a new directory; no build or dependencies needed."""
import argparse
from datetime import datetime, timezone
from hashlib import sha256
from pathlib import Path, PurePosixPath
import shutil
import tempfile

ROOT = Path(__file__).resolve().parent.parent
MANIFEST = 'scripts/source-files.txt'
FORBIDDEN = {
    'node_modules', 'dist', 'build', 'data', '.test-data', '.git', '.codex',
    '__pycache__', 'test-results', 'playwright-report', 'coverage', 'logs',
    'backups', 'deploy-backups', '.installer', '.tools', 'artifacts', 'baota',
}
PRIVATE_SUFFIXES = {'.log', '.db', '.sqlite', '.sqlite3', '.pem', '.key', '.zip', '.gz', '.pyc'}
TEMPLATES = {'.env.example', 'deploy/linux.env.example'}


def source_files(root):
    """Only explicitly reviewed paths are eligible, including deployment templates."""
    manifest = root / MANIFEST
    if manifest.is_symlink():
        raise ValueError('Source manifest must not be a symbolic link')
    names = manifest.read_text(encoding='utf-8').splitlines()
    selected = []
    seen = set()
    for name in names:
        if not name or name.startswith('#'):
            continue
        relative = PurePosixPath(name)
        if (relative.is_absolute() or '..' in relative.parts or '\\' in name
                or relative.as_posix() != name or name in seen):
            raise ValueError(f'Invalid or duplicate source path: {name}')
        if (any(part in FORBIDDEN for part in relative.parts)
                or relative.suffix.lower() in PRIVATE_SUFFIXES
                or any(part.startswith('.env') for part in relative.parts) and name not in TEMPLATES):
            raise ValueError(f'Runtime/private path in source manifest: {name}')
        file = root
        for part in relative.parts:
            file = file / part
            if file.is_symlink():
                raise ValueError(f'Symbolic links are not allowed: {name}')
        if not file.is_file():
            raise ValueError(f'Missing source file: {name}')
        selected.append(file)
        seen.add(name)
    if MANIFEST not in seen or 'package.json' not in seen or 'server/index.ts' not in seen:
        raise ValueError('Incomplete source manifest')
    return sorted(selected)


def export_source(root, output):
    root = root.resolve()
    # Never replace an existing directory, including an existing source export.
    if output.is_symlink() or output.exists():
        raise ValueError(f'Output already exists; choose a new directory: {output}')
    output = output.resolve()
    if output == root or output in root.parents:
        raise ValueError('Output must not replace the source directory or its parents')
    files = source_files(root)
    output.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix='.source-export-', dir=output.parent))
    published = False
    try:
        digest = sha256()
        for file in files:
            relative = file.relative_to(root)
            dest = staging / relative
            dest.parent.mkdir(parents=True, exist_ok=True)
            content = file.read_bytes()
            dest.write_bytes(content)
            dest.chmod(0o755 if file.suffix in {'.sh', '.command'} else 0o644)
            if sha256(dest.read_bytes()).digest() != sha256(content).digest():
                raise RuntimeError(f'Copy verification failed: {relative}')
            digest.update(relative.as_posix().encode('utf-8') + b'\0' + sha256(content).digest())
        # mkdir reserves the final name without overwriting even an empty directory.
        output.mkdir()
        published = True
        for child in staging.iterdir():
            shutil.move(str(child), str(output / child.name))
        output.chmod(0o755)
        return len(files), digest.hexdigest()
    except BaseException:
        if published:
            shutil.rmtree(output)
        raise
    finally:
        shutil.rmtree(staging)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, help='New output directory (must not exist)')
    args = parser.parse_args()
    stamp = datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S-%f')
    output = args.output or ROOT / 'artifacts' / f'codex-cloud-source-{stamp}'
    try:
        count, digest = export_source(ROOT, output)
    except (ValueError, OSError) as error:
        parser.exit(1, f'Export failed: {error}\n')
    print(f'Directory: {output.resolve()}\nFiles: {count}\nSource SHA-256: {digest}')


if __name__ == '__main__':
    main()
