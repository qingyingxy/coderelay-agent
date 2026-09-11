# Serial Planner/Executor

Planner/Executor is available from both the SDK and the CLI. The CLI entry is
activated when `--planner-model`, `--executor-model`, and at least one
`--verify` command are supplied together.

## CLI Usage

Start a new Planner/Executor run with a command such as:

```sh
pi --planner-model provider/strong-model --executor-model provider/fast-model --verify "node verify.js"
```

`--verify` may be supplied repeatedly to require multiple external verification
commands. Execution is serial: at most one Worker task and one job run at a
time. The default permits at most one repair retry; configure a different
workflow budget through the SDK when that policy needs to change.

This CLI entry always requires a new persistent Plan session. It does not
support `--continue`, `--resume`, `--session`, `--fork`, `--session-id`, or
`--no-session` startup. In the interactive TUI, review the proposed workflow
plan and use `/approve`, `/reject`, or `/revise` to decide what happens next.
The CLI `--approve` flag is separate: it controls trust in project-local
resources and does not approve a workflow plan.

In print mode, execution stops while plan approval is pending. An RPC client
can submit the approval decision through the workflow approval interface.

The SDK entry point `createPlannerExecutorSession` reuses Plan Workflow
approval, RPC Worker isolation, bounded retries and existing delivery gates.
Existing CLI modes and role-based routing are unchanged.

```typescript
import { createPlannerExecutorSession } from "@earendil-works/pi-coding-agent";

const { session } = await createPlannerExecutorSession({
  cwd: process.cwd(),
  plannerModel: "provider/strong-model",
  executorModel: "provider/fast-model",
  verificationCommands: ["node verify.js"],
  workflowBudget: { maxCost: 2, maxDurationMs: 900_000, maxRetries: 1 },
});

await session.prompt("Implement the requested change");
// Present session.getWorkflowView() to the user. Do not approve automatically.
// After an actual user approval:
session.decideWorkflowPlan("approve", "Approved by user");
await session.waitForWorkflowAutomation();
session.dispose();
```

Replace the model names and verification command with real configured values.
Both models must be available and authenticated in the host and RPC child
environment. An in-memory provider registration is not transferred to RPC.
The custom SDK agent directory is not automatically propagated to RPC children;
use the standard shared CLI configuration for real runs at this stage.

## Behavior

- The host plans with the strong model using the existing read-only Planner.
- Approval is required before execution. Reject/revise remain available.
- The scheduler runs one resource at a time. Plans may still contain multiple
  sequential Worker tasks; this is not a single persistent Worker for all tasks.
- Workers start on the fast tier. Budget pressure does not downgrade this policy.
- Existing explicit failure escalation selects the strong tier for a new attempt.
  This stage does not introduce failure classification or change retry semantics.
- New-policy Workers receive plan identity/version, task/attempt identity,
  assumptions, risks, the assigned step and acceptance requirements, not the
  Planner conversation. Conflict reporting is a prompt instruction, not yet an
  automatic replan protocol.
- The scheduler now passes that contract to the RPC launch configuration. Workers
  use persistent `windowed` sessions with `new_context`, `notes`, and `history`.
  Only these session-memory tools are added; repository permissions, budgets,
  writer leases, and verification gates are unchanged.
- The fixed contract stays in the child's system context across cuts. Existing
  local Direct snapshots and handoffs carry progress, and Notes/History retain
  supporting details. Local completion does not mean the parent Plan passed.
- Each Worker prompt carries explicit host authorization for isolated Direct
  execution, with child automation disabled. The already approved Task is not
  planned again in the child. Ordinary RPC prompts retain their existing policy.
- Startup checks require the expected model, persistent session, windowed mode,
  and isolated Direct configuration. Oversized contracts fail before launch
  rather than silently truncating requirements (12,000 UTF-8 bytes).
- Existing delivery review remains enabled when required; this stage does not
  remove safety checks to guarantee exactly two model sessions.
- Read-only RPC Reviewers also carry host authorization for isolated Direct
  execution, with child automation disabled. Review text must not create a
  nested Plan approval gate. Write, command, and network permissions remain
  disabled; reviewers do not receive persistent Worker windows.

## Boundaries

Delivery review receives the original request and the approved Plan's acceptance
requirements alongside the scoped diff. Repair-only task requirements are not
added to that contract. Classified findings are retained in the existing Handoff
as a `review_findings:` JSON entry in `verificationSummary`:

- `must_fix`: only explicit requirement violations or newly introduced regressions
  with evidence referencing a changed path can enter automatic repair. Requirement
  findings must reference an approved requirement ID (or `$request`) and an exact
  quoted clause. The repair prompt receives the classified blockers only.
- `suggestion`: pre-existing, out-of-scope hardening is retained in verification
  summaries and delivery risks without blocking otherwise successful delivery.
- `confirmation`: ambiguous scope, behavior-changing extensions, severe safety or
  data-loss concerns, and unsupported blocker claims stop automatic delivery
  without creating a repair task. Conflicting classifications also require review.

Confirmation currently uses the existing failed delivery state with an explicit
`Review requires confirmation:` reason. It does not provide a new confirmation
UI or automatically resume after a reply. A user must resolve scope and authorize
the subsequent work. Structural evidence checks cannot prove that a quoted clause
actually implies a model's claim; semantic review and external tests remain necessary.
Plain successful verdicts without findings are accepted, but an unclassified
failure never authorizes an automatic repair. These changes have offline coverage;
the Boundary Retest below records the first paid run with this policy enabled.

This entry point accepts fresh sessions only. Same-Attempt hard-cut continuity is
connected and tested through a real RPC child. Process-crash recovery through
this SDK entry point is not implemented. A retry creates a new Attempt and child
session, with the new Attempt identity in its fixed contract.

Configured verification commands constrain planning. Before approving, inspect
that the Plan includes the intended required acceptance gates. Budget enforcement
and usage accounting retain their existing limitations; a cost budget is not a
guaranteed provider-side spending cap. Any future cost comparison must include
planning, execution, review, failed attempts and context maintenance.

The fixed contract is also present in the initial persisted Worker prompt, so it
can be recalled from History. Parent and child snapshots have different local
identities: the child's Snapshot is not a copy of the parent's authoritative
Plan state. The model must still record useful progress in its handoff or notes;
these tests do not establish that an arbitrary model will always do so.

## RPC Window Launch Support

The RPC session factory now accepts an optional
`SubagentSessionConfig.contextWindow: { sessionDir: absolutePath, executionContract? }`.
Planner/Executor Workers enable it automatically; other routing policies do not.
The factory requires a Worker with read permission and an
explicit tool allowlist containing `new_context`, `history`, and `notes`.
It does not add tools or broaden permissions automatically.

When configured, the child uses `--context-mode windowed --session-dir <path>`
instead of `--no-session`. The caller must choose a writable, appropriately
protected directory for potentially sensitive transcripts when using the factory
directly. The scheduler uses `<agentDir>/sessions/workers` under the standard
agent configuration directory, outside task Worktrees. Transcripts are retained;
automatic pruning is not provided here. Other RPC launches remain ephemeral.
Each launch starts a fresh session; this does not implement
crash recovery or reuse an interrupted Attempt.

The CLI also accepts `--context-mode summary|windowed|hybrid` as a startup-only
override without writing global or project settings. Resource reload can restore
the mode from settings; this override is not a persistent settings change.

Offline tests cover argument validation, subprocess launch configuration, and
strong faux planning -> explicit approval -> fast faux RPC Worker -> two cuts ->
History search/read -> external verification. The real child writes a fixture,
keeps pending checks across cuts, and preserves the model and contract. The
parent reruns the verification command independently. A second case claims tests
passed without running them and is rejected by the parent runtime. Retry tests
check that a new Attempt receives a fresh identity without changing the plan
version or escalating an ordinary retry. No paid providers or cost claims are
involved. Full delivery review remains the existing separate gate.

## First Paid Smoke (2026-09-09)

The fixed `counter-store-invariants` fixture was run once per arm in separate
non-Git temporary directories. Each arm used a $1 runtime stop threshold and
10-minute deadline. Candidate execution explicitly required one cut; this was
not a natural long-context benchmark. Rates came from local model configuration,
not provider billing.

| Arm | External tests | Full delivery | Cuts | Estimated cost | Duration |
| --- | --- | --- | --- | --- | --- |
| sol direct | 2/2 passed | Passed smoke acceptance | 0 | $0.07836320 | 45.568 s |
| sol Planner + luna Worker | 2/2 passed | Failed review gate | 1 | $0.18829284 | 241.243 s |

Protected tests and package metadata were unchanged in both arms. Candidate
cost comprised $0.04582 planning, $0.00726164 Worker execution, and $0.13521120
across two unsuccessful reviews. Both reviewers entered child Plan approval,
preventing delivery despite passing code tests. The read-only RPC authorization
fix above was added after this run and covered by an offline real-RPC regression;
the subsequent paid retest is recorded below. This sample does not establish cost savings.

Local evidence is retained under
`.artifacts/planner-executor-paid-baseline-20260909` and
`.artifacts/planner-executor-paid-candidate-20260909`, including `report.json`,
workspace copies, host sessions, and the candidate Worker session.

The manual runner is `packages/coding-agent/examples/sdk/25-planner-executor-smoke.ts`.
Invoke through `tsx --tsconfig tsconfig.json` from the repository root with
`baseline|candidate` and a new output directory. Each invocation makes paid calls;
run only with explicit budget authorization. The runner rejects existing output
directories, never repeats another arm automatically, and requires an approved
single-Worker plan limited to the fixture implementation path. Its plan approval
is specific to this fixed evaluation protocol, not a production approval policy.

## Candidate Retest (2026-09-09)

Only the candidate was rerun after the read-only Reviewer fix, with the same
$1 threshold, 10-minute deadline, and one allowed repair. No baseline or
additional paid retry was run.

- Result: failed delivery, `Repair limit 1 reached`; duration 259.285 seconds.
- The luna Worker completed one context cut. Independent final tests passed 2/2,
  and protected tests/package metadata were unchanged.
- Reviewers returned structured findings instead of entering nested Plan approval.
  The first review requested initial-value and decrement-input validation. The
  strong-model repair implemented it. The second review rejected subscriber
  validation and subscriber exception behavior, exhausting the repair limit.
- Estimated total cost: $0.22743220, comprising $0.04870800 planning,
  $0.00650660 initial execution, $0.10072960 strong-model repair, and $0.07148800
  across two reviews. These are configured-rate estimates, not billing receipts.

Evidence is retained in `.artifacts/planner-executor-paid-candidate-retest-20260909`.
The original approval bug did not reproduce, but the full candidate has still
not delivered successfully. The next investigation should distinguish required
acceptance failures from additional hardening recommendations; passing the two
fixture tests alone does not establish correctness for all subscriber inputs.
Do not remove review gates or raise retry limits merely to count this run as a
success. This single forced-cut fixture does not establish cost savings.

## Boundary Retest (2026-09-09)

Only the candidate was run, under the same $1/10-minute stop thresholds. Result:
delivery stopped with `Review requires confirmation`, not successful completion.
The reviewer correctly confirmed atomic underflow rejection but asked whether
negative, NaN, and nonnumeric decrement amounts are also invalid. No repair task
was created, so the new boundary prevented an automatic expansion of scope.

Independent final verification passed 2/2 tests and protected tests/package
metadata were unchanged. The luna Worker recorded four model-requested cuts,
although the prompt requested one; this is an observed extra cost, not evidence
of strict one-cut compliance. At the time, the runner checked at least one cut.

Estimated cost was $0.11826556: $0.04571600 planning, $0.01293756 execution,
and $0.05961200 review. Duration was 215.485 seconds. No baseline or extra paid
retry was run. Evidence is retained under
`.artifacts/planner-executor-paid-boundary-20260909`.

The reviewer also noted missing test execution evidence in its Handoff: parent
tests had passed, but the review input supplied requirements and diff rather than
those logs. Its classified blocking finding was the input-contract ambiguity.
Before another paid run, clarify the intended input contract and consider passing
parent verification evidence into review; investigate redundant cuts separately.
This run validates the confirmation stop path, not full delivery or cost savings.

## Focused Follow-up (Offline)

The smoke protocol is now `counter-atomicity-v2`: excessive decrement must throw
without changing state or notifying subscribers; valid decrements commit before
notification. Finite non-negative inputs and valid non-throwing subscribers are
assumed. Other input validation and subscriber hardening are outside this fixture.
Candidate acceptance now requires exactly one cut, rather than at least one.

The four cuts above were requested by the Worker. Persisted boundary metadata
contained the window index, but the model-visible seed omitted it. Each replacement
window now includes a runtime receipt with the completed-cut count and boundary
identity. The fixed Worker contract explains that an already satisfied one-off
cut is not a pending step. Later cuts remain available for new context needs.

Delivery runs command acceptance gates before review. Review receives current
delivery-fingerprint parent test/build results, exit codes, evidence references,
and bounded log excerpts when available. Stale results and Worker self-reports
are not substituted for this evidence; missing evidence remains unknown.

These changes have offline regression coverage only. No new paid run has been
performed, and the earlier baseline uses a different task protocol. They do not
yet establish real-model one-cut compliance, successful delivery, or savings.
