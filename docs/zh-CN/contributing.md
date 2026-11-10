# 参与开发

[English](../../CONTRIBUTING.md) · [Русский](../ru/contributing.md) · [简体中文](contributing.md)

感谢你帮助观察器变得更有用、更少打扰。

## 本地准备

需要 Node.js 22.18+ 和 npm。克隆仓库后运行：

```sh
npm ci
npm run check
npm run test:package
npm run build:release
npm run test:release
```

`check` 执行严格类型检查、测试、两种构建以及格式检查。使用 `npm run format` 格式化修改。测试使用合成输入和本地夹具，不需要账户或 API 密钥。`test:package` 需要访问 npm 注册表以安装生产依赖，但不会调用模型。

`build:release` 将应用打包为无外部 Node 包依赖的产物。`test:release` 下载官方 Node.js，通过本地 HTTP 服务，在隔离的主目录中运行真实安装器，检查校验失败、安装、升级、启动器、原生导出和 MCP。它需要访问 nodejs.org，不会调用模型或修改你的客户端设置。

## 项目结构

| 路径                        | 职责                                           |
| --------------------------- | ---------------------------------------------- |
| `src/core`                  | 结构定义、上下文、提示词、调度、引用验证和状态 |
| `src/providers`             | Codex app-server 与 HTTP 传输层                |
| `src/opencode`              | 服务端、RPC、Desktop 和 TUI                    |
| `src/adapters`              | 转录解析、生命周期钩子、安装器与 MCP           |
| `src/setup`                 | 安装向导、JSONC 注册、启动器、PATH 与安装记录  |
| `src/cli.ts`                | 用户命令与出错时不中断宿主的钩子入口           |
| `test`                      | 确定性的单元和集成测试                         |
| `scripts/smoke-package.mjs` | 仅含生产依赖的安装冒烟测试                     |
| `scripts/build-release.mjs` | 独立打包、平台归档与校验和                     |
| `scripts/smoke-release.mjs` | 内置运行时安装器冒烟测试                       |
| `integrations`              | 配置和观察输入示例                             |

核心不导入宿主 SDK。提供商实现 `ModelProvider`，存储实现 `StateStore`。OpenCode SDK 是开发依赖：Node 适配器仅导入类型，Desktop 包从宿主获得共享 UI 模块。请保持这些边界。

## 测试与 pull request

优先为可观察行为添加回归测试，例如重复请求、过期结果、丢失写入、上下文泄露、错误合并钩子和协议失败。提示词改进应同时有正反例；“总能生成提示”并不代表成功。

集成修改应同时在支持的宿主版本和适配器夹具上验证。真实请求使用合成对话，并注明测试过的宿主版本。不要提交真实转录、凭据、本地设置或复制的专有实现材料。

PR 应说明问题、行为变化和验证方法，不混入无关修改。改变用户行为时，同步更新英语、俄语和简体中文文档。主文档使用英语；翻译应保留限制和注意事项，而不仅是安装命令。

使用清晰的命名，只解释不明显的约束，避免复述代码的注释。运行时错误不得回显提供商响应正文或私密对话。问题报告应包含宿主与版本、操作系统、Node 版本、预期和实际行为，以及最小合成复现。敏感漏洞请使用仓库的私密报告渠道（如果已启用），不要在公开 issue 中发布秘密。

## 发布准备

1. 更新 `package.json`、`src/version.ts`、两个安装器、更新日志和 `docs/en/release-notes.md`，并同步锁文件。
2. 在干净检出中运行 `npm run check`、`npm run test:package`、`npm run build:release` 和 `npm run test:release`。
3. 检查 `npm pack --dry-run` 和 `npm audit --omit=dev`。
4. 使用合成输入验证 OpenCode 原生加载及 Codex 请求。
5. 通过 `npm run build:release -- --archives` 构建六个平台归档，也可用 `--platform linux-x64` 指定平台。检查 Node.js 和第三方许可证是否齐全。
6. 推送版本标签（如 `v0.2.0`）以发布 GitHub Release。发布工作流先执行 Linux、macOS 和 Windows 检查，再发布安装器、归档和 `SHA256SUMS`。发布后在隔离主目录中验证公开安装器。

OpenCode 构建 SDK 的开发依赖较多。独立的生产审计和安装测试用于防止 SDK 工具意外成为运行时依赖。CI 不执行需要登录的模型请求。版本标签发布 GitHub Releases，不需要发布 npm 包。官方 Node.js 版本固定在 `scripts/runtime.mjs` 中，下载归档会按 Node.js 发布的 SHA-256 校验和验证。

截至 2026 年 11 月 10 日，完整开发依赖审计报告了 SDK 间接依赖 `glob` 和 `minimatch` 的中危问题（[GHSA-3g3m-2fjr-6pw4](https://github.com/advisories/GHSA-3g3m-2fjr-6pw4)、[GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249)）。SDK 仍固定使用受影响的主版本；生产安装不包含这些包。应关注上游 SDK 更新，而不是为了清空审计结果而强制覆盖不兼容的主版本。

所有贡献遵循仓库的 [MIT 许可证](../../LICENSE)。
