# Context-window verification regressions

## Evidence and scope

CW18.14 recorded a real task whose third handoff omitted pending safe-upsert
checks after the existing suite passed. CW18.15 and CW18.17 reproduced that
free-text omission with scripted providers. The carry-forward guidance is
already present in the product, but it does not enforce semantic completeness.

The two product defects below were found while following that evidence through
the current Snapshot projection. They are independently reproduced regressions,
not claimed causes of CW18.14: that trial reported no projection truncation.

## Long handoff hides authoritative verification

- Trigger: a Direct task has a long agent-reported brief, a failed verification,
  an unchecked requirement, and a bounded continuity seed.
- Before: optional projection packing tries the brief first and stops when it
  cannot fit. Failure and unchecked details disappear even when they would fit.
- Regression: `keeps failed and unchecked requirements ahead of a long
  agent-reported handoff` uses an 1800-byte seed. It asserts that failure and
  unchecked scope remain visible, and that the full budget still retains the brief.
- Fix: project non-passing results and unchecked requirements before the brief.
  Byte limits and truncation reporting still apply; arbitrary amounts of detail
  cannot be guaranteed to fit.

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

All three new cases failed against the original implementation. After the fix,
40 tests passed across projection, handoff, continuity and actual context-window
lifecycle suites. These tests use no paid provider or Docker environment.

From `packages/coding-agent`:

```sh
node ../../node_modules/vitest/dist/cli.js --run test/workflow/context-window-projection.test.ts test/workflow/handoff.test.ts test/suite/agent-session-handoff-continuity.test.ts test/suite/agent-session-context-window.test.ts
```

`npm run check` exited zero, including TypeScript, lock validation and browser
smoke, but reported the existing Biome write-access diagnostic on
`src/core/evaluation/protocol.ts` and npm `min-release-age` warnings. A separate
read-only Biome check passed all 1112 configured files with no diagnostics.

These fixes preserve and correctly describe verification already represented
in the Workflow. They do not infer coverage from arbitrary test output, recover
requirements omitted from free-text handoffs, change completion gates, or prove
improved real-model task success. The original omission remains an open semantic
limitation; no additional paid evaluation was run.
