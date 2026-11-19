import { randomUUID } from "node:crypto"
import { access, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { isErrno } from "../src/core/config.js"
import type { ObservationResult } from "../src/core/types.js"
import { blindCase, hash, type trialsFor } from "./suite.js"

type CompletedTrial = ReturnType<typeof trialsFor>[number] & { result: ObservationResult }

export async function publishGrading(out: string, trials: CompletedTrial[]) {
  const root = join(out, "grading")
  const directory = join(root, "v1-" + hash(JSON.stringify(trials)))
  try {
    await access(join(directory, "blind.jsonl"))
    await access(join(directory, "references.jsonl"))
    return directory
  } catch (error) {
    if (!isErrno(error, "ENOENT")) throw error
  }

  await mkdir(root, { recursive: true, mode: 0o700 })
  const staging = await mkdtemp(join(out, ".grading-"))
  try {
    const entries = trials.map(({ key: caseKey, episode, variant, result }) => {
      const key = randomUUID()
      return {
        blind: blindCase(key, episode, result),
        reference: {
          key,
          caseKey,
          episode: episode.id,
          variant,
          expected: episode.expected,
          rubric: episode.rubric,
        },
      }
    })
    const blind = entries.map((e) => e.blind).sort((a, b) => a.key.localeCompare(b.key))
    const references = entries.map((e) => e.reference)
    for (const [file, rows] of [
      ["blind.jsonl", blind],
      ["references.jsonl", references],
    ] as const) {
      await writeFile(join(staging, file), rows.map((r) => JSON.stringify(r)).join("\n") + "\n", {
        mode: 0o600,
      })
    }
    // A single directory rename publishes the two matching files under the run lock.
    await rename(staging, directory)
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
  return directory
}
