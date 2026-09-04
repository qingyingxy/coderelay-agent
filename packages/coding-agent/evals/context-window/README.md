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
