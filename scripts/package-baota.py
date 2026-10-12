"""Build a portable source + dist ZIP without local runtime data (Python 3)."""
from datetime import datetime, timezone
from hashlib import sha256
from pathlib import Path
import json
import os
import subprocess
import zipfile

ROOT = Path(__file__).resolve().parent.parent
OUTPUT = ROOT / "baota"
FILES = ["install.sh", "install.ps1",
    "Start-Local.bat", "Start-Dev.bat", "Start-Local.command", "Start-Dev.command",
    "package.json", "package-lock.json", "README.md", "README.en.md", ".env.example",
    ".gitignore", ".prettierrc.json", "index.html", "tsconfig.json",
    "tsconfig.server.json", "vite.config.ts", "playwright.config.ts",
    "ChatGPT-circle.svg", "gongzuotai.svg", "touxiang.jpg",
]
DIRECTORIES = {
    "src": {".ts", ".tsx", ".css"},
    "server": {".ts"}, "shared": {".ts"},
    "tests": {".ts"}, "scripts": {".ts", ".mjs", ".ps1", ".py"},
    "docs": {".md"}, "public": {".svg", ".js", ".png", ".jpg", ".ico"},
    "dist": {".js", ".map", ".html", ".css", ".svg", ".jpg", ".png", ".ico"},
}
FILES += ["deploy/codex-cloud.service", "deploy/linux.env.example",
          "deploy/Caddyfile", "deploy/Caddyfile.local", "deploy/Caddyfile.linux",
          "deploy/baota-nginx.conf",
          "deploy/codex-cloud-codex.apparmor"]


def main():
    subprocess.run(["npm.cmd" if os.name == "nt" else "npm", "run", "build"],
                   cwd=ROOT, check=True)
    paths = {ROOT / name for name in FILES}
    for directory, extensions in DIRECTORIES.items():
        for file in (ROOT / directory).rglob("*"):
            if file.is_file() and file.suffix.lower() in extensions:
                paths.add(file)
    entries = {}
    for file in sorted(paths):
        try:
            file.resolve().relative_to(ROOT)
        except ValueError:
            raise RuntimeError(f"Refusing outside file: {file}")
        if file.is_symlink():
            raise RuntimeError(f"Refusing linked/outside file: {file}")
        name = file.relative_to(ROOT).as_posix()
        if any(part in {"node_modules", "data", ".test-data", ".git", "__pycache__"}
               for part in file.relative_to(ROOT).parts):
            raise RuntimeError(f"Unexpected private/generated directory: {name}")
        entries[name] = file.read_bytes()
    for required in ["dist/server/index.js", "dist/client/index.html", "scripts/password.ts"]:
        if required not in entries:
            raise RuntimeError(f"Missing required file: {required}")
    now = datetime.now(timezone.utc)
    manifest = {"createdAt": now.isoformat(), "cliBaseline": "0.155.1",
                "nodeMajor": 24, "files": {
                    name: {"bytes": len(data), "sha256": sha256(data).hexdigest()}
                    for name, data in sorted(entries.items())}}
    entries["PACKAGE-MANIFEST.json"] = json.dumps(manifest, ensure_ascii=False, indent=2).encode("utf-8")
    OUTPUT.mkdir(exist_ok=True)
    archive = OUTPUT / f"codex-cloud-baota-{now:%Y%m%d-%H%M%S-%f}.zip"
    with zipfile.ZipFile(archive, "x", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as bundle:
        for name, data in sorted(entries.items()):
            info = zipfile.ZipInfo("codex-cloud/" + name, now.timetuple()[:6])
            info.create_system = 3
            info.external_attr = (0o100755 if name.endswith((".command", ".sh")) else 0o100644) << 16
            bundle.writestr(info, data, compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
    with zipfile.ZipFile(archive) as bundle:
        if bundle.testzip() is not None:
            raise RuntimeError("Archive CRC check failed")
        for name, data in entries.items():
            if bundle.read("codex-cloud/" + name) != data:
                raise RuntimeError(f"Archive verification failed: {name}")
    archive.with_suffix(".zip.sha256").write_text(
        f"{sha256(archive.read_bytes()).hexdigest()}  {archive.name}\n", encoding="utf-8")
    (OUTPUT / "部署说明.md").write_bytes((ROOT / "docs/BAOTA.md").read_bytes())
    print(f"Verified: {archive}\nFiles: {len(entries)}\nBytes: {archive.stat().st_size}")


if __name__ == "__main__":
    main()
