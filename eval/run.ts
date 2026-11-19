import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { parseArgs } from "node:util"
import lockfile from "proper-lockfile"
import { Observer } from "../src/core/observer.js"
import { emptyState } from "../src/core/store.js"
import { observerConfigSchema } from "../src/core/config.js"
import type { ModelUsage } from "../src/core/types.js"
import { CodexProvider } from "../src/providers/codex.js"
import { classify, corpus, observationFor, trialsFor } from "./suite.js"
import { isErrno } from "../src/core/config.js"

const { values } = parseArgs({
  options: {
    live: { type: "boolean" },
    model: { type: "string" },
    out: { type: "string" },
    split: { type: "string", default: "all" },
    variant: { type: "string", default: "all" },
    jobs: { type: "string", default: "2" },
    seed: { type: "string", default: "observer-v1" },
  },
})
const { episodes, digest } = await corpus()
if (!["all", "dev", "holdout"].includes(values.split))
  throw new Error("Choose --split all, dev, or holdout")
const selected = episodes.filter((e) => values.split === "all" || e.split === values.split)
if (!["all", "default", "native-schema", "compact-logs"].includes(values.variant))
  throw new Error("Choose --variant all, default, native-schema, or compact-logs")
const trials = trialsFor(selected, values.seed).filter(
  (trial) => values.variant === "all" || trial.variant === values.variant,
)
if (!values.live) {
  console.log(
    `${new Set(trials.map((t) => t.episode.id)).size} synthetic episodes, ${trials.length} model calls in this run. To run: npm run eval:observer -- --live --model MODEL --out DIRECTORY`,
  )
} else {
  if (!values.model || !values.out) throw new Error("Live evaluation requires --model and --out")
  const jobs = Number(values.jobs)
  if (!Number.isInteger(jobs) || jobs < 1 || jobs > 4) throw new Error("--jobs must be 1–4")
  const model = values.model
  const out = resolve(values.out)
  const cases = join(out, "cases")
  await mkdir(cases, { recursive: true, mode: 0o700 })
  const unlock = await lockfile.lock(out, { stale: 60_000 })
  try {
    const manifest =
      JSON.stringify(
        {
          version: 2,
          corpus: digest,
          model,
          split: values.split,
          variant: values.variant,
          seed: values.seed,
        },
        null,
        2,
      ) + "\n"
    const manifestPath = join(out, "manifest.json")
    try {
      await writeFile(manifestPath, manifest, { flag: "wx", mode: 0o600 })
    } catch (e) {
      if (!isErrno(e, "EEXIST") || (await readFile(manifestPath, "utf8")) !== manifest)
        throw new Error("Output directory belongs to a different evaluation", { cause: e })
    }
    let position = 0,
      completed = 0
    async function runNext() {
      while (position < trials.length) {
        const { episode, variant, key } = trials[position++]!
        const path = join(cases, key + ".json")
        try {
          await readFile(path, "utf8")
          completed++
          continue
        } catch (e) {
          if (!isErrno(e, "ENOENT")) throw e
        }
        const state = emptyState()
        let usage: ModelUsage | undefined
        let servedModel: string | undefined
        let durationMs: number | undefined
        const observer = new Observer(
          { transact: async (fn) => fn(state) },
          observerConfigSchema.parse({
            compactToolLogs: variant === "compact-logs",
          }),
          Date.now,
          async (e) => {
            usage = e.usage
            servedModel = e.model
            durationMs = e.durationMs
          },
        )
        const provider = new CodexProvider({
          model,
          env: {
            ...process.env,
            YSK_CODEX_NATIVE_SCHEMA_ONLY: variant === "native-schema" ? "1" : "0",
          },
        })
        const result = await observer.observe(observationFor(episode), provider)
        const record = {
          key,
          episode: episode.id,
          split: episode.split,
          variant,
          model: servedModel,
          usage,
          durationMs,
          result,
          classification: classify(episode.expected, result),
        }
        await writeFile(path + ".tmp", JSON.stringify(record) + "\n", { mode: 0o600 })
        await rename(path + ".tmp", path)
        completed++
        console.log(`${completed}/${trials.length} ${episode.id} ${result.status}`)
      }
    }
    const workers = await Promise.allSettled(Array.from({ length: jobs }, () => runNext()))
    for (const worker of workers) if (worker.status === "rejected") throw worker.reason
    const records = await Promise.all(
      trials.map((t) => readFile(join(cases, t.key + ".json"), "utf8").then((s) => JSON.parse(s))),
    )
    const blind = records.map((r, i) => ({
      key: r.key,
      episode: r.episode,
      expected: trials[i]!.episode.expected,
      rubric: trials[i]!.episode.rubric,
      status: r.result.status,
      reason: r.result.reason,
      note: r.result.note && {
        summary: r.result.note.summary,
        explanation: r.result.note.explanation,
        evidence: r.result.note.evidence,
      },
    }))
    await writeFile(
      join(out, "blind.jsonl"),
      blind.map((r) => JSON.stringify(r)).join("\n") + "\n",
      { mode: 0o600 },
    )
    for (const variant of ["default", "native-schema", "compact-logs"]) {
      const counts: Record<string, number> = {}
      for (const r of records.filter((r) => r.variant === variant))
        counts[r.classification] = (counts[r.classification] ?? 0) + 1
      console.log(variant, counts)
    }
    if (records.some((r) => r.classification === "no_decision")) process.exitCode = 1
  } finally {
    await unlock()
  }
}
