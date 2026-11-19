## More reliable notes in long conversations

Version 0.2.2 keeps track of your request through long transcripts and parallel tool calls. Delayed events that identify an earlier turn leave the current turn's quota available.

Claude Code can now check a final reply that arrives while an earlier check is still running. You can also retry a failed observation manually within your existing limits. If your selected model is unavailable, the observer reports that reason.

Two optional settings can reduce the input sent to the observer by compacting repeated tool output or omitting a duplicate response schema for the Codex provider. Both are off by default. You can also enable a local usage log to see the model, duration and reported token counts. [Observer configuration](https://github.com/polanski13/you-should-know/blob/v0.2.2/docs/en/guide.md)

## Install or update in one command

**macOS / Linux**

```sh
curl -fsSL https://github.com/polanski13/you-should-know/releases/latest/download/install.sh | sh
```

**Windows PowerShell**

```powershell
irm https://github.com/polanski13/you-should-know/releases/latest/download/install.ps1 | iex
```

Choose OpenCode, Codex, Claude Code, or MCP when prompted. The installer includes its own Node.js runtime, verifies the archive checksum, adds `ysk` to your user PATH, and preserves existing client settings. No Git, npm, administrator rights, or source build is required.

Archives are available for x64 and ARM64 on macOS, Linux (glibc), and Windows. Node.js and third-party license notices are included. Run the installation command again to update previously connected clients.

The release includes the native OpenCode interface, background Codex/Claude Code hooks, MCP tools, project-scoped notes, and English/Russian/Chinese documentation. Background observations use the selected model's quota.

See the repository README for non-interactive setup and provider configuration.
