# Lightweight Multi-Stage Preflight

Date: 2026-09-07. Free candidate inspection and local acceptance checks.
No paid model calls, image pulls, dependency installations, production edits,
or host commits. This is preparation, not an A/C quality experiment.

## Decision

Reuse the existing `transitions` source and WSL runtime for developing a
continuous-task protocol. Do not download another benchmark environment yet.
The existing final-state task is a verified lightweight starting fixture, NOT
a demonstrated multi-window workload. A new multi-stage task and acceptance
suite still need to be prepared before paid execution.

SWE-Flow is useful methodological input, but its inspected generator is not a
drop-in continuous development chain. DevBench readtime is a small setup
example, not a sufficiently long task.

## SWE-Flow Source Findings

Inspected SWE-Flow revision `7da5b046fa1dc184674e4e94a9989be56c39e4e7`
and SWE-Flow-Bench revision `723a98aa8f1527f66b2627fc67ef5b43399263ca`.

- `schedule.py` sorts groups by core-node count and excludes previously
  developed nodes from each new step. This supplies step order, not measured
  long-agent trajectories or a guarantee that all steps depend on each other.
- `create_codebase.py` accumulates earlier test IDs into pass-to-pass lists.
- `helper/codebase.py` creates each skeleton/reference branch from the current
  branch and returns to that branch. Skeletonization reads the original
  project. Merely checking out successive base commits would replace the
  agent's work with prepared source states, invalidating continuous execution.
- `merge.py` filters small-patch steps, then renumbers exported instances.
  A `dev-N` suffix alone is not sufficient to reconstruct the original schedule.
- Both complete Git trees were available and not truncated. They contain
  generators/harnesses, not a checked-in full released task chain. An HF API
  search for `SWE-Flow` returned an empty array. This limited discovery result
  does not establish that public data is unavailable under another name.
- Reference patches, reference branches, original source backups and annotated
  answers must remain inaccessible to the implementing agent.

Docker Hub metadata for
`hambaobao/sweflow:pytransitions__--__transitions` reports 565481820 bytes
(about 565 MB decimal / 539 MiB) for Linux amd64, digest
`sha256:aab1b5c8160c487440aa0940dbe834bd9e35bb9a7d8030b355cbabcad232489a`.
This is compressed registry metadata, not unpacked disk usage or a successful
pull. It does not include unrelated dependencies/data. No image was pulled.

Sources:

- https://github.com/Hambaobao/SWE-Flow/blob/7da5b046fa1dc184674e4e94a9989be56c39e4e7/sweflow/extensions/python/schedule.py
- https://github.com/Hambaobao/SWE-Flow/blob/7da5b046fa1dc184674e4e94a9989be56c39e4e7/sweflow/extensions/python/helper/codebase.py
- https://github.com/Hambaobao/SWE-Flow/blob/7da5b046fa1dc184674e4e94a9989be56c39e4e7/sweflow/extensions/python/create_codebase.py
- https://github.com/Hambaobao/SWE-Flow/blob/7da5b046fa1dc184674e4e94a9989be56c39e4e7/sweflow/utils/merge.py
- https://hub.docker.com/v2/repositories/hambaobao/sweflow/tags/pytransitions__--__transitions

## Existing Local Fixture

Read the existing task README, public instruction, acceptance file,
preparation manifest/report, and natural C pilot report before selecting it.

- Base archive: 1119373 bytes, about 1.12 MB.
- Existing newer reference archive: 1137805 bytes, about 1.14 MB.
- All five archive/instruction/test SHA256 values match the earlier preparation
  manifest. No existing fixture or experiment artifact was overwritten.
- The existing natural C pilot passed 13/13 contract cases but reached only
  87760 maximum reported request-input tokens and performed zero cuts at 128K.
  Its USD 0.66038 estimate is HISTORICAL spending, not a new call in this turn.
- Previous scripted four-cut runs write reference stages. They validate
  lifecycle mechanics only and must not supply a paid agent execution tool.

References:

- `fixtures/transitions-final/README.md`
- `.artifacts/transitions-final-preparation-20260907/manifest.json`
- `.artifacts/transitions-natural-c-real-20260907/report.md`

## Fresh Free Checks

Ran the existing 13-case independent contract in Ubuntu using the existing
`/home/qingying/.local/share/pi-featurebench/venv/bin/python`. Used explicit
`PYTHONPATH` and `TRANSITIONS_TARGET`, Python `-P`, pytest importlib mode,
disabled bytecode/cache writes and disabled third-party plugin auto-loading.
The test fixture rejects imports from an unexpected target package.

| Target | Passed | Failed | Meaning |
|---|---:|---:|---|
| Frozen pre-feature base | 0 | 13 | Expected missing-feature negative control |
| Existing completed four-handoff fixture worktree | 13 | 0 | Positive acceptance control, not new agent work |

Inspected negative failure messages: missing `State.final`, missing public
stub parameters and unsupported `on_final`; no collection/import failure.
JUnit evidence:

- `.artifacts/lightweight-preflight-base-20260907.xml`
- `.artifacts/lightweight-preflight-positive-20260907.xml`

The full regression suite and isolation probes were NOT rerun. Prior reported
1104-pass/556-skip regression results are historical, not fresh results here.
These trusted fixture checks were run in WSL, not a newly validated agent
sandbox. Future model-authored execution still requires the isolated backend.

## Next Experiment Contract

This is a proposed custom continuous-development benchmark, not an official
SWE-Flow score. Do not describe it as ready until the following gates pass.

1. Author a fixed sequence of coherent feature increments on the historical
   base. Existing sync, nested, parallel, async and public-interface groups
   can organize the starting feature, but splitting them alone does not make
   the workload longer. Add genuinely dependent requirements and their own
   independent tests before a pilot; do not add filler or known-failure hints.
2. Freeze initial constraints, all later stage instructions, source hashes,
   hidden tests and stage-transition policy before either arm. Stage N must
   retain the model's stage N-1 source and the same session; no reference reset.
3. Advance after the model submits a stage under a fixed public protocol, not
   after the hidden grader reveals an answer. Preserve failed earlier work;
   stop at the common resource cap. Never provide host-generated repairs.
4. Validate missing-feature and complete-reference controls for each increment
   and cumulative regressions without a model. Keep the verifier, backups and
   reference Git objects outside the agent sandbox. Freeze any skipped tests.
5. Connect both arms through the existing SDK. A retains normal 20000-token
   summary retention; C retains Snapshot/Notes/History. Match model, reasoning,
   128K capacity, output limit, execution tools and external resource caps.
6. Run a free Faux bridge check for both arms, including persistence, stage
   ordering and isolation. Scripted success does not establish task quality.
7. Only with an explicit paid cap, run one A/C pilot. Do not force a cut on
   every stage or promise a fixed cut count. Report zero/few boundaries as
   insufficient long-horizon coverage. A smaller-window study is permissible
   only as a separately declared controlled experiment, not a relabeled 128K run.

Report final and per-stage correctness, early-constraint compliance, cumulative
regression loss, every actual maintenance boundary and subsequent execution,
and all input/cache/output costs including maintenance and recovery. A failed
test is not automatically a memory error; inspect pre/post-boundary evidence.
Keep incomplete/failed runs in the overall outcome table. Compare costs at
matched quality or success at matched budget, not cheap failures versus success.

## Readiness

| Gate | Status |
|---|---|
| Lightweight local source and runtime available | Verified |
| Existing 13-case negative/positive acceptance | Freshly verified |
| SWE-Flow implementation semantics inspected | Verified |
| SWE-Flow complete public chain acquired | Not verified |
| New sustained multi-stage workload and tests frozen | Not implemented |
| New paired continuous-stage SDK driver | Not implemented |
| Natural repeated-window quality/cost result | Not measured |

Only this documentation and fresh JUnit outputs were added. No code changes
were made, so the repository-wide code check was not run.
