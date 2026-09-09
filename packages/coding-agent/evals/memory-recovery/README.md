# Historical Memory Replay Tools

Reusable evaluation utilities for native Pi summary (A) versus native window
cutting and history lookup (C). These tools do not modify product behavior.
They contain no personal conversations, credentials, provider URL, or private oracle.

## Offline Smoke Run

Run from the repository root after installing its normal dependencies. Node and
the existing `tsx` dependency are sufficient; no Python environment is needed.
Output parent directories must already exist; output files/directories must not.

```sh
node --import tsx packages/coding-agent/evals/memory-recovery/cli.ts sample .artifacts/memory-sample.json
node --import tsx packages/coding-agent/evals/memory-recovery/cli.ts offline .artifacts/memory-sample.json .artifacts/memory-a A
node --import tsx packages/coding-agent/evals/memory-recovery/cli.ts offline .artifacts/memory-sample.json .artifacts/memory-c C
```

Offline mode uses the faux provider, actual session compaction/window entries,
and native history tools. It intentionally answers `unknown`: smoke tests verify
execution and evidence plumbing, not model quality. Faux costs are never reported
as actual spending by the auditor. The synthetic sample has five stages.

## Your Own Inputs

Provide a JSON array of datasets with `name`, `batches`, and `questions`:

```json
[
  {
    "name": "synthetic-demo",
    "batches": [[
      {"line": 1, "role": "user", "text": "Retention is 17 days."},
      {"line": 2, "role": "assistant", "text": "Recorded."}
    ]],
    "questions": [
      {"id": "q1", "line": 1, "question": "What retention period was specified?", "quotes": ["17 days"]}
    ]
  }
]
```

This short schema example needs more context for an actual compaction run; use
the generated sample for executable smoke tests. Every batch must be nonempty,
source lines must increase, and oracle quotes must occur in the referenced user
message. Preserve chronological roles. Choose batch boundaries before inference.

```sh
node --import tsx packages/coding-agent/evals/memory-recovery/cli.ts freeze input.json frozen.json
```

Freezing validates evidence and hashes normalized schema fields. It does **not**
sanitize arbitrary secrets. Review and redact input before freezing or sending
it anywhere. Questions/oracle are excluded from maintenance model inputs.
Names are restricted to safe folder identifiers. Existing outputs are never overwritten.

## Explicit Paid Runs

Only the `paid` command can use configured Pi model authentication. A config file
must specify exactly the fields below; do not put API keys in this file.

```json
{
  "provider": "YOUR_CONFIGURED_PROVIDER",
  "model": "YOUR_CONFIGURED_MODEL",
  "group": "A",
  "maxCostUsd": 1,
  "maxRequests": 100,
  "maxOutputTokens": 4000,
  "contextWindow": 128000,
  "timeoutSeconds": 1200,
  "pricing": {"input": 2, "output": 12, "cacheRead": 0.2, "cacheWrite": 2.5}
}
```

Prices are explicit USD per million tokens, not price recommendations. Set them
for your provider. Obtain authorization to send the reviewed data to that provider.
The HTTPS origin argument must match the configured model endpoint exactly.

```sh
node --import tsx packages/coding-agent/evals/memory-recovery/cli.ts paid frozen.json NEW_OUTPUT_DIR A config.json https://YOUR_AUTHORIZED_HOST
```

For C, set both the group argument and config group to C. Budget reservation is
performed before every provider dispatch, including auxiliary summaries. Missing
usage/transport failure retains a conservative reservation and stops the run.
The run stops at the first failed phase, with no automatic retries or resume.
Unattempted datasets stay unassessed. A new invocation has a new budget: when
manually continuing, subtract all prior known costs and unknown reservations
yourself and do not include already completed datasets or silently retry failures.

`timeoutSeconds` is the phase deadline; individual provider timeout is 120 seconds.
Only A's empty toolset, C maintenance's `new_context`, and C answering's `history`
are permitted. Extensions, local agent instructions, shell tools and business APIs
are disabled. Provider/model discovery network access is disabled.

## Audit and Interpretation

Review actual answers against the frozen oracle and create manual judgments:

```json
{"synthetic-ledger": {"q1": {"correct": false, "note": "Faux answer is intentionally unknown, not a quality result."}}}
```

```sh
node --import tsx packages/coding-agent/evals/memory-recovery/cli.ts audit frozen.json RUN_DIR/run.json judgments.json audit.json
```

Completed sessions require a boolean judgment and explanation for every question.
Do not grade failed or unattempted sessions. The auditor refuses hash mismatches
and duplicate session results. Compare A/C only on the same frozen input and
same completed question set; sum numerators and denominators, not percentages.

`run.json` preserves completion, known usage estimates, unknown reserves, and
receipts. `budget.jsonl` tags request phases for maintenance/query/answer accounting;
model requests ending in tool use are query planning, not final answers. Snapshot,
archive and message files support inspection of exact visible/returned evidence.
Oracle visibility and strict citation matches are **not** semantic correctness.
Wrong answers can result from failing to use evidence that remains available.

Outputs may contain the entire private history. Keep them in an ignored local
directory and review before sharing. Do not publish run artifacts by default.

## Differences From the Private 2026-09-08 Run

This public harness uses the committed SDK's argument-free `new_context()` and
normal Direct maintenance workflow. Final probes use the SDK extension-message
source to avoid routing historical questions as new operational tasks. It does
not depend on uncommitted handoff/isolated-execution features, nor reproduce the
private run's handoff prompts. Compare its future results under its own protocol
identifier; do not silently merge them into the earlier reported sample.

Context sizing uses Pi's heuristic `estimateTokens`, not the private Python
tokenizer. It is a guard, not an exact provider-token measurement. Paid usage
comes from provider receipts. Capacity is not matched; boundaries are forced;
facts may repeat and have different maintenance ages. These are text-replay
experiments, not proof of permanent memory or general cost savings.

## Tests

```sh
cd packages/coding-agent
node ../../node_modules/vitest/dist/cli.js --run test/memory-recovery.test.ts
```

No paid models or real user data are used by these tests.
