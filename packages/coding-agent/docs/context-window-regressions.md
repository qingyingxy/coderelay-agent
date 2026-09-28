# Context-window verification regressions

## Evidence and scope

CW18.14 recorded a real task whose third handoff omitted pending safe-upsert
checks after the existing suite passed. CW18.15 and CW18.17 reproduced that
free-text omission with scripted providers. The carry-forward guidance is
already present in the product, but it does not enforce semantic completeness.

The two product defects below were found while following that evidence through
the current Snapshot projection. They are independently reproduced regressions,
not claimed causes of CW18.14: that trial reported no projection truncation.

## Long optional detail hides authoritative verification

- Trigger: a Direct task has many host-observed file modifications, a failed
  verification, an unchecked requirement, and a bounded continuity seed.
- Before: optional projection packing could consume the budget before failure
  and unchecked details that are more important for safe continuation.
- Regression: `keeps failed and unchecked requirements ahead of observed
  modification details` uses an 1800-byte seed and asserts that failure and
  unchecked scope remain visible.
- Fix: project non-passing results and unchecked requirements before observed
  modification details. Byte limits and truncation reporting still apply.

## Unchecked requirements receive finalization guidance

- Trigger: a verifying workflow has passing results for existing checks but no
  result for a declared Plan or Task requirement.
- Before: next-action selection inspects only existing results and advises
  finalizing, despite a `Not checked` line elsewhere in the same seed.
- Regression: `does not suggest finalizing with an unchecked %s requirement`
  covers both Plan and Task scope and a control with the missing result supplied.
- Fix: consult the existing unchecked-requirement projection before suggesting
  finalization. Existing non-passing results keep priority.

## Validation

All three new cases failed against the original implementation. The focused
projection, Notes and actual context-window lifecycle suites use no paid
provider or Docker environment.

From `packages/coding-agent`:

```sh
node ../../node_modules/vitest/dist/cli.js --run test/workflow/context-window-projection.test.ts test/suite/agent-session-context-window.test.ts test/suite/agent-session-notes-pre-cut-review.test.ts
```

`npm run check` and the focused suites pass. No real provider is used by these
regression tests.

These fixes preserve and correctly describe verification already represented
in the Workflow. They do not infer coverage from arbitrary test output, change
completion gates, or prove improved real-model task success. No additional paid
evaluation was run.
