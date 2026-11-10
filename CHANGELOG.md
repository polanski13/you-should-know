# Changelog

## 0.2.0 — 2026-11-11

### Added

- One-command macOS/Linux and Windows installers with a bundled Node.js runtime; Git, npm, and administrator rights are not required.
- Interactive `ysk setup`, explicit multi-client selection, automatic OpenCode registration, and Codex hook enablement.
- Versioned installations, SHA-256 verification, per-user launchers, PATH setup, and saved client selections for updates.
- Standalone GitHub Release archives for macOS, Linux/glibc, and Windows on x64 and ARM64, with runtime and third-party license notices.
- Cross-platform installer smoke tests and a tag-triggered release workflow.

### Changed

- Hook commands use absolute runtime paths, so a separate Node.js installation is unnecessary.
- OpenCode setup preserves JSONC comments, existing settings, and observer options when moving from a source checkout or an older release.
- Disconnecting a client removes it from the saved update targets while keeping notes and unrelated settings.
- English, Russian, and Simplified Chinese documentation now leads with one-command installation.

## 0.1.0 — 2026-11-10 (source preview)

### Added

- Shared observer core with bounded context, evidence validation, project-scoped feedback, deduplication, request budgets, cancellation, and stale-result rejection.
- Native OpenCode V2 server, Desktop composer pill, and TUI `/ysk` integration.
- Authenticated Codex app-server provider with ephemeral, tool-free observations.
- OpenAI-compatible Chat Completions and Anthropic Messages providers.
- Asynchronous Codex and Claude Code hooks with next-prompt delivery and a live terminal feed.
- Idempotent hook installation and removal with original-file backups.
- Portable stdio MCP tools and a project-notes resource.
- CLI for configuration, observations, notes, feedback, pause/resume, and diagnostics.
- English, Russian, and Simplified Chinese interface copy and documentation.
- Deterministic tests, cross-platform CI, and a production-only package installation check.

### Distribution

- Source installation is the supported initial path. No npm release is implied by this entry.
- Independently authored implementation and prompt, licensed under MIT.
