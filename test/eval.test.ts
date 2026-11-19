import assert from "node:assert/strict"
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { publishGrading } from "../eval/grading.js"
import { blindCase, classify, corpus, observationFor, trialsFor } from "../eval/suite.js"

test("the corpus keeps distinct development and holdout cases in each language", async () => {
  const { episodes } = await corpus()
  for (const language of ["en", "ru", "zh"]) {
    const items = episodes.filter((e) => e.language === language)
    assert.equal(items.length, 20)
    assert.equal(new Set(items.map((e) => e.user)).size, 20)
    const holdout = items.filter((e) => e.split === "holdout")
    assert.equal(holdout.length, 8)
    assert.equal(holdout.filter((e) => e.expected === "note").length, 3)
    assert.equal(items.filter((e) => e.expected === "quiet").length, 12)
  }
  const long = episodes.filter((e) => e.logPosition)
  assert.equal(long.length, 12)
  for (const position of ["start", "middle", "end"]) {
    const cases = long.filter((e) => e.logPosition === position)
    assert.equal(cases.length, 4)
    for (const e of cases) {
      const lines = observationFor(e).messages[1]!.text.split("\n")
      assert.equal(lines[{ start: 0, middle: 160, end: 320 }[e.logPosition!]], e.tool)
    }
  }
  const trials = trialsFor(episodes, "test")
  assert.equal(trials.length, 132)
  assert.equal(new Set(trials.map((t) => t.key)).size, trials.length)
  assert.deepEqual(trialsFor(episodes.toReversed(), "test"), trials)
  assert.notEqual(trialsFor(episodes, "other")[0]!.key, trials[0]!.key)
})

test("an unobserved episode never counts as a correct decision to stay quiet", () => {
  assert.equal(classify("quiet", { status: "error", reason: "timeout" }), "no_decision")
  assert.equal(classify("quiet", { status: "skipped", reason: "budget" }), "no_decision")
  assert.equal(classify("quiet", { status: "quiet", reason: "no_finding" }), "true_negative")
  assert.equal(classify("note", { status: "quiet", reason: "unsubstantiated" }), "false_negative")
})

test("blind and reference files publish together with stable private keys for each snapshot", async (t) => {
  const out = await mkdtemp(join(tmpdir(), "ysk-grading-"))
  t.after(() => rm(out, { recursive: true, force: true }))
  const { episodes } = await corpus()
  const trials = trialsFor(episodes.slice(0, 4), "known-seed").map((trial) => ({
    ...trial,
    result: { status: "quiet", reason: "no_finding" } as const,
  }))
  const read = (dir: string, file: string) => readFile(join(dir, file), "utf8")
  await writeFile(join(out, "blind.jsonl"), "previous blind file")
  await writeFile(join(out, "references.jsonl"), "previous references")
  const first = await publishGrading(out, trials)
  assert.deepEqual((await readdir(first)).sort(), ["blind.jsonl", "references.jsonl"])
  const originalBlind = await read(first, "blind.jsonl")
  const originalRefs = await read(first, "references.jsonl")
  const blindKeys = originalBlind
    .trim()
    .split("\n")
    .map((s) => JSON.parse(s).key)
  const refs = originalRefs
    .trim()
    .split("\n")
    .map((s) => JSON.parse(s))
  assert.equal(new Set(blindKeys).size, trials.length)
  assert.deepEqual(blindKeys, refs.map((r) => r.key).sort())
  assert.deepEqual(
    refs.map((r) => r.caseKey),
    trials.map((t) => t.key),
  )
  assert.ok(trials.every((t) => !blindKeys.includes(t.key)))
  assert.equal(await publishGrading(out, trials), first)
  const other = await publishGrading(join(out, "independent"), trials)
  assert.notEqual(other, first)
  const otherRefs = await read(other, "references.jsonl")
  assert.ok(blindKeys.every((key) => !otherRefs.includes(key)))
  const next = await publishGrading(
    out,
    trials.map((trial) => ({ ...trial, result: { status: "error", reason: "timeout" } })),
  )
  assert.notEqual(next, first)
  assert.deepEqual((await readdir(next)).sort(), ["blind.jsonl", "references.jsonl"])
  assert.equal(await read(first, "blind.jsonl"), originalBlind)
  assert.equal(await read(first, "references.jsonl"), originalRefs)
  assert.equal(await read(out, "blind.jsonl"), "previous blind file")
  assert.equal(await read(out, "references.jsonl"), "previous references")
})

test("blind grading exposes the original conversation without reference labels or variant IDs", async () => {
  const { episodes } = await corpus()
  const e = episodes[0]!
  const row = JSON.parse(
    JSON.stringify(blindCase("anonymous", e, { status: "quiet", reason: "no_finding" })),
  )
  assert.deepEqual(Object.keys(row).sort(), ["key", "messages", "reason", "status"])
  assert.deepEqual(row.messages, observationFor(e).messages)
  assert.equal(JSON.stringify(row).includes(e.id), false)
  assert.equal(JSON.stringify(row).includes(e.rubric), false)
})
