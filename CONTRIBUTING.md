# Contributing

[English](CONTRIBUTING.md) · [Русский](docs/ru/contributing.md) · [简体中文](docs/zh-CN/contributing.md)

Thank you for helping make the observer more useful and less distracting.

## Local setup

Use Node.js 22.18 or newer and npm. Clone the repository, then run:

```sh
npm ci
npm run check
npm run test:package
```

`check` runs strict TypeScript checking, tests, both builds, and formatting verification. Use `npm run format` to format changes. Tests use synthetic input and local fixtures; they need no account or API key. `test:package` needs registry access to install production dependencies in a temporary directory. It does not contact a model.

## Project layout

| Path                        | Responsibility                                                               |
| --------------------------- | ---------------------------------------------------------------------------- |
| `src/core`                  | Schemas, context preparation, prompt, scheduling, evidence validation, state |
| `src/providers`             | Codex app-server and HTTP transports                                         |
| `src/opencode`              | Server hooks, portable RPC contract, Desktop and TUI                         |
| `src/adapters`              | Transcript normalization, lifecycle hooks, hook installer, MCP               |
| `src/cli.ts`                | User-facing commands and fail-open hook entrypoint                           |
| `test`                      | Deterministic unit and integration tests                                     |
| `scripts/smoke-package.mjs` | Production-only tarball installation smoke test                              |
| `integrations`              | Copyable configuration and observation examples                              |

The core does not import host SDKs. Providers implement `ModelProvider`; stores implement `StateStore`. OpenCode's SDK is a development dependency: the Node adapters use type-only imports and its Desktop bundle resolves shared UI modules through the host. Keep those boundaries intact.

## Changes worth testing

Prefer regression tests for observable behavior: duplicate requests, stale results, lost writes, leaked context, incorrect hook merging, and protocol failures. A prompt improvement needs representative positive and negative examples; “always returns a note” is not a success criterion.

For integration changes, test the supported host version as well as the adapter fixtures. Use synthetic conversations for live smoke checks, and say which host/version you tested. Do not commit real transcripts, credentials, local settings, or copied proprietary implementation material.

## Pull requests

Describe the problem, the behavioral change, and how you verified it. Keep unrelated changes separate. Update the English, Russian, and Simplified Chinese documentation when changing user-facing behavior. Primary source documentation is English; translations should preserve limits and caveats, not just installation commands.

Use clear names and explain non-obvious constraints where necessary. Avoid comments that merely narrate the next line of code. Runtime errors must not echo provider response bodies or private conversation content.

Bug reports should include the host/version, operating system, Node version, observed behavior, expected behavior, and a minimal synthetic reproduction. Remove private context before attaching logs. Report potentially sensitive vulnerabilities through the repository's private vulnerability reporting if available, rather than posting secrets in a public issue.

## Release preparation

1. Update the version and changelog; synchronize the lockfile.
2. Run `npm run check` and `npm run test:package` from a clean checkout.
3. Inspect `npm pack --dry-run` and `npm audit --omit=dev`.
4. Smoke-test native OpenCode loading and a Codex request with synthetic input.
5. Publish only after the maintainer explicitly decides to release. The repository currently documents source installation; do not replace it with a package-install command before a package is available.

The OpenCode build SDK brings a larger development-only dependency graph. Production auditing and isolated installation are separate checks so SDK tooling does not become a runtime dependency accidentally. CI does not run authenticated model checks or automatically publish packages.

As of November 10, 2026, the full development audit reports moderate advisories in the SDK's transitive `glob` and `minimatch` dependencies ([GHSA-3g3m-2fjr-6pw4](https://github.com/advisories/GHSA-3g3m-2fjr-6pw4), [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249)). The SDK still pins affected major versions; these packages are absent from the production install. Recheck upstream SDK updates rather than forcing incompatible major overrides to silence the audit.

Contributions are distributed under the repository's [MIT license](LICENSE).
