import type { ModelUsage } from "../core/types.js"
import { object } from "./json-lines.js"

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

export function inclusiveUsage(
  input: unknown,
  output: unknown,
  read: unknown,
  write: unknown,
): ModelUsage | undefined {
  const inputTokens = count(input)
  const outputTokens = count(output)
  if (inputTokens === undefined && outputTokens === undefined) return undefined
  const cachedInputTokens = count(read)
  const cacheWriteInputTokens = count(write)
  const uncached =
    inputTokens !== undefined &&
    cachedInputTokens !== undefined &&
    cacheWriteInputTokens !== undefined
      ? inputTokens - cachedInputTokens - cacheWriteInputTokens
      : undefined
  return {
    inputTokens,
    outputTokens,
    cachedInputTokens,
    cacheWriteInputTokens,
    uncachedInputTokens: uncached !== undefined && uncached >= 0 ? uncached : undefined,
  }
}

export function anthropicUsage(raw: unknown): ModelUsage | undefined {
  const value = object(raw)
  const uncachedInputTokens = count(value.input_tokens)
  const outputTokens = count(value.output_tokens)
  if (uncachedInputTokens === undefined && outputTokens === undefined) return undefined
  const cachedInputTokens = count(value.cache_read_input_tokens)
  const cacheWriteInputTokens = count(value.cache_creation_input_tokens)
  const creation = object(value.cache_creation)
  return {
    uncachedInputTokens,
    cachedInputTokens,
    cacheWriteInputTokens,
    outputTokens,
    inputTokens:
      uncachedInputTokens !== undefined &&
      cachedInputTokens !== undefined &&
      cacheWriteInputTokens !== undefined
        ? uncachedInputTokens + cachedInputTokens + cacheWriteInputTokens
        : undefined,
    cacheWrite5mInputTokens: count(creation.ephemeral_5m_input_tokens),
    cacheWrite1hInputTokens: count(creation.ephemeral_1h_input_tokens),
  }
}
