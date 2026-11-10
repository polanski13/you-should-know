import { resolve } from "node:path"
import { dataDirectory, loadConfig } from "./core/config.js"
import { Observer } from "./core/observer.js"
import { FileStore } from "./core/store.js"
import { createProvider } from "./providers/index.js"

export async function createRuntime(
  workspace = process.cwd(),
  configPath?: string,
  env = process.env,
) {
  workspace = resolve(workspace)
  const config = await loadConfig({ workspace, configPath, env })
  const store = await FileStore.create(dataDirectory(env), workspace)
  return {
    workspace,
    config,
    store,
    observer: new Observer(store, config.observer),
    provider: createProvider(config.provider, env),
  }
}

export type Runtime = Awaited<ReturnType<typeof createRuntime>>
