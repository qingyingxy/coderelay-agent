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
