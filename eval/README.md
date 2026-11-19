# Observer evaluation

The corpus contains 60 synthetic conversations in English, Russian and Simplified Chinese. Each language has 8 cases where a note should change a decision and 12 where the observer should stay quiet. Use the 36 development cases to investigate changes. Reserve the 24 holdout cases for a subsequent comparison.

## Run a comparison

```sh
npm ci
npm run eval:observer
npm run eval:observer -- --live --model MODEL --out ../ysk-eval --jobs 2
```

The first evaluation validates the corpus locally. A live run needs a signed-in Codex CLI and a model available to that account. A full run makes 132 independent observer requests. Both the default and native-schema variants see all 60 episodes. The compact-logs variant sees the same 12 long-log episodes as the other variants, with evidence at the beginning, middle or end. Nine have repeated lines and three have numbered lines. Each variant changes one option. Each trial has fresh observer state.

Use `--split dev` or `--split holdout` to select cases and `--variant default|native-schema|compact-logs` to select one variant. A seed controls trial order independently of model sampling. Repeat the same command and output directory to resume an interrupted run. Use a new output directory after changing the code or for an independent repetition. Ordinary CI runs regression tests without contacting a model.

## Read the outcome

The runner marks a displayed note on a positive case as `shown_pending_grade`. Whether the note explains the right consequence is determined during grading.

Give the grader only `blind.jsonl`. It contains the original conversation, a random per-run key and the observer's response. Grading rows are ordered by this key independently of the seeded model calls. Resuming a run reuses its private key mapping. Record whether an interruption was warranted, whether the note named the specific consequence and whether its quotes support it in the user's language. Mark a generic warning that misses the decisive fact as partial. Record skipped and failed requests separately. Freeze grades before opening the private `references.jsonl`, which maps grading keys to cases, variants, labels and rubrics. Document disputed labels for the next corpus version.

Join grades to `references.jsonl` by `key`, then open `cases/<caseKey>.json` for the matching measurement. Re-exporting an older directory upgrades its deterministic grading keys. Archive frozen grades with their original references before upgrading. Compare identical episodes across variants. Report precise notes and unnecessary interruptions, missed consequences, missing decisions, model and token-count coverage, total price by billing type per completed episode, and p95 latency. A synthetic episode here comprises one eligible observation. Measuring the full cost of a user's completed task also requires the working agent's usage and a task outcome.

## November 2026 run

Codex CLI 0.162.0 reported `gpt-6.1-terra` for all 132 initial trials and a further 12 compact-log trials. The model and seed were fixed across the initial comparison. The repetition followed a fix that verifies compact-log evidence against the original tool text. These historical results were graded with the variant names hidden and the expected labels and rubrics visible. The current grader file also hides the reference labels.

| Cases and variant        | Episodes | Specific notes / expected | Partial notes | False positives / quiet | Estimated USD per episode | p95 seconds |
| ------------------------ | -------: | ------------------------: | ------------: | ----------------------: | ------------------------: | ----------: |
| Full, default            |       60 |                     22/24 |             2 |                    6/36 |                   0.00407 |        25.3 |
| Full, native schema      |       60 |                     22/24 |             2 |                    4/36 |                   0.00327 |        26.3 |
| Holdout, default         |       24 |                       8/9 |             1 |                    4/15 |                   0.00413 |        25.7 |
| Holdout, native schema   |       24 |                       8/9 |             1 |                    3/15 |                   0.00330 |        23.9 |
| Long logs, default       |       12 |                       4/6 |             2 |                     5/6 |                   0.00644 |        25.3 |
| Long logs, compact       |       12 |                       6/6 |             0 |                     3/6 |                   0.00301 |        27.7 |
| Long logs, compact rerun |       12 |                       6/6 |             0 |                     2/6 |                   0.00202 |        12.4 |

Every trial reached a model decision with reported usage. The native schema removed 13,700 input tokens over 60 episodes. The 12 compacted inputs used 20,460 fewer tokens than their matched defaults. Cache reads varied by trial order and repetition. Estimates use USD 1.00 per million uncached input tokens, 0.05 for cached reads and 5.00 for output. Reported cache writes were zero. [Model pricing](https://developers.openai.com/api/docs/models/gpt-6.1-terra)

Two long cases show why specific evidence matters. With the full signal visible, the observer identified 61 distinct attendees among 92 connections and zero deliveries for 41 queued invitations. Some quiet labels admit a second interpretation, including a test without an explicit pass threshold and a run where sync duration and lag may differ. The original scores include these as false positives.

Both options are opt-in. Before changing either default, repeat the experiment on fresh cases, have another reviewer grade the notes, and run a session-level pilot with consenting users. Track whether tasks complete, helpful or irrelevant feedback, total task cost, missed consequences, unnecessary interruptions, error rate and p95 latency. A single model run on a small synthetic holdout cannot establish those production outcomes.

A later repeat made 54 calls on the same holdout with a new trial order. The grader file omitted variant names, expected labels and rubrics. Its historical identifiers were reproducible from the corpus and seed. New exports use random grading keys and a separate row order. Both full-holdout variants again produced eight specific notes and one partial note out of nine expected. Extra notes numbered four and three respectively. Compact logs produced three specific notes and one extra note on their six holdout cases. The estimated per-episode costs for the default and native schema were USD 0.00189 and 0.00187 in this repeat. Cache conditions explain why the price difference from the first run should not be treated as a stable saving.
