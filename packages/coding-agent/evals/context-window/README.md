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

The real-repository runner compares summary with Workflow-backed hard cuts on three versioned QuixBugs Python defects: LIS, RPN evaluation, and prime sieve. Every run has three controlled boundary opportunities and recreates the AgentSession from the same Session JSONL three times. Summary can retain context when its configured recent-token budget leaves no prefix to compact. The final phase must recover an exact hidden verifier failure and an immutable token first observed in phase 1. With the default scripted memory policy, the hard-cut group uses three Notes, three Snapshot-backed windows, and must complete two exact History searches; additional proactive History queries are allowed.

The default `--boundary-trigger runner` mode cuts deterministically after each completed phase and reports memory correctness separately from protocol adherence. A and C receive byte-identical phase prompts, recorded with SHA-256 fingerprints in `report.json`, and neither group samples an artificial boundary acknowledgement. Opt-in `--boundary-trigger model` asks the hard-cut group to call `new_context`, falls back to a runner cut after a miss, and separately counts misses, duplicate calls, and post-cut tool actions.

### Interpretation and corrected prompt protocol

`matched-v2` removes the expected `memory_token` from the final phase prompt. Prompts describe the response fields;
the probe supplies the token, and the evaluator retains the expected answer for grading. Regression tests cover all
tasks and verify that changing hidden answers changes grading without changing any phase prompt or its hash.
The historical `matched-v1` results exposed the token in the final prompt and therefore cannot establish long-range
token recall. They are not a corrected baseline and must not be pooled with new runs.

This is a controlled memory stress test, recorded as `evaluationKind=controlled-memory-stress`. Notes contents and
History queries are scripted. `summaryKeepRecentTokens=1` deliberately stresses the summary path rather than using
its ordinary 20,000-token retention target. The `memoryPassed` field combines final-answer, repository, and
mechanism checks; it is not a standalone recall score. History hits count returned entries, not independently
validated retrieval relevance. A/C compares complete configurations, not the isolated causal effect of hard cuts.
Autonomous memory decisions and ordinary-default performance require separate evaluations. The corrected
18-run `matched-v2` matrix is documented in [cw17.10-report.md](./cw17.10-report.md): A passed the composite in
2/9 runs and C in 9/9; independent verification passed in 5/9 and 9/9 respectively. The report separates token
answers, protocol adherence, evidence reacquisition, and costs. Keep `summary` as the global default.

Validate all pinned repository digests, failing baselines, hidden-failure transitions, and reference repairs without network access:

```bash
npm run eval:context-window:real-repository -- --verify-task-set
```

Run a paid scripted A/C smoke on one task before the full matrix (current protocol: `matched-v5`):

```bash
npm run eval:context-window:real-repository -- --provider qingyingxy --model gpt-5.6-terra --thinking medium --task quixbugs-lis --repetitions 1 --max-cost 0.75 --output .artifacts/context-window-real-repository-smoke
```

Run the complete 3-task, 2-group, 3-repeat matrix strictly serially:

```bash
npm run eval:context-window:real-repository -- --provider qingyingxy --model gpt-5.6-terra --thinking medium --repetitions 3 --max-cost 3 --output .artifacts/context-window-real-repository-matched-v5
```

Run only the controller-triggered hard-cut group used by CW.17.8:

```bash
npm run eval:context-window:real-repository -- --provider qingyingxy --model gpt-5.6-terra --thinking medium --group C --boundary-trigger runner --repetitions 3 --max-cost 1.6 --output .artifacts/context-window-real-repository-cw17.8-v1
```

The runner copies a fresh digest-checked repository for every run, permits one source file to change, protects every other file by hash and inventory, disables Provider retries, and checkpoints after every run. Cost is estimated from pinned short-context rates, not verified provider billing. It stops after an execution error or an estimated-budget breach; checks after phases/calls can overshoot the threshold. This command makes paid API requests.

The 18-run model-triggered matrix, objective-projection defect, fix, and post-fix evidence are documented in [cw17.7-report.md](./cw17.7-report.md). The separated controller-triggered matrix and model-trigger counters are documented in [cw17.8-report.md](./cw17.8-report.md). The matched-prompt, matched-runner A/C matrix is documented in [cw17.9-report.md](./cw17.9-report.md).

### One-shot evidence and autonomous memory

Current scripted runs use `matched-v5`. Probe consumption is committed to Session JSONL before the first
disclosure, and all later-phase probe calls are denied. Initial verification is available once in task phase 3;
repair verification is available once in phase 4 and never returns the hidden marker, on failure or success.
Successful verification records a source hash. Composite grading now requires the exact marker before the
repair call and a successful verification of the final source. `recoveryPassed` separately combines exact token,
one probe call, marker recovery, current-source verification, independent verification, and disk resumes.
Blocked duplicate verification attempts count as protocol failures. Do not pool these runs with `matched-v2`.

`--memory-policy autonomous` selects `autonomous-v3`: the model chooses Notes content and History queries,
including whether to retain exact evidence in Notes. No fixed Note count or exact History query is graded.
Task phases, compaction instructions, boundaries, model settings, and the extreme summary retention target
remain controlled (retention can now be set explicitly). This measures autonomous memory operations within a scripted workflow, not autonomous routing.
Current protocols additionally reject provider error/aborted messages and missing replies within each phase.
They never reuse text from an earlier phase after a timed-out request. This fixes the error-handling defect
observed in an interrupted `autonomous-v1` batch; phase prompt contents are unchanged by that correction.

```bash
npm run eval:context-window:real-repository -- --provider qingyingxy --model gpt-5.6-terra --thinking medium --memory-policy autonomous --task quixbugs-lis --repetitions 1 --max-cost 0.75 --output .artifacts/context-window-autonomous-v3-smoke
```

The optional `--scenario` flag requires autonomous policy:

| Scenario | Intervention and acceptance |
|---|---|
| `continuity` (default) | Recover the original token and hidden repair with self-selected memory operations. |
| `changed-requirement` | Phase 2 supersedes an earlier delivery label; final delivery must use the new label without it being repeated in the final prompt. |
| `stale-evidence` | Source changes after initial official tests pass; final source must be repaired and independently verified, with a matching new model-verification hash. |
| `interrupted-operation` | A simulated external operation commits during suspension without acknowledgement; inspect its durable receipt after resume and avoid any duplicate apply attempt. This is not an OS-crash test. |

The implementation and original readiness record are in [cw17.11-report.md](./cw17.11-report.md).
Authorized execution is documented in [cw17.12-report.md](./cw17.12-report.md): the corrected `autonomous-v2`
matrix records all 18 planned slots, with composite A 0/9 versus C 8/9 and strict recovery A 0/9 versus C 6/9.
One C slot had an execution failure. Governance checks and the incomplete stale-evidence A/C comparison are
reported separately. Total recorded estimated consumption, including the discarded v1 batch, is $4.4049648.
These stress-test results do not justify changing the default or establishing a routing policy.

### Evidence status and normal retention

`matched-v5` / `autonomous-v3` add `benchmark_evidence_status` to both groups. It returns branch-local
consumption state and original tool-result entry IDs without redisclosing values. Resumed-phase prompts direct
the model to inspect availability and recover closed evidence from retained context, Notes, or History.
The original duplicate-call guards remain enforced; a consumed receipt does not imply a persisted result.

Pass `--summary-keep-recent-tokens 20000` to use the ordinary summary retention target on initial creation and
all resumes. The benchmark default remains 1. When there is no prefix to summarize, the summary group records
`actualReason=retained` and reopens the unchanged context. Durable task phases govern verifier availability
independently of physical cuts. C still makes three controlled hard cuts.

`evidenceExposure` reports which original evidence entries left active context. A passing final answer with
`crossBoundaryRecoveryExercised=false` demonstrates continuity with retained evidence, not retrieval after
exclusion. This normal-budget short-task comparison remains controller-driven and is not a long-task evaluation.
The results are in [cw17.13-report.md](./cw17.13-report.md): normal retention A and C each passed 3/3, with
zero redundant probes. A retained original evidence without compression; C recovered it after mandatory cuts.
The separate C/RPN smoke also passed. Cumulative recorded estimate is $5.1244976 including CW.17.12.
Docker/Pier and the no-model Pi SDK transport smoke are now operational in WSL; see
[PIER.md](./PIER.md) and [cw18.1-report.md](./cw18.1-report.md). The single-trial
A/C entry and request accounting are implemented and free-tested in
[cw18.2-report.md](./cw18.2-report.md). The first paid C pilot ran but stopped at a forced Plan approval wait;
it made no repository tool calls and is not a long-task memory validation. See [cw18.3-report.md](./cw18.3-report.md).
The approval-status and isolated-routing corrections passed free regressions in
[cw18.4-report.md](./cw18.4-report.md). The corrected C pilot executed 36 container
calls but stopped at 30 provider requests before committing or crossing a memory
boundary. Its official patch was empty and reward was 0; see
[cw18.5-report.md](./cw18.5-report.md). At that point the cumulative official-price
estimate was $5.6029184, leaving $0.3970816 under the $6 authorization; actual
service billing remains unverified. Long-task memory quality is still unvalidated.
Free fixes for continuous-tool-loop warnings, container capability disclosure,
and reserved submission requests are documented in [cw18.6-report.md](./cw18.6-report.md).
They introduce `isolated-fixed-direct-v2`.
The free v2 Docker submission smoke passed, including failed-verification
non-commit and independent application of a nonempty fixture patch; see
[cw18.7-report.md](./cw18.7-report.md). This is infrastructure acceptance,
not long-task memory-quality evidence.

The first paid v2 C pilot is documented in [cw18.8-report.md](./cw18.8-report.md).
It exercised two model-requested Snapshot-backed windows with Notes and History,
but failed local submission verification on a model-authored SQL test error.
No patch was committed; official reward is 0 and memory quality remains unvalidated.
The user authorized this single trial up to $2; it consumed an estimated
$1.5845236, bringing cumulative real-model estimates to $7.1874420. Service
billing remains unverified. No retry was launched. The bounded repair step and
free validation are documented in [cw18.9-report.md](./cw18.9-report.md).
The v3 protocol reserves four closing requests and permits one repair followed
by the identical verification command; failures and insufficient capacity
remain incomplete. The first paid v3 trial is documented in
[cw18.10-report.md](./cw18.10-report.md): one Snapshot window, a valid submitted
patch, feature tests 56/60 and preservation tests 1034/1038, binary reward 0.
The first local check passed, so no reserved repair was exercised. Cost was an
estimated $1.0917024; cumulative real-model estimates are $8.2791444. A successful
task baseline and routing comparison remain unavailable. Broader local
verification coverage is the next prerequisite before another paid pilot.

```bash
npm run eval:context-window:real-repository -- --provider qingyingxy --model gpt-5.6-terra --thinking medium --memory-policy autonomous --summary-keep-recent-tokens 20000 --repetitions 1 --max-cost 0.8 --output .artifacts/context-window-autonomous-v3-normal-retention
```

## DeepSWE long-horizon task

The first CW.18 task contract pins DeepSWE revision `0b9fabbb63b9104d678fe965e1632f2dd9eaa2ea` and the
`sqlite-utils-safe-import-checkpoints` task. The manifest records the upstream `sqlite-utils` base commit, official
resource limits, timeouts, and SHA-256 digests for the prompt, environment, and verifier assets. It deliberately does
not list `solution/` files.

Acquire the pinned benchmark source into the ignored artifact directory:

```bash
git clone https://github.com/datacurve-ai/deep-swe.git .artifacts/deep-swe-source
git -C .artifacts/deep-swe-source checkout 0b9fabbb63b9104d678fe965e1632f2dd9eaa2ea
```

Validate the task contract without making an API request. The manifest pins canonical Git blob bytes;
Windows CRLF checkouts fail correctly. On Windows use the fresh export created by the
[WSL smoke runner](./PIER.md), passing its `prepared` directory as `--source-root`:

```bash
npm run eval:context-window:deepswe:verify -- --verify-task-set
```

Check whether the official local runtime is available:

```bash
npm run eval:context-window:deepswe:verify -- --preflight
```

This command checks the invoking host's PATH only. Windows may report missing tools even when WSL is ready.
The WSL smoke runner checks the Docker daemon, Pier version, and Node interoperability in the actual runtime.

The official task requires Docker and Pier. The paid A/C runner must use the original prompt once, execute trials
serially, grade only with the separate DeepSWE verifier, and give both strategies the same model, reasoning effort,
effective context budget, repository execution tool, and timeout. C additionally exposes the memory tools;
see the exact strategy packages in [PIER.md](./PIER.md). Execution routing is fixed for this memory comparison.
The first run should be a single C-group smoke. Only after it produces a
valid hard-cut lineage and an official verifier result should the runner execute repeated A=`summary` versus
C=`windowed + Workflow Snapshot + Notes + History` trials.

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
