## Install in one command

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
