# Context Window Mechanism Evaluation

This suite evaluates context-management mechanics with the Faux Provider. It is deterministic, uses no network access, and consumes no paid tokens.

Run from the repository root:

```bash
npm run eval:context-window
```

The command prints a JSON report and exits non-zero if any case fails.

| Group | Strategy | Deterministic checks |
|---|---|---|
| A | `summary` | Summary boundary, raw-history retention, active-history reduction, control-value preservation |
| B | `windowed + Notes + History` | Hard cut without summary, Note seed, exact History retrieval, trace completeness |
| C | `windowed + Workflow Snapshot + Notes + History` | Group B checks plus Snapshot reference and authoritative projection |
| D | `hybrid` | Plain chat uses summary; an active Workflow uses a Snapshot-backed hard cut |

Failed cases include the current branch, active messages, and context-management trace in the JSON report. This suite validates mechanics and routing only; it does not establish real-model task quality or justify changing the default mode.

## Lifecycle evaluation

The lifecycle runner composes the persistence mechanisms into five deterministic scenarios: two consecutive hard cuts, JSONL resume, fork/rollback with sibling-branch isolation, failed Verification to Repair Task and recovered Attempt, and one-shot overflow recovery. It uses the Faux Provider, runs serially, and consumes no paid tokens.

```bash
npm run eval:context-window:lifecycle
```

The command prints a uniform JSON report with checks and evidence for every scenario and exits non-zero on any failure.

The 5/5 deterministic lifecycle result is documented in [cw17.3-report.md](./cw17.3-report.md).

## OS-process crash recovery evaluation

The process-recovery runner force-exits two independent Node.js child processes at the hard-cut transaction boundaries: after the Workflow Snapshot is durable but before the ContextWindowEntry, and after the ContextWindowEntry is durable but before the new-window continuation. A fresh parent-side AgentSession then reopens the same Session JSONL and verifies which window is active, whether History remains available, and whether the interrupted cut is duplicated.

```bash
npm run eval:context-window:process-recovery
```

This evaluation uses the Faux Provider, runs both crash scenarios serially, and consumes no paid tokens. It covers abrupt process exit after complete synchronous writes, not partial filesystem writes or disk corruption.

The 2/2 process-recovery result is documented in [cw17.5-report.md](./cw17.5-report.md).

## JSONL tail-damage recovery evaluation

The tail-recovery runner generates a genuine Workflow-backed hard-cut Session JSONL, then truncates copies inside the Workflow Snapshot, ContextWindowEntry, or first new-window Assistant response. Each copy must select the last complete commit state, continue with the Faux Provider, keep the new append physically separate from the malformed tail, and preserve that continuation through a second reopen.

```bash
npm run eval:context-window:tail-recovery
```

The 3/3 result and the recovered append defect found by this evaluation are documented in [cw17.6-report.md](./cw17.6-report.md).

## Repeated real-repository evaluation

The real-repository runner compares summary with Workflow-backed hard cuts on three versioned QuixBugs Python defects: LIS, RPN evaluation, and prime sieve. Every run crosses three controlled boundaries and recreates the AgentSession from the same Session JSONL three times. The final window must recover an exact hidden verifier failure and an immutable token first observed three windows earlier. The hard-cut group uses three Notes, three Snapshot-backed windows, and must complete two exact History searches; additional proactive History queries are allowed. The summary baseline receives equivalent compaction instructions.

Validate all pinned repository digests, failing baselines, hidden-failure transitions, and reference repairs without network access:

```bash
npm run eval:context-window:real-repository -- --verify-task-set
```

Run a paid A/C smoke on one task before the full matrix:

```bash
npm run eval:context-window:real-repository -- --provider qingyingxy --model gpt-5.6-terra --thinking medium --task quixbugs-lis --repetitions 1 --max-cost 0.75 --output .artifacts/context-window-real-repository-smoke
```

Run the complete 3-task, 2-group, 3-repeat matrix strictly serially:

```bash
npm run eval:context-window:real-repository -- --provider qingyingxy --model gpt-5.6-terra --thinking medium --repetitions 3 --max-cost 3 --output .artifacts/context-window-real-repository-v1
```

The runner copies a fresh digest-checked repository for every run, permits one source file to change, protects every other file by hash and inventory, disables Provider retries, checkpoints after every run, applies official OpenAI short-context pricing, and stops after an execution error or cost-cap breach. This command makes paid API requests.

The 18-run matrix, objective-projection defect, fix, and post-fix evidence are documented in [cw17.7-report.md](./cw17.7-report.md).

## Serial real-model coding evaluation

The coding runner compares the summary baseline with the Workflow-backed hard-cut strategy on a real file-edit task. Each run crosses two controlled boundaries, destroys and recreates the AgentSession from the same Session JSONL twice, exposes one hidden verification failure, and requires a final repair plus an independent verifier run. The hard-cut group must use Notes for durable constraints and History for the exact pre-boundary failure.

Validate the task and hidden verifier without network access:

```bash
npm run eval:context-window:real-coding -- --verify-task-set
```

Run the two paid groups strictly serially with an explicit cost cap:

```bash
npm run eval:context-window:real-coding -- --provider qingyingxy --model gpt-5.6-terra --thinking medium --max-cost 3 --output .artifacts/context-window-real-coding-v1
```

The runner protects the fixture specification, allows edits only to `src/router.mjs`, records both resume checks and all verification executions, and aborts remaining paid runs after an execution error.

The first 2/2 real-model coding result is documented in [cw17.4-report.md](./cw17.4-report.md).

## Serial real-model smoke evaluation

The real-model runner compares the same four groups on two versioned tasks. It forces the boundary at the same phase in every run, grades exact JSON without a model judge, and persists each Session JSONL, context-management trace, response, result, checkpoint, and aggregate report. Hard-cut groups request `new_context` inside the active model turn so Workflow groups can checkpoint the authoritative Snapshot before replacing active history. The runner removes `new_context` after the first accepted benchmark boundary, enforcing exactly one cut per case while leaving Notes and History available. Repeated runs are stored under separate `repeat-NN` directories and remain strictly serial.

First validate the fixture without network access:

```bash
npm run eval:context-window:real -- --verify-task-set
```

Run three repetitions of the eight-case matrix, for 24 paid runs total, with an explicit Provider, Model, effort, and total estimated-cost limit:

```bash
npm run eval:context-window:real -- --provider qingyingxy --model gpt-5.6-terra --thinking medium --repetitions 3 --max-cost 2 --output .artifacts/context-window-real-smoke-v2
```

This command makes paid API requests. It never overlaps runs or model interactions, disables provider retries, limits output per call, checks cumulative cost after every phase, and stops the matrix on an execution error. `reasoning` is reported as a subset of output tokens and is not charged twice. The pinned GPT-5.6 short-context prices come from [OpenAI API pricing](https://developers.openai.com/api/docs/pricing); the runner caps the advertised evaluation context at 272,000 tokens.

The original CW.17 run and its ID-namespace failure analysis are documented in [cw17-report.md](./cw17-report.md). The repeated v2 matrix is documented in [cw17.2-report.md](./cw17.2-report.md).
