# You Should Know

**A quiet second opinion for your coding agent.**

[English](README.md) · [Русский](README.ru.md) · [简体中文](README.zh-CN.md)

[![CI](https://github.com/polanski13/you-should-know/actions/workflows/ci.yml/badge.svg)](https://github.com/polanski13/you-should-know/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%E2%89%A522.18-417e38.svg)](https://nodejs.org/)

Your agent can finish a task while leaving an important consequence unexplained. You Should Know watches the conversation in the background and offers a short, evidence-backed note when something could change your decision.

> **Heads up** · Caching raises the cost for people who ask only one question.
>
> The first request costs 25% more, and most users currently ask only one question. That can work against your $100 monthly budget. Check how often people actually follow up before enabling caching for everyone.
>
> **Based on:** “Every first request costs 25% more”

_Illustrative example. Most checks should produce no note._

## What it does

- Notices consequential tradeoffs, overlooked costs, goal mismatches, and unsupported claims of success.
- Requires supporting quotes from the conversation before saving a note.
- Remembers the topics you already understand, within each project.
- Runs separately from the working agent, with no model tools or automatic edits.
- Limits frequency and request budgets; backs off when you ignore notes.
- Speaks English, Russian, or Chinese, or follows the language of your latest message.

**Background checks consume model quota even when they return no note.** There is no separate service or subscription from this project.

## Integrations

| Client                | Observation                                                              | Where notes appear                                                    |
| --------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| **OpenCode 2.2.x**    | Native server plugin; uses the conversation's model and existing account | Desktop composer pill with evidence and actions; TUI toast and `/ysk` |
| **Codex 0.162.0+**    | Asynchronous lifecycle hooks; authenticated Codex app-server by default  | On your next prompt, or live with `ysk watch`                         |
| **Claude Code**       | Asynchronous command hooks; uses your configured observer provider       | On your next prompt, or live with `ysk watch`                         |
| **Other MCP clients** | Explicit `ysk_observe` calls over stdio                                  | Tool responses and saved notes                                        |

OpenCode's Desktop extension API is experimental. MCP is an on-demand integration: the client must supply context and call the tool. Claude Code hooks do not reuse a Claude subscription; choose Codex authentication or an API provider for the observer.

## Install from source

The project is currently distributed from this repository. **No npm release is required for these instructions.**

You need Node.js **22.18+**, npm, and Git.

```sh
git clone https://github.com/polanski13/you-should-know.git
cd you-should-know
npm ci
npm run build
npm link
```

Keep the checkout in place: local plugins and installed hooks refer to it. After updating the source, run `npm ci && npm run build` again.

### OpenCode

Add the **absolute path to the repository directory** to your global `~/.config/opencode/opencode.json` or `.jsonc`. Merge with your existing `plugins` array.

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "/absolute/path/to/you-should-know",
      "options": { "language": "auto" },
    },
  ],
}
```

One entry loads the server, TUI, and Desktop parts. Desktop requires the global entry; project-local configuration loads the server/TUI parts. OpenCode reloads configuration automatically.

Continue working normally. A note appears when a check finds something worth surfacing. Expand the pill to read the explanation and evidence. **Understood** and **I knew this** remember the topic; **Discuss in chat** puts the note in the Desktop composer for you to send. In the TUI, selecting Discuss sends an explicit follow-up.

### Codex

```sh
codex login
ysk init
ysk doctor
ysk install codex
codex --enable hooks
```

The installer merges `hooks.json`, preserves unrelated hooks, and backs up the original file. Background hooks save notes without blocking tool execution. A synchronous `UserPromptSubmit` hook delivers a pending note on your next prompt.

For immediate visibility, run this in another terminal **inside the project you are working on**:

```sh
ysk watch
```

### Claude Code

Use a Claude Code version supporting asynchronous command hooks. First configure the observer provider with `ysk init` and check it with `ysk doctor`, then:

```sh
ysk install claude-code
```

The default provider is your signed-in Codex CLI. You can instead select an OpenAI-compatible or Anthropic API provider in the [guide](docs/en/guide.md#providers).

### MCP

Add a stdio server to your client's configuration. This example uses the common `mcpServers` format; adapt the wrapper to your client:

```json
{
  "mcpServers": {
    "you-should-know": {
      "command": "node",
      "args": [
        "/absolute/path/to/you-should-know/dist/cli.js",
        "mcp",
        "--cwd",
        "/absolute/path/to/project"
      ]
    }
  }
}
```

Available tools: `ysk_observe`, `ysk_notes`, `ysk_feedback`. Saved notes are also available at `ysk://notes`. Feedback should represent the person's explicit response.

## Everyday commands

Run these from the project directory, or supply `--cwd /path/to/project`:

```sh
ysk notes
ysk show <note-id>
ysk feedback <note-id> known
ysk pause
ysk resume
ysk watch
```

Remove hook registrations with `ysk uninstall codex` or `ysk uninstall claude-code`. Remove the plugin entry to disconnect OpenCode. Uninstalling preserves saved notes and unrelated settings.

## Sensible defaults

| Setting           | Default                                                                         |
| ----------------- | ------------------------------------------------------------------------------- |
| Check cadence     | Every 6 model steps in OpenCode; every 6 tool-result events in hook transcripts |
| Cooldown          | 120 seconds per session                                                         |
| Request budget    | 20 per session; 8 per hour per project                                          |
| Timeout           | 45 seconds                                                                      |
| Conversation text | Up to 40,000 characters; 6,000 per message                                      |
| Notes             | At most one per turn; 100 retained per project                                  |
| Retention         | 30 days, pruned on access                                                       |

See the [configuration guide](docs/en/guide.md#configuration) for overrides. Manual checks bypass cadence and cooldown, but still respect budgets, pause, and deduplication.

## Privacy and limitations

The observer sends a bounded conversation excerpt to the selected model provider. OpenCode uses its native stateless text-generation API; Codex uses an ephemeral, read-only thread with tools, MCP, plugins, and hooks disabled. HTTP providers receive text-only requests.

Common credentials are redacted before inference. **Redaction is best-effort, not a guarantee.** Saved notes include short evidence quotes and live in private, project-scoped local files. There is no project telemetry or central note server. Your model provider's data and billing policies still apply.

Evidence validation confirms that a quote exists; it cannot guarantee the model's interpretation. Treat notes as decision support. For storage locations, cancellation behavior, and troubleshooting, read the [full guide](docs/en/guide.md).

## Development

```sh
npm ci
npm run check
npm run test:package
```

The test suite exercises cancellation, concurrency, budgets, evidence validation, configuration precedence, transcript parsing, hook installation, provider transports, and MCP interaction. The package smoke test installs the tarball in a fresh directory without development dependencies and runs the actual CLI and public exports.

[Contributing](CONTRIBUTING.md) · [Changelog](CHANGELOG.md) · [Guide](docs/en/guide.md) · [Integration examples](integrations)

## License and origin

[MIT](LICENSE), © 2026 polanski13.

An independent implementation inspired by the idea of a background “you should know” observer. It does not contain Anthropic's implementation or proprietary prompt, and is not affiliated with Anthropic, OpenAI, or OpenCode.
