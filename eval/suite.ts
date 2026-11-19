import { createHash, randomUUID } from "node:crypto"
import { readFile } from "node:fs/promises"
import { z } from "zod"
import type { Observation, ObservationResult } from "../src/core/types.js"

const episodeSchema = z
  .object({
    id: z
      .string()
      .max(240)
      .regex(/^[a-z0-9-]+$/),
    split: z.enum(["dev", "holdout"]),
    language: z.enum(["en", "ru", "zh"]),
    user: z.string().min(1),
    tool: z.string().min(1),
    assistant: z.string().min(1),
    logPosition: z.enum(["start", "middle", "end"]).optional(),
    variedLog: z.boolean().optional(),
    expected: z.enum(["quiet", "note"]),
    rubric: z.string().min(1),
  })
  .strict()

export type Episode = z.infer<typeof episodeSchema>
export type Variant = "default" | "native-schema" | "compact-logs"

export const hash = (s: string) => createHash("sha256").update(s).digest("hex")

export async function corpus() {
  const source = await readFile(new URL("episodes.jsonl", import.meta.url), "utf8")
  const episodes = source
    .trim()
    .split("\n")
    .map((line) => episodeSchema.parse(JSON.parse(line)))
  if (new Set(episodes.map((e) => e.id)).size !== episodes.length)
    throw new Error("Duplicate episode IDs")
  return { episodes, digest: hash(source) }
}

export function observationFor(e: Episode): Observation {
  let output = e.tool
  if (e.logPosition) {
    const progress = {
      en: "Worker heartbeat received. Waiting for the next record.",
      ru: "Обработчик отвечает. Ожидаем следующую запись.",
      zh: "工作进程已响应，正在等待下一条处理记录。",
    }[e.language]
    const lines = Array.from({ length: 320 }, (_, i) =>
      e.variedLog ? progress + " " + i : progress,
    )
    const index = { start: 0, middle: 160, end: 320 }[e.logPosition]
    lines.splice(index, 0, e.tool)
    output = lines.join("\n")
  }
  return {
    host: "cli",
    sessionId: e.id,
    turnId: "t1",
    step: 6,
    messages: [
      { id: "u", role: "user", text: e.user },
      { id: "t", role: "tool", text: output },
      { id: "a", role: "assistant", text: e.assistant },
    ],
  }
}

export function trialsFor(episodes: Episode[], seed: string) {
  return episodes
    .flatMap((episode) => {
      const variants: Variant[] = ["default", "native-schema"]
      if (episode.logPosition) variants.push("compact-logs")
      return variants.map((variant) => ({
        episode,
        variant,
        key: hash(seed + "/" + episode.id + "/" + variant).slice(0, 24),
      }))
    })
    .sort((a, b) => a.key.localeCompare(b.key))
}

const previousReference = z.union([
  z.object({ caseKey: z.string(), key: z.uuidv4() }),
  // Older exports used the reproducible case key directly as the grading key.
  z.object({ key: z.string().regex(/^[0-9a-f]{24}$/), caseKey: z.never().optional() }),
])

export function gradingReferences(trials: ReturnType<typeof trialsFor>, previous: string) {
  const keys = new Map<string, string>()
  for (const line of previous.split("\n").filter(Boolean)) {
    const ref = previousReference.parse(JSON.parse(line))
    if (ref.caseKey !== undefined) keys.set(ref.caseKey, ref.key)
  }
  const references = trials.map(({ key: caseKey, episode, variant }) => ({
    key: keys.get(caseKey) ?? randomUUID(),
    caseKey,
    episode: episode.id,
    variant,
    expected: episode.expected,
    rubric: episode.rubric,
  }))
  if (new Set(references.map((r) => r.key)).size !== references.length)
    throw new Error("Duplicate grading keys in private references")
  return references
}

export function classify(expected: Episode["expected"], result: ObservationResult) {
  if (result.status === "error" || result.status === "skipped") return "no_decision"
  if (result.status === "shown")
    return expected === "note" ? "shown_pending_grade" : "false_positive"
  return expected === "quiet" ? "true_negative" : "false_negative"
}

export function blindCase(key: string, episode: Episode, result: ObservationResult) {
  const note = result.status === "shown" ? result.note : undefined
  return {
    key,
    messages: observationFor(episode).messages,
    status: result.status,
    reason: result.status === "shown" ? undefined : result.reason,
    note: note && { summary: note.summary, explanation: note.explanation, evidence: note.evidence },
  }
}
