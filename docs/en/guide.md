# User and integration guide

[English](guide.md) · [Русский](../ru/guide.md) · [简体中文](../zh-CN/guide.md) · [README](../../README.md)

## Installation and updates

The [README](../../README.md#install) has the one-command installers. Releases include Node.js and support macOS, Linux/glibc, and Windows on x64 and ARM64. macOS/Linux need `curl`, `tar`, and either `shasum` or `sha256sum`; Windows needs PowerShell and `tar` (included in current Windows). Alpine/musl is not supported by the bundled runtime.

Setup connects OpenCode globally and merges Codex/Claude Code hooks. It preserves the first original configuration as `<config-file>.before-ysk`. OpenCode's comments and existing observer options are retained. MCP setup prints a configuration to paste into your client; paste the new configuration again after an update.

For unattended macOS/Linux installation, pass clients explicitly. With an API provider, also pass its model ID:

```sh
curl -fsSL https://github.com/polanski13/you-should-know/releases/latest/download/install.sh | sh -s -- --host claude-code --provider anthropic --model YOUR_MODEL_ID
```

Set `ANTHROPIC_API_KEY` in the client's environment. For an OpenAI-compatible API use `--provider openai-compatible` and `OPENAI_API_KEY`. Provider flags initialize a new configuration; edit the configuration file to change an existing provider. OpenCode uses its own model connection and needs no separate observer provider.

PowerShell accepts explicit clients through the downloaded script:

```powershell
Invoke-WebRequest https://github.com/polanski13/you-should-know/releases/latest/download/install.ps1 -OutFile install.ps1
& ./install.ps1 -Client "opencode,codex"
```

The default installation directory is `~/.local/share/you-should-know` (`$XDG_DATA_HOME/you-should-know` when set), or `%LOCALAPPDATA%\YouShouldKnow` on Windows. Each version has its own `versions/<version>/app` and `runtime` directories. `installation.json` records connected clients and the launcher. Versions are retained so existing sessions can finish using their original files.

The launcher is `~/.local/bin/ysk` on macOS/Linux or `bin\ysk.cmd` under the Windows installation directory. Setup adds it to your shell configuration or Windows user PATH. Open a new terminal, or immediately use the absolute launcher path printed by setup.

Optional environment variables, set before running the installer:

| Variable          | Purpose                            |
| ----------------- | ---------------------------------- |
| `YSK_INSTALL_DIR` | Absolute installation directory    |
| `YSK_BIN_DIR`     | Absolute launcher directory        |
| `YSK_VERSION`     | Exact release version, without `v` |

Use `--no-path` on macOS/Linux or `-NoPath` in PowerShell to manage PATH yourself. `ysk setup --host opencode,codex` connects clients after installation. Running the installer again without a client flag reuses the saved selections and updates their paths. To retry setup after an interruption, use the same installer command.

To disconnect a client, run `ysk uninstall opencode`, `ysk uninstall codex`, or `ysk uninstall claude-code`. Future updates will respect that choice. Remove MCP entries in the client itself. To remove the software, disconnect all clients, close sessions using it, then remove the installation directory and launcher. Remove the marked You Should Know PATH block from your shell configuration, the `you-should-know.fish` file, or the installation's bin directory from Windows user PATH. [Saved notes](#storage-and-data-flow) are kept separately.

### From source

Development installation requires Git, npm, and Node.js 22.18+:

```sh
git clone https://github.com/polanski13/you-should-know.git
cd you-should-know
npm ci
npm run build
npm link
ysk setup --host opencode
```

Keep the checkout in place because registered plugins and hooks refer to it. After pulling changes, run `npm ci` and `npm run build` again.

## Configuration

`ysk init` creates `~/.config/you-should-know/config.json`. If `XDG_CONFIG_HOME` is set, it replaces `~/.config`. The command does not overwrite an existing file.

```json
{
  "observer": {
    "language": "auto",
    "minSteps": 6,
    "minIntervalMs": 120000,
    "maxChecksPerSession": 20,
    "maxChecksPerHour": 8
  },
  "provider": { "type": "codex" }
}
```

The CLI accepts `--config /absolute/path/config.json`. Installed hooks use the standard user configuration. Provider configuration is user-controlled; a repository cannot override the executable, endpoint, or credential source.

To override observer settings for one project, put a plain observer object in `.you-should-know.json` at that workspace's root:

```json
{
  "language": "ru",
  "maxChecksPerHour": 3,
  "minIntervalMs": 300000
}
```

Precedence: defaults → user configuration → project observer settings → OpenCode plugin `options`. Only explicitly supplied override keys replace earlier values. Unknown settings are rejected instead of silently ignored.

| Observer key          | Default  | Allowed values                                              |
| --------------------- | -------- | ----------------------------------------------------------- |
| `enabled`             | `true`   | Boolean                                                     |
| `language`            | `auto`   | `auto`, `en`, `ru`, `zh`                                    |
| `minSteps`            | `6`      | Integer, 1–100                                              |
| `minIntervalMs`       | `120000` | Integer, 0–3,600,000                                        |
| `maxChecksPerSession` | `20`     | Integer, 1–200                                              |
| `maxChecksPerHour`    | `8`      | Integer, 1–120, per project                                 |
| `timeoutMs`           | `45000`  | Integer, 1,000–180,000                                      |
| `maxContextChars`     | `40000`  | Integer, 2,000–120,000                                      |
| `maxMessageChars`     | `6000`   | Integer, 500–20,000                                         |
| `minConfidence`       | `0.85`   | Number, 0.5–1; model-reported, not a calibrated probability |
| `retentionDays`       | `30`     | Integer, 1–365                                              |

The character budget bounds message text. The request also includes instructions, JSON structure, recent note summaries, and known topics. It is not a token or money cap.

## Providers

### Native OpenCode

The native plugin uses `ctx.experimental.generate.text` with the current session model. This is a stateless request with no tools and no session-history writes. The standalone `provider` setting does not change OpenCode's native model.

Server hooks start background work without awaiting inference. Root sessions are observed; subagent sessions are skipped. A new prompt cancels the previous turn's in-process request. RPC calls and notifications are scoped to the workspace and session.

The Desktop interface follows the application locale unless an explicit language is selected. Notes with `language: "auto"` follow the user's latest message. The TUI uses the explicit setting or `LANG` for interface text.

### Codex account

```json
{
  "provider": {
    "type": "codex",
    "executable": "codex"
  }
}
```

Requires Codex **0.162.0+** and an existing sign-in (`codex login`). An optional `model` selects a model available to that account; otherwise Codex chooses its configured default. Set `executable` to an absolute path if Codex is not on the host's PATH.

For each check, the provider starts `codex app-server --stdio` in a temporary empty directory and creates an ephemeral, read-only thread. It disables tools, hooks, plugins, MCP servers, memory, and web search, and supplies no runtime workspace roots or environments. Unexpected tool activity or approval requests terminate the observation. The provider process inherits the local CLI environment for authentication; it is not an operating-system sandbox. The temporary directory is removed afterwards.

Your configured Codex account/provider supplies the quota. The app-server API is version-sensitive. A successful `ysk doctor` checks the installed version, not a real inference; inspect authentication with `codex login status`.

### OpenAI-compatible API

```json
{
  "provider": {
    "type": "openai-compatible",
    "model": "MODEL_ID",
    "baseUrl": "https://api.openai.com/v1",
    "apiKeyEnv": "OPENAI_API_KEY"
  }
}
```

Set the named environment variable in the environment that launches the host. Use a real model ID offered by that endpoint. The endpoint must support Chat Completions with `response_format: { "type": "json_object" }`. Requests contain no tools. The official OpenAI endpoint receives `max_completion_tokens`; other endpoints receive `max_tokens`. A provider that lacks these fields is not automatically compatible.

The key is required, including for local endpoints; a local service that ignores authentication can use a non-secret placeholder. Credentials are never read from project settings. Redirects are rejected rather than forwarding credentials to another endpoint.

### Anthropic API

```json
{
  "provider": {
    "type": "anthropic",
    "model": "MODEL_ID",
    "apiKeyEnv": "ANTHROPIC_API_KEY"
  }
}
```

Uses the Messages API at `https://api.anthropic.com/v1/messages` by default, Bearer authentication, and API version `2026-10-21`. An optional `baseUrl` replaces the `/v1` base. The model must support text responses. This uses API credentials and billing, not a Claude Code subscription.

## Hooks

| Host        | File                                                             |
| ----------- | ---------------------------------------------------------------- |
| Codex       | `$CODEX_HOME/hooks.json`, or `~/.codex/hooks.json`               |
| Claude Code | `$CLAUDE_CONFIG_DIR/settings.json`, or `~/.claude/settings.json` |

`ysk install <host>` registers four events:

- `PostToolUse` and `Stop`: asynchronous, bounded transcript read and possible model request; always return `{}`.
- `UserPromptSubmit`: synchronous, invalidates an earlier request's result and delivers one pending local note using `systemMessage`; no inference.
- `SessionEnd`: invalidates pending results.

Codex hooks must be enabled, for example with `codex --enable hooks`. A short turn with fewer than `minSteps` tool-result events will stay quiet, including at `Stop`. Parallel tool results count as their transcript represents them; cadence is not a count of wall-clock actions.

Background output does not inject instructions into the working agent. Claude's asynchronous hooks do not surface `systemMessage` directly, so delivery happens at the next prompt. Use `ysk watch` to see notes sooner. The actual display of hook messages depends on the host interface.

The installer is idempotent, writes atomically, and preserves a first backup as `<config-file>.before-ysk`. It refuses malformed JSON or unexpected hook structures. Uninstall removes registrations marked `--managed-by-ysk`; it does not restore an old file over newer user changes. Hook commands use absolute paths to the runtime and CLI, including the bundled Node.js in release installations.

Hook processes share on-disk reservations. A new prompt invalidates the reservation so a stale result cannot be saved. Unlike in-process OpenCode cancellation, a different hook process may continue its already-started request until completion or timeout, consuming quota.

## CLI and MCP

`ysk --help` lists commands. `notes`, `show`, `feedback`, `doctor`, and `check` support `--json`; `--session` filters `notes` and `watch`. Feedback values are `known`, `helpful`, `dismissed`, and `irrelevant`.

`known` and `helpful` remember a topic for this project. All offered topics are deduplicated while their notes remain retained. Unread notes expire when a new observed turn begins; after repeated ignored notes the observer skips more eligible checks. Feedback resets this backoff. `pause` persists across process restarts.

For an explicit check, pipe an observation into the CLI:

```sh
ysk check --manual --json < integrations/observation.json
```

This is a real model request. `--manual` bypasses cadence, cooldown, and backoff; it does not bypass budgets, pause, identical context, an existing request, or the one-note-per-turn rule.

Observation input has `host`, `sessionId`, `turnId`, `step`, and `messages`. Each message has a unique `id`, a `role` (`user`, `assistant`, or `tool`), and `text`. Include the user's goal as well as relevant agent/tool output. CLI input is capped at 2 MB.

The MCP server uses the same runtime and limits:

| Interface      | Behavior                                                                       |
| -------------- | ------------------------------------------------------------------------------ |
| `ysk_observe`  | Observation input without `host`; up to 100 messages; may make a model request |
| `ysk_notes`    | Optional `sessionId`; reads local notes                                        |
| `ysk_feedback` | `id` and `feedback`; records explicit user feedback                            |
| `ysk://notes`  | JSON resource containing local project notes                                   |

MCP does not automatically subscribe to another client's conversation. Its client must choose when to call `ysk_observe` and provide `step` accordingly. Use `--cwd` when starting the server so the project scope is explicit. Server stdout is reserved for protocol messages.

## Storage and data flow

```text
Host conversation
  → normalize text and bound context
  → redact common credentials
  → reserve a budgeted check in project state
  → text-only model request
  → validate schema, confidence, quotes and freshness
  → deduplicate and save one note
  → host UI / next-prompt hook / watch / MCP
```

State lives under `$XDG_STATE_HOME/you-should-know`, or `~/.local/state/you-should-know`. `YSK_DATA_DIR` overrides that root. Each canonical workspace path maps to `projects/<path-hash>/state.json`. Symlinked paths share state; different directories and worktrees have separate state, even inside one repository. Run CLI commands from the same workspace used by the host.

Saved state contains notes and their evidence, feedback, known topic names, session IDs, turn IDs, hashes, timestamps, budgets, and temporary reservations. It does not save full transcripts, model reasoning, credentials, or raw provider responses. Notes themselves can contain private project information.

Limits are 100 notes, 100 known topics, and 64 recently used session records per project. Session budgets depend on retained session records. Expiration occurs on observation, reading notes, delivery, and feedback, rather than through a background eraser. Old files in an unused project remain until the project is accessed or you remove them.

New directories/files use modes `0700`/`0600` on POSIX; Windows access is governed by inherited ACLs. Writes are protected by inter-process locks and atomic replacement. Corrupt or unsupported state is preserved and reported, never silently reset. `ysk uninstall` retains state. To erase it, stop observers and remove the relevant project directory under the state root; do not delete another project's directory.

## Troubleshooting

| Symptom                                                   | Check                                                                                                                                      |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| No notes                                                  | Silence is expected. Check `enabled`, `ysk resume`, cadence, budgets, and whether context has changed.                                     |
| `ysk` not found                                           | Open a new terminal, or use the launcher path printed by setup. With `--no-path`, add its directory to PATH yourself.                      |
| OpenCode plugin unavailable                               | Use a directory path, build `dist`, and check plugin status. Desktop needs a global entry.                                                 |
| Codex hooks do nothing                                    | Check Codex version, enable `hooks`, and confirm `CODEX_HOME` matches the running client.                                                  |
| Claude hooks do nothing                                   | Confirm asynchronous hook support, provider setup, and `CLAUDE_CONFIG_DIR`.                                                                |
| Notes appear in `watch` but not immediately in the client | Hook delivery happens on the next prompt; UI support varies by host.                                                                       |
| HTTP `provider_error`                                     | Run `ysk doctor`; check model ID, key environment variable, endpoint format, and quota. Provider error bodies are deliberately not echoed. |
| `invalid_response`                                        | The model did not satisfy the strict note schema; no note is saved.                                                                        |
| `unsubstantiated`                                         | A quote was missing from the selected context or the output failed redaction checks.                                                       |
| State error                                               | Back up and inspect the indicated state directory; corrupt files are preserved.                                                            |

## Compatibility and verification

The project targets OpenCode's V2 plugin contract (`@opencode/plugin ~2.2.6`), Codex app-server/hooks as of `0.162.0`, and MCP SDK `1.x`. Desktop GUI and Codex app-server APIs may change. Upgrade deliberately and rerun the package smoke test.

Automated checks cover core state transitions, adapters, subprocess and HTTP protocols, MCP interaction, and a production-only package install. Live Codex authentication and OpenCode server/RPC have been smoke-tested on macOS with synthetic input. Claude Code hook rendering and host-level behavior on other operating systems still depend on the host version; passing portable package tests is not a claim of full host UI certification.
