# Queue Cancellation Pilot

Chinese consolidated results and proposed next tests: [REPORT.zh-CN.md](REPORT.zh-CN.md).

Status: one authorized v3 candidate repair passed nine shared tests and independent re-review.

The task and current nine-test acceptance suite live in
`../r16/fixtures/queue-cancellation`. The starter provides a working FIFO queue,
store subscriptions, promise execution, and idle tracking, but no cancellation.
Run `node packages/coding-agent/evals/queue-cancellation/verify-fixture.mjs`
from the repository root to check that the starter fails seven tests
and the isolated reference passes all nine. Historical v3 runs retain their eight-test snapshots. The reference must never be copied
into model workspaces or included in model prompts.

The task is selected for interactions among logical cancellation, physical
execution, event ordering, and concurrency. It is a medium pilot, not an assumed
long-context benchmark: the implementation can still be concise. Do not enlarge
the task after seeing a model's score or claim long-context evidence if no window
boundary occurs.

## Paired Protocol

- Freeze the task, tests, and starter digest before either arm runs.
- Baseline: strong model executes directly. Candidate: strong Planner and one
  fast Worker, with approval limited to the existing three source files.
- Both arms receive the same task contract, readable tests, writable source
  paths, external test command, and independent strong-model review prompt.
- The parent executes tests and supplies the same evidence format to review.
  Use zero post-review repairs in both arms for the first pilot; test-driven
  fixes within execution remain allowed and charged.
- Both execution sessions use windowed mode with 16,384 reserved tokens. No forced
  cut and no minimum cut count. Record whether cuts actually occurred.
- Each arm runs once with a $1 estimated-cost stop threshold and ten-minute
  deadline, including review. Record failures and all incurred usage. Thresholds
  are not provider-side billing caps.
- Compare only with protected-file digests intact and acceptance outcomes
  reported. Include planning, execution, review, retries and window maintenance
  in cost and wall time. One pair is exploratory, not statistical evidence.

The manual runner is `examples/sdk/26-queue-cancellation-evaluation.ts` relative
to the coding-agent package. From the repository root invoke it through
`node node_modules/tsx/dist/cli.mjs --tsconfig tsconfig.json` with `--offline`
for approval checks, or `baseline|candidate NEW_OUTPUT_DIRECTORY` for one paid arm.
It rejects existing output directories and never automatically repeats an arm.
The separately authorized `repair NEW_OUTPUT_DIRECTORY` mode specifically loads
the saved v3 candidate and baseline reports from the artifact paths below. It
does not replan or rerun either original arm. Fresh arms now record v4 because
the shared acceptance suite has nine tests; none have been run yet.

Candidate execution reuses `createPlannerExecutorSession`, with zero workflow
retries and test/diff requirements only. Both arms then receive the same external
test and independent read-only strong-model review using the existing structured
Handoff parser and review boundary. The reviewer sees the original contract,
before/after source, and actual parent test output. No extra review repair is run.
This common final gate is owned by the evaluation host; it is not the candidate's
native delivery review gate. Candidate internal verification overhead remains
included in cost and duration.

Task, tests, source, and local context settings are hashed before execution.
Protected paths and the complete file inventory must remain unchanged, except
for content changes in the three approved source files. Reference code stays
outside the temporary workspaces. Sessions and reports are retained in the chosen
output directory. Shell tools are not protected by an OS filesystem sandbox.
Models may have different context capacities, so an identical reserve does not
guarantee identical absolute cut thresholds. Cuts are observations, not acceptance
requirements. This pilot does not isolate the causal effect of context cutting.

## First Pair (2026-09-09)

Both v1 arms used the same starter digest, tests and final review policy.

| Arm | Result | Estimated total cost | Duration |
| --- | --- | --- | --- |
| Strong direct + common review | 7/7 tests, review passed | $0.39654720 | 347.416 s |
| Strong Planner + fast Worker + common review | Plan rejected before Worker launch | $0.08090960 | 64.295 s |

Baseline execution cost $0.32362320 and review cost $0.07292400. It made zero
context cuts; protected files and inventory were unchanged. Candidate planning
guessed .js/.ts paths eight times and never discovered the .mjs source files.
It then requested `src/**`, which the exact-file approval gate rejected. This
failure is not evidence that the candidate is cheaper or unable to implement
cancellation. Total incurred cost for the pair was $0.47745680.

Root cause: the candidate host relied on SDK default tools (read/bash/edit/write),
so its read-only planning phase lacked the directory/search tools explicitly
available to the baseline. v2 explicitly supplies the same tool names to both
host sessions; Planner role restrictions still prevent writes. The task and
approval boundary are unchanged. The v2 retest is recorded below. Preserve v1
reports instead of replacing them or counting them as implementation results.

Evidence: `.artifacts/queue-cancellation-baseline-20260909` and
`.artifacts/queue-cancellation-candidate-20260909` under the repository root.

## Candidate v2 Retest (2026-09-09)

One candidate retest was run after enabling Planner discovery tools. The starter
digest matches the baseline. Approval succeeded, the fast Worker implemented the
change, all seven parent tests passed, and protected paths/inventory remained
unchanged. No context cuts or post-review repairs occurred.

Final result: failed independent review. During queued notification, a subscriber
can call onIdle() before enqueue inserts the task into pending. The promise then
resolves while the task is still running. This violates the existing onIdle
contract, although it is inherited from the starter rather than a new regression.
The seven fixed tests did not cover this callback ordering; their passing reference
is therefore not evidence of complete contract coverage. No acceptance tests were
changed during this run.

A separate offline reproduction was run against the saved candidate, baseline,
and starter: candidate and starter reported idle during active execution; baseline
did not. The script is `.artifacts/queue-cancellation-idle-reproduction.mjs`.

Candidate estimated cost: $0.18964844 = $0.07758560 planning + $0.01283484 Worker
+ $0.09922800 review. Duration: 299.718 seconds. Baseline remains $0.39654720,
347.416 seconds, tests/review passed. Candidate expenditure was 52.2% lower, but
its delivery failed, so this is not a successful-delivery savings result. Both
arms had zero cuts, providing no long-context continuity evidence. This compares
a v2 candidate retest with the earlier v1 baseline, not fresh repeated paired runs.
Including the failed v1 candidate, total queue pilot spend is $0.66710524.

Evidence: `.artifacts/queue-cancellation-candidate-v2-20260909/report.json`.
No paid retry or repair followed this result. A future protocol should include
the missing idle-in-subscriber case for both arms before another paired run.

## v3 Shared Acceptance

The additional test calls onIdle() inside a queued subscriber, holds execution
open with a manually settled promise, and verifies that idle stays pending until
physical settlement. It also verifies eventual completion of the subscriber's
idle promise. The reference queues the entry before publishing queued state.
The defective starter is unchanged. The contract is unchanged; only the missing
test and preflight expected counts were updated. Both v3 arms start fresh from
the same fixture and use zero post-review repairs. Their costs are new full-run
costs, not the incremental cost of repairing the saved v2 candidate.

## v3 Results (2026-09-09)

| Arm | Tests | Independent review | Estimated full cost | Duration |
| --- | --- | --- | --- | --- |
| Strong direct | 8/8 passed | Passed | $0.27564400 | 247.161 s |
| Strong Planner + fast Worker | 8/8 passed | Failed | $0.15994632 | 277.014 s |

Both used identical starter digests and preserved protected files and inventory.
Neither execution cut context. Baseline execution cost $0.21607200 and review
$0.05957200. Candidate planning cost $0.08059360, Worker $0.01626072, and review
$0.06309200. The fresh pair cost $0.43559032; all queue pilot runs including
previous failures cost $1.10269556 at configured rates.

The v2 queued-subscriber idle defect now passes the common regression test.
The v3 candidate instead publishes running state before registering its abort
controller. A subscriber that immediately calls cancel(id) sees success and
cancelled state, but the task subsequently receives a non-aborted signal. The
review finding is within the original running-cancellation requirement. An
offline replay against saved v3 outputs confirms signal.aborted is false for
the candidate and true for the baseline. Replay script:
`.artifacts/queue-cancellation-v3-abort-reproduction.mjs`.

Candidate expenditure was 42.0% lower, but delivery failed, so it is not a
successful-delivery savings result. No paid repair or retry followed review.
The eight tests remain frozen for this pair; the diagnostic was not silently
added to acceptance or used to relabel historical runs. Further success claims
must include any subsequent repair/review costs, not only the cheap Worker run.

Evidence: `.artifacts/queue-cancellation-baseline-v3-20260909/report.json` and
`.artifacts/queue-cancellation-candidate-v3-20260909/report.json`.

## One Bounded v3 Repair (2026-09-09)

After explicit authorization, one fresh fast-model execution session received
the saved v3 candidate sources and a concrete repair instruction: register the
controller before publishing running state. Only queue.mjs and runner.mjs were
writable under the evaluation integrity check; store.mjs and tests were protected.
This was a manually directed recovery experiment using SDK Direct execution,
not evidence of an automatically selected production recovery path.

The ninth common test cancels from the running subscriber and checks that run
receives an aborted signal. Before any paid call, the saved baseline passed all
nine tests offline and the saved candidate failed exactly the new test. The
original snapshots and reports remain unchanged. The repair then passed all nine
tests and independent read-only review with review_findings:[]; only the two
authorized files changed. No context cut or further repair occurred.

| Cost component | Estimated cost |
| --- | --- |
| Original v3 planning, execution and failed review | $0.15994632 |
| One fast-model repair | $0.00514200 |
| Independent re-review | $0.04296400 |
| Candidate cumulative cost to accepted result | $0.20805232 |
| Saved successful v3 baseline | $0.27564400 |

The incremental repair run cost $0.04810600 and took 75.061 seconds, below its
$0.11569768 remaining-cost stop threshold. Candidate cumulative active run time
was 352.075 seconds versus baseline 247.161 seconds (excluding human turnaround
and offline test preparation). Candidate cost was 24.5% lower on this single
recovery example, but it was slower. Baseline was offline-revalidated with the
ninth test, not paid-rerun under a new prompt. This is an exploratory saved-output
comparison, not a repeated randomized paired benchmark or a general savings claim.

All queue pilot model spend, including earlier failed experiments, totals
$1.15080156 at configured rates. This historical pilot spend is distinct from
the $0.20805232 cost of the v3 candidate plus its one repair. No billing receipts
or long-context effectiveness claims are implied.

Evidence: `.artifacts/queue-cancellation-v3-repair1-20260909/report.json`,
`baseline-verification.json`, `preflight.json`, `verification.json`, and the
preserved repaired `workspace` in that directory.
