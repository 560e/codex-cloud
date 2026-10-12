# Changelog

[简体中文](../RELEASE.md) · [Documentation](INDEX.md) · [Project home](../../README.en.md)

This page records user-visible source changes and upgrade considerations, not deployment to a particular server. `package.json` remains at `1.0.0`; maintenance updates below are organized by date. Keep test evidence with each release; see [Testing](VALIDATION.md) for procedures.

## 2026-10-11: renamed to Codex Cloud

The UI, documentation, package name, new installation service and directory defaults, and export filenames now use Codex Cloud. Migration imports still accept archives created before the rename. Existing deployments should keep their actual data directory, Codex home and service account. Before adopting the new service or directory names, stop the previous service and follow [Operations](OPERATIONS.md) to back up and migrate the data so two instances cannot share one data directory.

## 2026-10-11: concise extension lists

Skill and MCP entries in Settings now show only their names and action buttons. Descriptions, connection commands and status details are removed from the lists; full configuration remains available in the editors.

## 2026-10-11: search within a conversation

The sidebar search button beside New conversation is removed and the new conversation button fills the row. A search action at the top right of the conversation workspace highlights and locates text, counts matches and provides Previous and Next navigation. Searching loads the current conversation's older history pages.

## 2026-10-11: archived conversation management

Settings adds an Archived conversations tab that loads, groups and paginates archived items independently for each project. Conversations can be restored individually; successful restores disappear immediately and publish the existing real-time event so recent conversation lists resynchronize. Empty projects stay hidden, while project-specific load errors remain visible for retry.

## 2026-10-11: editable queues and project HTML preview

Pending and paused messages now support full-body editing while preserving attachments, references, model settings and queue position. Concurrent edits or submission are detected; queue drain reads the latest saved payload. Project HTML files open in a sandboxed preview with a source toggle, relative static resources and JavaScript module support. Preview grants are temporary and tied to the originating login session.

## 2026-10-11: conversation exports and termination icon

The conversation menu now provides TXT, Markdown and standalone HTML exports for the full currently open conversation, including history pages not yet loaded in the browser. Downloads preserve tool output and file diffs, report failures without partial files, and support cancellation. The force-stop action now uses an octagon with an X to distinguish it from a normal stop button.

## 2026-10-11: independent compaction controls and source export

Add project provides an optional 1M context window and an independent 50%–90% compaction slider in 10% steps, defaulting to 90%. The CLI checks the model's usable context after each final response. Enabling 1M additionally sets the window and token limit; see [Configuration](CONFIGURATION.md). Settings persist per project and apply to thread creation, resume, fork and queued execution.

`python3 scripts/export-source.py` exports a clean source directory without installing dependencies or building. It copies only reviewed paths in `scripts/source-files.txt`, verifies copied content and refuses existing output directories. Real environments, runtime data and build outputs are excluded. See [Source delivery](SERVER-SOURCE.md).

## 2026-10-11: concurrent conversations

Conversations in the same or different projects can now execute concurrently under the global capacity limit. Each conversation remains serial, excess tasks queue, and starting tasks count toward capacity. Installer and Linux-template defaults are now 3.

For an existing installation, inspect `.env` in the running application directory. Change `MAX_CONCURRENT_TURNS=1` to the desired capacity, such as `3` (range 1–16), deploy the new version and restart. Upgrading does not overwrite existing configuration. Same-project conversations share files; no worktree is created automatically.

## 2026-10-11: configuration and documentation

- `.env.example` and the Linux template explain each setting, defaults/examples, constraints and restart requirements. Installer-generated configuration retains comments.
- Documentation is organized around use, deployment, operations and development, with a centralized configuration reference and expanded API, recovery and acceptance procedures in both languages.
- Duplicate architecture and standalone requirements/acceptance pages are consolidated; historical repair diaries are removed. Source delivery retains application assets, test code and lockfiles while excluding real configuration and runtime output.

Updating templates does not rewrite an existing `.env`. Retain actual values and compare them with [Configuration](CONFIGURATION.md); do not overwrite a live configuration with a template.

## 2026-10-10: provider catalogs and outbound proxies

Provider settings gain Fetch models. Successful requests save model IDs and a timestamp; only another explicit fetch refreshes them. Reloads and service restarts use the saved custom-provider catalog. Failures preserve the previous list, and manual editing remains available. The default model is separate; fetching neither activates a provider nor restarts the executor.

Outbound HTTP(S) proxies can be loaded from `.env`. Backend fetch is configured after environment loading, and CLI children inherit proxy variables. Proxy settings apply to the instance without changing each provider URL.

Install locked dependencies, rebuild and restart the backend when upgrading. Identical variables in existing systemd overrides still take precedence over `.env`; inspect their source using [Operations](OPERATIONS.md). Without a configured proxy, existing network behavior remains. See [Providers](PROVIDERS.md) for catalog endpoints and format limits.

## 2026-10-10: file viewing and local launchers

The file drawer adds image previews, enlargement, zoom and fit-to-window, with error feedback and download paths for invalid or oversized images. Supported formats and limits are in the [User guide](PRODUCT.md). Windows `.bat` and macOS `.command` local launchers were added; initial dependency installation, password setup and building are still required.

## 2026-10-09 and earlier: core workbench features

Settings moved to grouped management for providers, extensions, runtime, data and accounts. Conversation rendering improved per-message records and tool output. Existing features include conversation operations, approvals/queues, provider switching, Skills/MCP, usage and migration. Current boundaries are listed in [Executor coverage](CODEX-API-COVERAGE.md); historical entries do not establish present platform compatibility.

## Upgrading

Back up programs and data, then follow [Operations](OPERATIONS.md) for updating and verification. See [Source and distribution](SERVER-SOURCE.md) for GitHub and package contents.
