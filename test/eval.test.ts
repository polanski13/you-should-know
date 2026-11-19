import assert from "node:assert/strict"
import { test } from "node:test"
import {
  blindCase,
  classify,
  corpus,
  gradingReferences,
  observationFor,
  trialsFor,
} from "../eval/suite.js"

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

test("grading keys are private to a run and survive resuming its evaluation", async () => {
  const { episodes } = await corpus()
  const trials = trialsFor(episodes, "known-seed")
  const legacy = trials.map((t) => JSON.stringify({ key: t.key, episode: t.episode.id })).join("\n")
  const first = gradingReferences(trials, legacy)
  const known = new Set(trials.map((t) => t.key))
  const blind = new Set(first.map((r) => r.key))
  assert.equal(blind.size, trials.length)
  assert.ok(first.every((r) => known.has(r.caseKey) && !known.has(r.key)))
  const saved = first
    .toReversed()
    .map((r) => JSON.stringify(r))
    .join("\n")
  assert.deepEqual(gradingReferences(trials, saved), first)
  assert.ok(gradingReferences(trials, "").every((r) => !blind.has(r.key)))
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
