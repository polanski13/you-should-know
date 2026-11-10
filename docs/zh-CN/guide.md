# 用户与集成指南

[English](../en/guide.md) · [Русский](../ru/guide.md) · [简体中文](guide.md) · [README](../../README.zh-CN.md)

## 配置

`ysk init` 创建 `~/.config/you-should-know/config.json`。设置 `XDG_CONFIG_HOME` 后，它将替代 `~/.config`。已有文件不会被覆盖。

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

CLI 接受 `--config /absolute/path/config.json`。已安装的钩子使用标准用户配置。提供商配置由用户控制，仓库不能覆盖可执行文件、API 地址或凭据来源。

要覆盖某个项目的观察设置，请在工作目录根目录创建 `.you-should-know.json`，直接填写观察器设置：

```json
{
  "language": "zh",
  "maxChecksPerHour": 3,
  "minIntervalMs": 300000
}
```

优先级：默认值 → 用户配置 → 项目观察设置 → OpenCode 插件 `options`。只有显式提供的键才会覆盖之前的值。未知配置项会被拒绝。

| 配置键                | 默认值   | 允许范围                                |
| --------------------- | -------- | --------------------------------------- |
| `enabled`             | `true`   | 布尔值                                  |
| `language`            | `auto`   | `auto`、`en`、`ru`、`zh`                |
| `minSteps`            | `6`      | 整数，1–100                             |
| `minIntervalMs`       | `120000` | 整数，0–3,600,000                       |
| `maxChecksPerSession` | `20`     | 整数，1–200                             |
| `maxChecksPerHour`    | `8`      | 整数，1–120，按项目计算                 |
| `timeoutMs`           | `45000`  | 整数，1,000–180,000                     |
| `maxContextChars`     | `40000`  | 整数，2,000–120,000                     |
| `maxMessageChars`     | `6000`   | 整数，500–20,000                        |
| `minConfidence`       | `0.85`   | 0.5–1；模型自行报告，并非经过校准的概率 |
| `retentionDays`       | `30`     | 整数，1–365                             |

字符预算限制的是消息文本。请求还包含指令、JSON 结构、近期提示摘要和已知主题。因此它不是令牌数或费用上限。

## 模型提供商

### 原生 OpenCode

原生插件通过 `ctx.experimental.generate.text` 使用当前会话模型。这是无状态请求，不提供工具，也不写入会话历史。独立 CLI 的 `provider` 设置不会改变原生插件使用的模型。

服务端钩子启动后台任务，不等待推理完成。只观察主会话，跳过子智能体会话。新的用户消息会取消当前进程中上一轮的请求。RPC 调用和通知按工作目录及会话限定范围。

未显式指定语言时，Desktop 界面跟随应用语言。`language: "auto"` 的提示跟随最新用户消息。TUI 界面使用显式语言设置或 `LANG`。

### Codex 账户

```json
{
  "provider": {
    "type": "codex",
    "executable": "codex"
  }
}
```

需要 Codex **0.162.0+** 并已登录（`codex login`）。可选的 `model` 指定该账户可用的模型；否则使用 Codex 配置中的默认模型。若宿主 PATH 中找不到 Codex，请为 `executable` 设置绝对路径。

每次检查会在空的临时目录中启动 `codex app-server --stdio`，创建临时只读线程。工具、钩子、插件、MCP 服务、记忆和网页搜索均被关闭，且不提供运行时工作区根目录或环境。发现工具活动或权限请求时会终止观察。提供商进程为认证继承本地 CLI 环境；这不是操作系统级沙箱。结束后删除临时目录。

额度来自配置的 Codex 账户或提供商。app-server API 对版本敏感。`ysk doctor` 检查安装版本，不执行真实推理；登录状态请使用 `codex login status` 查看。

### OpenAI 兼容 API

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

请在启动宿主的环境中设置指定变量，并填写端点实际提供的模型 ID。端点必须支持 Chat Completions 和 `response_format: { "type": "json_object" }`。请求不包含工具。官方 OpenAI 端点接收 `max_completion_tokens`，其他端点接收 `max_tokens`；仅部分兼容这些字段的服务可能无法使用。

本地端点也需要设置密钥变量；若本地服务忽略认证，可填入非敏感占位值。密钥不从项目配置读取。HTTP 重定向会被拒绝，避免把凭据转发至其他端点。

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

默认使用 `https://api.anthropic.com/v1/messages`、Bearer 认证和 API 版本 `2026-10-21`。可选的 `baseUrl` 替换 `/v1` 基础地址。模型必须支持文本响应。这里使用 API 凭据和 API 计费，不使用 Claude Code 订阅。

## 钩子

| 宿主        | 文件                                                            |
| ----------- | --------------------------------------------------------------- |
| Codex       | `$CODEX_HOME/hooks.json` 或 `~/.codex/hooks.json`               |
| Claude Code | `$CLAUDE_CONFIG_DIR/settings.json` 或 `~/.claude/settings.json` |

`ysk install <host>` 注册四种事件：

- `PostToolUse` 和 `Stop`：异步读取有大小限制的转录，并可能请求模型；始终返回 `{}`。
- `UserPromptSubmit`：同步使之前的结果失效，并通过 `systemMessage` 传递一条待处理的本地提示；不调用模型。
- `SessionEnd`：使待处理结果失效。

Codex 必须启用钩子，例如使用 `codex --enable hooks`。工具结果事件少于 `minSteps` 的短轮次不会触发检查，即使发生 `Stop`。并行结果按转录中的表示计数，检查频率不是实际操作次数的精确计数。

后台输出不向主智能体注入指令。Claude 的异步钩子不会直接显示 `systemMessage`，因此在下一次提交消息时交付。可使用 `ysk watch` 提前查看。钩子消息的实际展示取决于宿主界面。

安装器可重复运行，采用原子写入，并将首次备份保存为 `<config-file>.before-ysk`。无效 JSON 或意外的钩子结构不会被覆盖。卸载仅移除带 `--managed-by-ysk` 标记的记录，不会用旧备份覆盖用户的新设置。安装后的命令使用 PATH 中的 `node` 和 `dist/cli.js` 的绝对路径。

钩子进程共享磁盘请求占位记录。新消息使旧占位失效，防止过期结果保存。与 OpenCode 进程内取消不同，另一个钩子进程已启动的请求仍可能运行到完成或超时，并消耗额度。

## CLI 与 MCP

`ysk --help` 列出所有命令。`notes`、`show`、`feedback`、`doctor` 和 `check` 支持 `--json`；`--session` 可筛选 `notes` 和 `watch`。反馈值为 `known`、`helpful`、`dismissed`、`irrelevant`。

`known` 和 `helpful` 会按项目记住主题。所有已提供的主题在对应提示保留期间都会去重。新的观察轮次开始时，未读提示变为过期；连续忽略提示后，观察器会跳过更多符合条件的检查。反馈会重置此退避行为。`pause` 在进程重启后仍有效。

显式检查可通过 stdin 传入 JSON：

```sh
ysk check --manual --json < integrations/observation.json
```

这会发起真实模型请求。`--manual` 跳过检查频率、冷却和退避，但不绕过预算、暂停、相同上下文、现有请求或每轮一条提示的限制。

观察输入包含 `host`、`sessionId`、`turnId`、`step` 和 `messages`。每条消息包含唯一 `id`、`role`（`user`、`assistant` 或 `tool`）及 `text`。请提供用户目标以及相关智能体或工具输出。CLI 输入上限为 2 MB。

| MCP 接口       | 行为                                                  |
| -------------- | ----------------------------------------------------- |
| `ysk_observe`  | 不含 `host` 的观察输入，最多 100 条消息；可能调用模型 |
| `ysk_notes`    | 可选 `sessionId`；读取本地提示                        |
| `ysk_feedback` | `id` 和 `feedback`；记录用户明确反馈                  |
| `ysk://notes`  | 包含当前项目提示的 JSON 资源                          |

MCP 不会自动订阅其他客户端的对话。客户端需要选择调用时机并传入相应 `step`。启动服务时使用 `--cwd` 明确项目范围。服务 stdout 仅用于协议消息。

## 存储与数据流

```text
宿主对话
  → 规范化文本并限制上下文
  → 脱敏常见凭据
  → 在项目状态中预留有预算的检查
  → 纯文本模型请求
  → 验证结构、置信度、原文引用和时效性
  → 去重并保存一条提示
  → 宿主界面 / 下次提交消息 / watch / MCP
```

状态目录为 `$XDG_STATE_HOME/you-should-know`，默认 `~/.local/state/you-should-know`。`YSK_DATA_DIR` 可覆盖该根目录。每个规范化工作目录映射到 `projects/<path-hash>/state.json`。符号链接路径共享状态；不同目录和 worktree 各自独立，即使它们属于同一仓库。请从宿主使用的同一工作目录运行 CLI。

保存的数据包括提示及原文依据、反馈、已知主题、会话与轮次 ID、哈希、时间、预算和临时占位。不保存完整转录、模型推理、凭据或原始提供商响应。提示本身仍可能包含项目私密信息。

每个项目最多保留 100 条提示、100 个已知主题和 64 个近期会话记录。会话预算依赖保留的记录。过期数据在观察、读取、交付和反馈时清理，不依赖后台删除任务。未再访问的项目文件会保留，直到重新访问或手动移除。

POSIX 上新建目录和文件的权限分别为 `0700`、`0600`；Windows 使用继承的 ACL。写入采用进程间锁和原子替换。损坏或不支持的状态文件会被保留并报错，不会静默重置。卸载保留数据；若要清除，请先停止观察器，再删除状态根目录下对应项目的目录，避免影响其他项目。

## 故障排查

| 现象                           | 检查项                                                                             |
| ------------------------------ | ---------------------------------------------------------------------------------- |
| 没有提示                       | 保持安静是正常情况。检查 `enabled`、`ysk resume`、频率、预算以及上下文是否改变。   |
| 找不到 `ysk`                   | 构建后运行 `npm link`，确认 npm 全局 bin 目录在 PATH 中。                          |
| OpenCode 插件不可用            | 配置目录路径、构建 `dist`、检查插件状态；Desktop 需要全局配置。                    |
| Codex 钩子无响应               | 检查版本、启用 `hooks`，并确认 `CODEX_HOME` 与客户端一致。                         |
| Claude 钩子无响应              | 检查异步钩子支持、提供商配置及 `CLAUDE_CONFIG_DIR`。                               |
| `watch` 有提示，客户端尚未显示 | 钩子在下一次提交消息时交付；宿主界面支持各不相同。                                 |
| HTTP `provider_error`          | 运行 `ysk doctor`，检查模型 ID、密钥变量、端点格式与额度；不会回显提供商错误正文。 |
| `invalid_response`             | 模型未满足严格提示结构，不保存提示。                                               |
| `unsubstantiated`              | 原文引用不在所选上下文中，或输出未通过脱敏检查。                                   |
| 状态错误                       | 先备份并检查状态目录；损坏文件会被保留。                                           |

## 兼容性与验证

目标接口为 OpenCode V2 插件契约（`@opencode/plugin ~2.2.6`）、Codex `0.162.0` 的 app-server/钩子，以及 MCP SDK `1.x`。Desktop 和 Codex API 可能变化；升级后请重新运行打包冒烟测试。

自动测试覆盖核心状态、适配器、子进程与 HTTP 协议、MCP 交互，以及无开发依赖的安装。真实 Codex 登录和 OpenCode 服务端/RPC 已在 macOS 上使用合成输入验证。Claude Code 钩子展示与其他操作系统上的宿主行为仍取决于客户端版本；可移植包测试通过不等于已全面认证所有宿主界面。
