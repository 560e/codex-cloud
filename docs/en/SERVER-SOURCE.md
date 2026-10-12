# Source repository and distributions

[简体中文](../SERVER-SOURCE.md) · [Documentation](INDEX.md) · [Project home](../../README.en.md)

A source repository supports review, development and builds. A deployment package delivers the program. A migration backup preserves runtime state. Their contents and confidentiality differ; do not upload an entire running installation to GitHub.

## What belongs in the repository

| Keep                                                          | Reason                                                  |
| ------------------------------------------------------------- | ------------------------------------------------------- |
| `src/`, `server/`, `shared/`                                  | Application source and shared protocol                  |
| `tests/` and test configuration                               | Repeatable regression tests using synthetic fixtures    |
| `scripts/`, installer entries and generic `deploy/` templates | Build, installation, maintenance and platform launchers |
| `package.json`, `package-lock.json`, compiler configuration   | Dependency versions and reproducible builds             |
| README, `docs/`, `.env.example`                               | Documentation and placeholder configuration             |
| Referenced application images/icons                           | Required UI assets                                      |

Test code is distinct from generated test data, and lockfiles are distinct from installed dependencies. Removing them harms maintainability and reproducibility.

Exclude real `.env` files, API keys, cookies, private keys, databases, CLI authentication/history, user uploads, project data, logs, backups, `node_modules`, `dist`, `.test-data`, reports and previous distributions. Retain generic templates and store real generated deployment configuration separately.

`.gitignore` prevents accidental additions; it does not remove tracked files or Git history. Review staged paths and content before publishing. If a secret entered a commit, remove it from history and rotate the credential.

## Export source only

Run from the project root with Python 3; dependencies and build outputs are not required:

```bash
python3 scripts/export-source.py
# Or use the npm alias (no npm install needed):
npm run export:source
# Optional: choose a new, non-existing directory.
python3 scripts/export-source.py --output ../codex-cloud-source-release
```

The default output is `artifacts/codex-cloud-source-<UTC timestamp>/`. The command prints the absolute path, file count and combined SHA-256. It never overwrites an existing directory. Run it again for a new export; it does not update an older copy automatically. Copy verification completes before returning success. The output contains only source files and can be used as the GitHub repository root.

`scripts/source-files.txt` is the explicit reviewed file list, including portable deployment templates. When adding or removing a source file, update that list. Files outside it are excluded even when their extension looks like source code. The exporter also rejects runtime paths, missing entries and symbolic links, including linked parent directories. It retains annotated `.env.example` templates and synthetic test code, but excludes actual configuration, test outputs, dependencies, builds, logs and databases. It cannot remove secrets manually embedded in an allowed source file; review content before publication.

Run `python3 -B tests/export-source.test.py` to verify isolation, repeated exports and overwrite protection with synthetic fixtures.

## Before committing

Install and verify from the clean source directory:

```bash
npm ci --include=dev
npm run verify
```

Prepare Chromium and system dependencies before browser tests; see [Testing](VALIDATION.md). In an existing Git repository, review with these read-only commands:

```bash
git status --short
git diff --stat
git diff --cached --name-only
git diff --cached --check
git ls-files
```

Inspect file lists, templates and example addresses. Check for private domains, server addresses, user-specific absolute paths, test keys and real business data embedded in code. Fixtures should clearly use synthetic values. Verify both documentation languages and their links.

## Build and directory distributions

Python 3 is required. From the project root:

```bash
npm ci --include=dev
npm run check
npm run build
python3 scripts/package-clean.py
```

The script creates `artifacts/codex-cloud-交付包-TIMESTAMP/` containing:

- `源码包/`: development sources without build output.
- `部署包/`: sources plus the current `dist`, without dependencies or runtime data.
- Instructions and `PACKAGE-MANIFEST.json` in each package, with file sizes and SHA-256 hashes verified after copying.

It creates directories, not archives, and does not rebuild. Missing required build outputs cause failure. `--output` only refreshes a recognized distribution directory under `artifacts/` and rejects unexpected extra files. Prefer a new directory for each version.

## ZIP deployment package

```bash
python3 scripts/package-baota.py
```

This script builds first, then writes `baota/codex-cloud-baota-TIMESTAMP.zip` and `.zip.sha256`. The archive includes source, compiled files and a manifest. CRC/content verification does not replace tests, and this is not a database migration backup. Install dependencies on the target OS; do not ship the build machine's `node_modules`.

Both scripts collect by directory/extension and apply some path/file-type checks. Those checks are not a content-level secret scan. Do not place private configuration inside collected directories such as `deploy/` and assume packaging removes it.

## Release provenance

Record the code version, Node/CLI versions, validation evidence and archive digest. Source changes do not automatically update production. Follow [Operations](OPERATIONS.md) to preserve configuration/data, switch builds and verify deployment. Migration archives, actual configuration and server logs do not belong in public Release attachments.
