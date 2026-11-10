# You Should Know

**为编程智能体提供安静的第二视角。**

[English](README.md) · [Русский](README.ru.md) · [简体中文](README.zh-CN.md)

[![CI](https://github.com/polanski13/you-should-know/actions/workflows/ci.yml/badge.svg)](https://github.com/polanski13/you-should-know/actions/workflows/ci.yml)
[![MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

智能体完成任务时，可能没有解释某个重要后果。You Should Know 在后台观察对话，仅在某个发现可能影响你的决定时，提供简短且附有原文依据的提示。

> **请留意** · 缓存会提高只问一个问题的用户的成本。
>
> 首次请求的成本增加了 25%，而目前大多数用户只问一个问题。这可能不利于将月度费用控制在 100 美元以内。在为所有用户启用缓存之前，值得先检查用户继续追问的频率。
>
> **依据：**“首次请求的成本增加了 25%”

_以上为示例。大多数检查应当保持安静，不产生提示。_

## 功能

- 发现重要取舍、隐藏成本、与用户目标的偏差，以及缺乏依据的成功声明。
- 只有能够引用对话原文作为依据时，才保存提示。
- 按项目记住你已经理解的主题。
- 独立于主智能体运行，不向观察模型提供工具，也不自动修改文件。
- 限制检查频率和请求预算；提示被忽略时会降低频率。
- 支持英语、俄语、中文，也可跟随最新用户消息的语言。

**即使没有生成提示，后台检查也会消耗模型额度。** 本项目不提供独立的云服务或订阅。

## 集成

| 客户端              | 观察方式                                            | 提示位置                                      |
| ------------------- | --------------------------------------------------- | --------------------------------------------- |
| **OpenCode 2.2.x**  | 原生服务端插件，使用当前对话的模型与已有账户        | Desktop 输入框上方的提示；TUI 通知和 `/ysk`   |
| **Codex 0.162.0+**  | 异步生命周期钩子；默认使用已登录的 Codex app-server | 下一次提交消息时，或通过 `ysk watch` 实时查看 |
| **Claude Code**     | 异步命令钩子，使用配置的观察模型提供商              | 下一次提交消息时，或通过 `ysk watch` 查看     |
| **其他 MCP 客户端** | 通过 stdio 显式调用 `ysk_observe`                   | 工具响应及已保存的提示                        |

OpenCode Desktop 扩展 API 仍为实验性接口。MCP 集成需要客户端主动提供上下文并调用工具。Claude Code 钩子不会复用 Claude 订阅；请为观察器配置 Codex 登录或 API 提供商。

## 安装

**macOS / Linux**

```sh
curl -fsSL https://github.com/polanski13/you-should-know/releases/latest/download/install.sh | sh
```

**Windows PowerShell**

```powershell
irm https://github.com/polanski13/you-should-know/releases/latest/download/install.ps1 | iex
```

按提示选择编码客户端。安装器下载自带 Node.js 的发行包，验证 SHA-256，并在保留现有设置的同时连接所选客户端。**不需要 Git、npm、源码构建或管理员权限。** 请先安装编码客户端并完成模型提供商的身份验证。

支持 macOS、使用 glibc 的 Linux 和 Windows，均提供 x64 与 ARM64 版本。打开新终端后即可使用 `ysk`。再次运行相同安装命令，会更新之前连接的所有客户端。

macOS/Linux 上可直接指定客户端：

```sh
curl -fsSL https://github.com/polanski13/you-should-know/releases/latest/download/install.sh | sh -s -- --host opencode,codex
```

以后可通过 `ysk setup --host claude-code` 添加客户端。自定义路径、无人值守安装和源码安装见[安装指南](docs/zh-CN/guide.md#安装与更新)。

### OpenCode

在安装向导中选择 **OpenCode**。安装器添加全局插件配置，连接服务端、TUI 和 Desktop，并保留 JSONC 注释及现有插件选项。OpenCode 会自动应用配置变更，并使用已连接的模型。

继续正常工作即可。有值得提醒的发现时，会出现紧凑的**请留意**或**值得了解**标签。点击后可阅读摘要、解释和原文依据。**明白了**和**我已了解**会记住该主题。Desktop 中的**在对话中讨论**会把提示插入输入框，由你决定是否发送；TUI 中选择讨论会直接发送明确的后续消息。

### Codex

```sh
codex login
ysk doctor
```

在向导中选择 **Codex**。安装器合并 `hooks.json`、备份原文件，并在 Codex CLI 可用时启用钩子。若无法自动启用，请使用 `codex --enable hooks` 启动。后台检查不会阻塞工具执行。同步的 `UserPromptSubmit` 钩子会在下一次提交消息时显示待处理提示。

要实时查看提示，请在另一个终端中，进入**当前工作项目的目录**后运行：

```sh
ysk watch
```

### Claude Code

在向导中选择 **Claude Code**，并使用支持异步命令钩子的版本。向导连接钩子，并帮助选择观察器的提供商：已登录的 Codex CLI、OpenAI 兼容 API 或 Anthropic API。API 提供商需要模型 ID 和客户端环境中的 API 密钥。通过 `ysk doctor` 检查配置，详见[使用指南](docs/zh-CN/guide.md#模型提供商)。

### MCP

在向导中选择 **Another MCP client**，或运行 `ysk setup --host mcp`。将输出的 `mcpServers` 配置复制到客户端，并把 `/absolute/path/to/project` 替换为工作目录。生成的命令使用内置 Node.js 的绝对路径，因此无需客户端继承终端的 PATH。请按客户端要求调整外层结构，更新后重新粘贴新配置。

工具包括 `ysk_observe`、`ysk_notes`、`ysk_feedback`。提示资源为 `ysk://notes`。反馈必须代表用户明确表达的意见。

## 常用命令

在项目目录运行，或附加 `--cwd /path/to/project`：

```sh
ysk notes
ysk show <note-id>
ysk feedback <note-id> known
ysk pause
ysk resume
ysk watch
```

通过 `ysk uninstall opencode`、`ysk uninstall codex` 或 `ysk uninstall claude-code` 断开客户端，并将其从后续更新列表中移除。已保存的提示和其他设置会被保留；删除安装文件的方法见指南。

## 默认设置

| 设置     | 默认值                                                |
| -------- | ----------------------------------------------------- |
| 检查频率 | OpenCode 每 6 个模型步骤；钩子转录每 6 个工具结果事件 |
| 冷却时间 | 每个会话 120 秒                                       |
| 请求预算 | 每个会话 20 次；每个项目每小时 8 次                   |
| 超时     | 45 秒                                                 |
| 对话文本 | 最多 40,000 字符；每条消息 6,000 字符                 |
| 提示     | 每轮最多 1 条；每个项目最多保留 100 条                |
| 保留期限 | 30 天，访问时清理                                     |

详见[配置](docs/zh-CN/guide.md#配置)。手动检查可跳过频率和冷却限制，但仍受预算、暂停状态及去重规则约束。

## 隐私与限制

观察器会将有长度限制的对话片段发送给所选模型提供商。OpenCode 使用原生无状态文本生成 API。Codex 使用临时只读线程，并关闭工具、MCP、插件和钩子。HTTP 提供商只接收文本请求。

常见凭据会在推理前进行脱敏。**脱敏是尽力而为的措施，不能保证覆盖所有秘密。** 提示包含简短原文引用，按项目保存在权限受限的本地文件中。项目没有遥测，也没有集中式提示服务器。模型提供商的数据与计费政策仍然适用。

引用验证只能确认原文存在，不能保证模型的解释正确。请将提示用于辅助判断。存储位置、取消行为和排查方法见[完整指南](docs/zh-CN/guide.md)。

## 开发

```sh
npm ci
npm run check
npm run test:package
```

测试覆盖取消、并发、预算、依据验证、配置优先级、转录解析、钩子安装、模型传输层和 MCP 交互。打包冒烟测试会在全新目录中安装不含开发依赖的压缩包，并运行真实 CLI 和公共导出。

[参与开发](docs/zh-CN/contributing.md) · [更新日志](CHANGELOG.md) · [集成示例](integrations)

## 许可证与来源

[MIT](LICENSE)，© 2026 polanski13。

这是受后台“值得了解”观察器理念启发的独立实现，不包含 Anthropic 的实现代码或专有提示词，与 Anthropic、OpenAI 和 OpenCode 均无隶属关系。
