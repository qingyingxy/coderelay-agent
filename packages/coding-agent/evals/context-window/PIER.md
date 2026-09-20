# Pier Transport Smoke

This entry point runs the actual Pi SDK with the Faux Provider against a pinned
DeepSWE Docker task. It cannot select a paid model. It is a transport and memory
lifecycle check, not a solution-quality evaluation or an A/C comparison.

## Local prerequisites

- WSL Ubuntu, Docker available to `qingying` without sudo.
- `/home/qingying/.local/share/pi-deepswe/venv`: `datacurve-pier==0.3.1`.
- Windows Node at `D:\compileenv\nodejs\node.exe`, repo at `E:\code\pi` with dependencies.
- WSL Windows executable interoperability must work. On this machine a targeted
  `pi-wsl-interop.service` restores `/etc/binfmt.d/WSLInterop.conf` at startup;
  Ubuntu's general `systemd-binfmt` service intentionally skips WSL.
- Public benchmark checkout under `.artifacts/deep-swe-source` containing commit
  `0b9fabbb63b9104d678fe965e1632f2dd9eaa2ea`.

The adapter currently targets this Windows/WSL layout. It is not a portable
Linux deployment adapter. Installed Python dependency versions are captured in
each trial's `agent/requirements.freeze.txt`.

## Run from PowerShell

Use a fresh output directory on each run:

```powershell
wsl -d Ubuntu -u qingying -- /home/qingying/.local/share/pi-deepswe/venv/bin/python /mnt/e/code/pi/packages/coding-agent/evals/context-window/run_pier_smoke.py --output /mnt/e/code/pi/.artifacts/deepswe-smoke-next
```

The runner checks Docker, Node and Pier; exports only the eight pinned Git blobs
to a fresh directory; validates their exact bytes before export; and starts one
trial without retries. No `solution/` files are exported. A Windows checkout
converted to CRLF now correctly fails the existing byte validator; validate the
prepared export instead. Never run the Windows-converted task directly.

Pi's only active tools are `container_exec`, `notes`, `history`, and `new_context`.
Target commands execute through `environment.exec` in `/app`. Host file tools,
skills and extensions are not loaded. Agent and separate verifier use the
official `no-network` task configuration. The smoke checks that the agent cannot
see `/tests/test.sh` or the Docker socket, but this is not a security audit.

The scripted sequence inspects the target revision, saves a Note, requests one
context cut, queries History, and commits a harmless text fixture inside the
disposable target repository. Pier collects the resulting patch and applies it
in a separate verifier container with the official hidden tests.

## Acceptance

`smoke-acceptance.json` must report `passed: true`. Acceptance requires no trial
exception, SDK success with zero model cost, a nonempty fixture patch applied by
the verifier, all 1,038 existing tests passing, and all 60 unimplemented feature
tests failing. Expected functional reward is **0**. The partial score around
0.945 is not a solution success rate. Pier may exit 0 even on infrastructure
errors; the wrapper inspects artifacts and exits nonzero on rejection.

`--inspect <job-directory>` performs the same acceptance check on an existing
run without invoking Docker or a model. Missing evidence is an error.

Both smoke and real runners accept `--manifest <pinned-manifest.json>` and
`--task <task-id>`. A single-task manifest can omit `--task`; ambiguous or unknown
selections are rejected. Only the selected task is exported, with its selected
provenance retained. Defaults still select sqlite-utils.

For a selected task, smoke expectations come from its pinned `tests/config.json`,
not the sqlite-utils counts above. `smoke-expected.json` records task ID, base
commit, feature/preservation counts and manifest hash. Acceptance checks the
initial container HEAD, all pinned preservation cases passing, and no new
feature cases passing. `--inspect` reuses these persisted expectations. Official
grading semantics (including skipped/xfail handling) still apply; inspect the
raw test summary as well as the reward. See [cw18.24-report.md](./cw18.24-report.md)
for the first selected-task smoke and the 128K A/C preparation commands.

When a task declares an abbreviated hexadecimal base commit, the smoke resolves
it using `git rev-parse --verify <base>^{commit}` in a temporary no-network task
container. It records both `declaredBase` and the resolved full SHA, then compares
the trial's initial HEAD exactly. Ambiguous or mismatched resolution fails;
the task's pinned files are not rewritten. See [cw18.30-report.md](./cw18.30-report.md)
for the natural-long-task candidate screening and environment checks.

Session JSONL, SDK events, command/result bridge logs, instruction, dependency
freeze, official reward, grader output and patch are retained. `--no-delete`
keeps reusable images; Pier still stops the trial containers. Existing failed
runs are retained and must not be pooled with successful infrastructure checks.

This smoke provides no evidence for routing quality, summary-budget quality,
real-model recovery decisions, or Workflow Snapshot behavior.

## Controlled-checkpoint lifecycle probe

`smoke-controlled-boundary.ts CHECKPOINT OUTPUT` is a separate, zero-network
Faux harness probe. It replays the frozen assistant responses and cached tool
results through a normal session prompt, validating call IDs, commands and
task-visible message equality. Recorded commands are not executed. This keeps
the C Direct Workflow adapter live until `new_context` persists its Snapshot.
A uses the SDK compaction primitives at the same settled tool boundary, without
aborting the ongoing session. Both then perform an inert scripted tool call.

The probe requires an executing C Workflow, a Snapshot-backed cut, preserved
handoff text and no fallback Seed. Summary and handoff content are scripted;
request counts and byte sizes do not measure real-model quality or cost.
It does not launch Pier or accept a paid provider configuration. See
[cw18.27-report.md](./cw18.27-report.md) for the initial lifecycle result.

The Pier integration is available through `run_pier_real.py --controlled-checkpoint
<directory>` and the same option plus `--group A|C` on `run_pier_smoke.py`.
The latter cannot combine with `--submission` and uses only Faux responses.
Checkpoints require `repository.json` (base/tree/branch), `checkpoint.json` and
the selected arm's `session.jsonl`. Real-run preparation freezes these files
and checks the session hash, task instruction and base. The container must
match the clean base/tree before the task branch is created. Only audited
pre-edit checkpoints are supported; arbitrary modified working trees are not
reconstructed by replaying commands.

The `single-boundary-v1` evaluator bypasses provider dispatch and cost accounting
for cached prefix responses, then counts summary/handoff and continuation calls
through the normal external budget wrapper. C receives a generic maintenance
instruction (recorded in `controlled-handoff-instruction.txt`), not task hints.
Repository execution/submission is gated until maintenance completes. Missing
or multiple boundaries produce `controlled_boundary_incomplete`. The default
noncontrolled runner retains its original behavior. See
[cw18.28-report.md](./cw18.28-report.md) for actual free container A/C validation.

## Budgeted real-model entry

`run_pier_real.py` prepares one trial by default, without loading credentials,
starting containers, or contacting a model. It validates the configuration and
exports pinned task files. `--execute-paid` explicitly enables one paid trial;
each invocation requires a fresh output directory, with no automatic retries
or resume. It does not launch a matrix or share a budget across invocations.

Configuration JSON must contain only these fields:

- `provider`, `model`: an existing Pi model and credential configuration.
- `group`: `A` (summary) or `C` (windowed plus Workflow Snapshot).
- `maxCostUsd`: per-trial accounted-cost limit, including summary requests.
- `maxRequests`: positive total provider request limit, including summary requests.
- `contextWindow`: effective context limit, 40000 to 272000 tokens, supported
  by the chosen model. Both groups must use the same value.
- `maxOutputTokens`: positive integer up to 16000 and within model capacity.
- `timeoutSeconds`: positive integer up to the official 10800-second limit.
- `pricing`: explicit `input`, `output`, `cacheRead`, `cacheWrite` USD per
  million tokens. Input/output rates must be positive. Confirm rates with the
  actual service before execution; never place credentials in this JSON.

Both strategies use medium thinking, normal 20000-token summary retention,
16000 reserve tokens, and the same remote repository execution tool. A uses the
summary SDK mode, which retains session history on disk but does not register
Notes or History tools. C has Notes, History, `new_context`, and Workflow tracking. The original
task instruction is submitted once. Default noncontrolled runs have no budget-driven execution phases,
forced memory boundaries or retries;
actual compactions and context cuts are recorded. This compares strategy packages,
not just the choice of summary versus truncation.

Execution policy `isolated-fixed-direct-v4` fixes execution to Direct for both
groups. C passes the SDK's per-prompt `isolatedDirectExecution` option with a
host authorization reason, preserving the Direct Workflow adapter and Snapshot
checkpoints. This trusted-host option does not create a sandbox; the Pier host
must enforce the disposable container and tool allowlist. It rejects automation,
execution protocols, pending Plans/clarifications, and non-Direct sessions.
It is not persisted, exposed as a model tool, or enabled in ordinary CLI routing.
Production risk matching still forces Plan for destructive instructions and
command invocations; destructive prefixes in an explicit `Add commands:` CLI
declaration no longer count as invocations.

Before the first model request, the host probes `git`, `python`, `python3`,
`perl`, `patch`, `apply_patch`, and `rg` inside the target container. The recorded
availability is included in the system prompt; missing Git fails before paid
dispatch. The probe is separate from model-requested execution counters. The
prompt distinguishes apply_patch syntax from unified patches and recommends
available Python/pathlib for edits when the patch helper is missing.

Both groups have `container_submit`. It runs `git diff --check` and a bounded
model-selected local verification command; only exit 0 permits staging and
committing all task changes in the disposable repository. Verification/commit
failure is a tool error and cannot establish submission success. The chosen
check can be weak: this is a submission mechanism, not an independent quality
gate. Official grading still decides task success. Commands remain trusted
model shell input inside the existing isolated container.

Failed verification or commit leaves normal tools available. The model repairs
through `container_exec` and retries `container_submit`; no dedicated repair
tool, repair-count limit, closing reserve or budget notice is injected. Repeated
submission must use the exact original verification command; changed commands
are rejected before execution. The prompt requires resolving known failed
checks and forbids weakening checks or embedding edits in verification.
It does not automatically classify ordinary shell commands as tests or enforce
requirement coverage. Independent grading still decides correctness.

Memory tools and normal context maintenance remain available throughout repair.
Snapshot, Notes, History and `new_context.handoff` are unchanged. Any
`container_exec` after successful submission conservatively invalidates current
submission status, even for a read-only or failed command, since arbitrary
shell input may modify the repository. Fresh submission is then required;
prior verification and commit evidence remains in the attempt log.

The evaluation caller retains spending/request limits and timeout cancellation,
without changing the agent's execution phase, tool list or memory policy. This
is an evaluation safeguard, not a platform implementation or Agent core feature.
No requests are reserved for submission or a final reply. A stopped trial may
have no final reply or submitted patch and must be reported as incomplete.
Cancellation observed after verification prevents starting a commit; an already
running bridge command may finish before cancellation returns.

Windowed/hybrid Workflow sessions now check context after each tool turn,
including newly returned tool output, before sampling again. Soft warnings use
the steering queue; hard cuts persist completed tool results before refreshing
context. Terminal provider failures do not enqueue a fresh memory reminder.

Preparation-only PowerShell command:

```powershell
wsl -d Ubuntu -u qingying -- /home/qingying/.local/share/pi-deepswe/venv/bin/python /mnt/e/code/pi/packages/coding-agent/evals/context-window/run_pier_real.py --config /mnt/e/code/pi/.artifacts/pier-run-config.json --output /mnt/e/code/pi/.artifacts/pier-real-plan-next
```

After reviewing provider, pricing and total experiment budget, a new invocation
with a fresh output directory and `--execute-paid` starts exactly one trial.
Preparation does not validate credentials or prove provider connectivity.

The shared agent stream wrapper also receives SDK compaction and branch-summary
calls. Before dispatch, it reserves a full configured context at the largest
input/cache rate plus the maximum output allowance. Insufficient room blocks
the request before network dispatch. Successful usage replaces the reservation
with recalculated cost; errors or absent usage retain the reservation and stop
further requests. HTTP and session retries are disabled. Cache tokens are charged
once, and reasoning is not added on top of provider output tokens.

This conservative reservation can stop before the nominal limit is consumed.
It is an estimate, not a provider-side billing cap: rates, token semantics and
provider enforcement must match the configuration. Unknown usage is explicitly
flagged. Do not sum accounting estimates as if they were confirmed invoices.

`budget.jsonl` records evaluation reservations, settlements and blocked requests;
`capabilities.json` and `submission.json` retain the capability probe and current
submission evidence (null when invalidated or a new attempt has not returned).
`submission-attempts.jsonl` preserves each returned verification/commit attempt
and its verification command. Ordinary repair commands remain in Session and
bridge logs. The runtime result includes the submission attempt count;
`run-config.json` includes tool names and prompt hashes; Session JSONL and events
retain memory actions and execution evidence. `sdk-result.json` distinguishes
runtime completion, approval/clarification waiting, planning, no execution,
timeout, budget/provider stop, incomplete replies and `submission_incomplete`. Completion requires a
normal final reply, at least one container call, all calls returning, and a
completed Workflow when tracking is enabled, plus successful local submission.
It does not prove the requested
implementation was completed. Command failures remain in tool evidence.
`report.json` retains the independent official verifier result separately,
including nullable official success, actual patch byte count, and whether a
memory boundary was exercised. `memoryQualityEligible` requires runtime
completion, a summary boundary (A) or Snapshot-backed window (C), a new
`container_exec` call and its matching result after a boundary on the final
Session branch, and a reward without an infrastructure exception. A summary
after the final answer, text-only continuation, submission alone, or missing/
ambiguous Session evidence does not qualify. `memoryContinuation` records
per-boundary assistant turns, execution calls, results and evidence entry IDs.
This is a minimum execution-evidence filter, not proof of substantial work or
correct recovery: review commands and final independent results separately.
Failed commands count as attempted execution. Ineligible attempts must still be reported;
this flag is not permission to remove failures from overall success denominators.
A normal model reply does not imply feature success. Budget-stopped and failed
trials are retained; missing SDK evidence is not a zero-cost successful trial.

The current implementation supports a single trial. Run C smoke first after
budget review; only then plan serial matched A/C repetitions under an explicit
aggregate limit. No paid trial was executed during implementation; see
[cw18.2-report.md](./cw18.2-report.md) for free validation.
The first paid pilot and its approval-blocked failure remain in
[cw18.3-report.md](./cw18.3-report.md). The subsequent free routing and status
corrections are documented in [cw18.4-report.md](./cw18.4-report.md).
The request-limited v1 attempt is in [cw18.5-report.md](./cw18.5-report.md).
The v2 corrections and free checks are in [cw18.6-report.md](./cw18.6-report.md).
Do not pool v1/v2 outcomes as an unchanged experimental protocol.

The first paid v2 C trial is in [cw18.8-report.md](./cw18.8-report.md). It
exercised two Snapshot-backed windows but failed local verification and
submitted no patch. Cost was an estimated $1.5845236 against a $2 trial cap;
cumulative real-model estimates are $7.1874420. This is mechanism evidence,
not a successful long-task baseline. Its missing repair stage motivated the v3
bounded repair protocol, free-tested in [cw18.9-report.md](./cw18.9-report.md).
The first paid v3 trial is in [cw18.10-report.md](./cw18.10-report.md): one
Snapshot window and a valid patch, but official feature 56/60 and preservation
1034/1038, reward 0. Initial local verification passed, so repair was not
exercised. Cost was an estimated $1.0917024; cumulative real-model estimates
are $8.2791444. No A/C matrix was launched. Do not pool v2/v3 as an unchanged protocol.

## Free normal repair submission smoke

Pass `--submission` to `run_pier_smoke.py` to exercise `runPierSession` with
Faux responses and real container commands. It creates a broken fixture,
fails local verification and checks that HEAD remains unchanged, then repairs
the file through `container_exec`, repeats the identical verification command,
and commits. Execution and memory tools must remain available after failure
and repair. Acceptance requires
the independent verifier to apply the collected patch and preserve all 1038
existing tests. Feature reward 0 is expected. This entry cannot select a paid
model; synthetic SDK accounting is not real spending.

The historical v2 result is in [cw18.7-report.md](./cw18.7-report.md); the v3
repair result is in [cw18.9-report.md](./cw18.9-report.md).
This smoke does not exercise cross-window recovery or autonomous task quality.

The v4 simplification and free regressions are documented in
[cw18.13-report.md](./cw18.13-report.md). Do not pool v3/v4 results as an
unchanged experimental protocol.

The first paid v4 C trial is in [cw18.14-report.md](./cw18.14-report.md):
normal repair and three Snapshot cuts, full local verification before submission,
but official feature 56/60 and preservation 1038/1038, reward 0. All four feature
failures are safe-upsert paths absent from the added tests. Estimated cost was
$0.7662416 under the $2 cap; no automatic retry was performed.
