# CW.17 Serial Real-Model Evaluation

- Date: 2026-09-04
- Task Set: `context-window-real-smoke-v1`
- Provider/Model: `qingyingxy/gpt-5.6-terra`
- Thinking: `medium`
- Context Window: 272,000 tokens
- Execution: strictly serial
- Deterministic result: 5/8 runs passed
- Final matrix estimated cost: $0.472444
- Pricing basis: [OpenAI API pricing](https://developers.openai.com/api/docs/pricing)

| Group | Task | Result | Calls | Input | Output | Reasoning | Cache read | History q/h | Notes | Snapshots | Cost |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| A | routing-ledger | PASS | 5 | 22,574 | 566 | 93 | 30,976 | 0/0 | 0 | 0 | $0.058135 |
| B | routing-ledger | PASS | 6 | 21,675 | 433 | 189 | 32,768 | 1/1 | 1 | 0 | $0.055100 |
| C | routing-ledger | FAIL | 6 | 13,005 | 581 | 316 | 41,984 | 1/1 | 1 | 1 | $0.041379 |
| D | routing-ledger | PASS | 6 | 26,763 | 449 | 191 | 28,160 | 1/1 | 1 | 1 | $0.064546 |
| A | repair-ledger | PASS | 5 | 22,525 | 637 | 152 | 30,976 | 0/0 | 0 | 0 | $0.058889 |
| B | repair-ledger | PASS | 6 | 26,166 | 312 | 78 | 28,160 | 1/1 | 1 | 0 | $0.061708 |
| C | repair-ledger | FAIL | 7 | 28,402 | 985 | 674 | 32,768 | 1/2 | 1 | 1 | $0.075178 |
| D | repair-ledger | FAIL | 6 | 22,112 | 561 | 293 | 32,768 | 1/1 | 1 | 1 | $0.057510 |

The final matrix made 47 provider calls and used 183,222 input, 4,524 output, 1,986 reasoning, and 258,560 cache-read tokens. Reasoning tokens are a subset of output tokens and were not charged twice.

## Findings

- All 8 runs used the expected summary or hard-cut route, retained raw Session JSONL history, and excluded the old lookup result from active history after the boundary.
- All 6 hard-cut runs persisted Notes and successfully queried History. The six queries returned seven matching entries in total.
- All 4 Workflow runs persisted a Snapshot reference on the hard-cut boundary.
- All 8 runs recovered every tested durable fact and exact lookup value other than the requested external `task_id` in three Workflow runs.
- The three strict-output failures were ID namespace collisions. One response used `routing-ledger-record`; two used the Workflow-internal `task-<uuid>` instead of the benchmark task ID. The Snapshot projection intentionally exposes internal Task IDs, while the task fixture also requested a generic `task_id` field.
- The result does not justify changing the global default from `summary`. A follow-up task set should use an unambiguous external identifier and include repeated trials before deciding the `hybrid` default.

The complete local report and per-run Session JSONL/trace artifacts are under `.artifacts/context-window-real-cw17-v4-2026-09-04/`.

## Evaluation Corrections

Two aborted pilot runs exposed harness defects before the final matrix:

- OpenAI-compatible strict tool arguments populated unused History fields. History now accepts `null` for unused optional fields and normalizes it to absence.
- A checkpoint instruction copied into the fallback seed could repeatedly request `new_context`. The benchmark now makes the forced boundary one-shot by removing that tool after the first accepted model cut.

The final matrix cost $0.472444. Including the two earlier pilot reports and the interrupted loop run, total estimated development evaluation cost was approximately $1.183453.
