import type { ProviderConfig } from "../core/config.js"
import type { ModelProvider } from "../core/types.js"
import { CodexProvider } from "./codex.js"
import { HttpProvider } from "./http.js"

export function createProvider(
  config: ProviderConfig,
  env: NodeJS.ProcessEnv = process.env,
): ModelProvider {
  return config.type === "codex"
    ? new CodexProvider({ executable: config.executable, model: config.model, env })
    : new HttpProvider(config, env)
}
