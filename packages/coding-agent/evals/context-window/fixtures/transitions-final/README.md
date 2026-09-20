# Transitions Final-State Task

This is a lightweight historical feature-reimplementation task, combining
transitions PR #665 and the documented parallel-order bug #715. It is suitable
for controlled handoff experiments, not claimed to naturally fill 128K windows.

- Public task input: `instruction.md`.
- Independent acceptance: `test_final_contract.py` (13 cases).
- Baseline commit: `db2941a7ff5da45ff84f35a90a966c36c1104ff2`.
- Historical feature head: `e7f1101163dbce8248140e9fda5e34a83c04d02c`.
- Sources: https://github.com/pytransitions/transitions/pull/665 and
  https://github.com/pytransitions/transitions/issues/715.

No reference implementation or patch should be included in Agent input.
Do not use the latest source as the task starting point: it already implements
the feature. Keep independent acceptance outside the implementing checkout.

## Validated Cases

| Acceptance group | Cases |
|---|---:|
| Final flag, sync entry/re-entry, failed conditions | 5 |
| Hierarchical finality | 1 |
| Parallel completion in both orders | 2 |
| Awaited async callbacks and async parallel finality | 4 |
| Public stub parameter declarations | 1 |

The stub case parses public `.pyi` signatures; it is not a full mypy/pyright run.
Async cases use a scheduling yield (`sleep(0)`), not elapsed-time assertions.

Run with the selected source root on PYTHONPATH and in TRANSITIONS_TARGET:

```sh
PYTHONPATH=/path/to/source TRANSITIONS_TARGET=/path/to/source python -m pytest /path/to/test_final_contract.py -q --junitxml=/path/to/result.xml
```

The autouse fixture rejects imports from another installed transitions package.
When running the frozen baseline regressions against a different source tree,
use Python `-P`, pytest `--import-mode=importlib`, and PYTHONPATH ordered as
`reference-source:baseline-source`; this prevents test collection from silently
importing the baseline implementation instead of the selected target.

## Preparation Results

On Python 3.12 with existing pytest/six, without installing diagram packages:

- Pre-feature baseline: 0/13 acceptance; 1104 passed, 556 skipped in baseline regressions.
- Historical feature head: 10/13 acceptance. Fails sync and async parallel-order
  checks and the Machine.on_final stub parameter check.
- Existing newer source: 13/13 acceptance and 1104 passed, 556 skipped using
  the same baseline regression files. It is a positive reference, not an
  assertion that all later upstream changes are necessary for the task.

Regressions: baseline `test_core.py`, `test_states.py`, `test_nesting.py`,
`test_async.py`, `test_threading.py`, `test_parallel.py`. Optional combinations
account for skipped cases; do not report the full upstream suite as executed.

Exact source-archive hashes, fixture hashes and JUnit summaries are retained in
`.artifacts/transitions-final-preparation-20260907/manifest.json`.

## Controlled Rehearsal

The five acceptance groups provide candidate boundaries for four controlled
handoffs. Requirements must be fixed upfront and identical for A/C. A boundary
only counts when work or verification genuinely remains, followed by actual
execution. Do not force empty handoffs if the Agent completes everything early.

A C-only free rehearsal is available as `smoke-four-handoffs.ts OUTPUT` from
the repository root via Node/tsx. It applies scripted reference stages to an
isolated copy and runs real tests through `transitions_fixture_stage.py`.
It uses the local WSL/Python layout and the previously prepared source archives.

The completed run is `.artifacts/transitions-four-handoffs-20260907-v2`:
four Snapshot-backed cuts, five actual test stages, final 13/13 contract cases
and 1104 passing baseline regressions (556 skipped). First-stage hierarchical
failures are retained and rerun in stage two; parallel-order failures persist
through later handoffs until the final reference correction.

All responses, handoff text and source modifications are scripted. This tests
transport and lifecycle only, not autonomous implementation, handoff generation,
or natural 128K window pressure. A was not run in this rehearsal. The final
correction replaces the fixture package with the known passing reference; it
is not an Agent-generated repair. Do not use this reference-writing tool in a
paid quality evaluation.

Pass `A` after OUTPUT to probe the same stages under normal summary settings.
The completed A run is `.artifacts/transitions-four-summaries-20260907`.
All five source states and test outcomes match C, but the four maintenance
points contain only 993, 1138, 1283 and 1428 estimated tokens. With normal
20000-token retention, prepareCompaction returns no summary work each time:
zero compactions. `passed` records successful stage execution;
`fourMaintenanceEventsVerified: false` records the missing maintenance coverage.

Thus these short scripted reports are not an equivalent four-boundary A/C
comparison. Do not reduce retention or add filler to relabel them as such.
This says nothing about how much context an actual implementing model would
produce: the fixture applies reference code without requiring model code reads
or generation. No paid comparison has been validated by this probe.

## Natural C Pilot

The real implementing-model run is recorded in
`.artifacts/transitions-natural-c-real-20260907/report.md`. It reused the real
SDK session with a local Bubblewrap execution bridge, no new image downloads,
and no reference-writing fixture tool. Network and host repositories were
unavailable to the implementing shell. Independent acceptance ran afterward.

Result: 13/13 contract cases, 1104 passing frozen regressions (556 skipped),
23 model requests, estimated USD 0.66038, maximum reported input 87760 tokens,
zero context cuts. The model independently edited, tested, repaired and
submitted its code. This is a successful correctness pilot, but provides no
natural handoff coverage and is not an A/C comparison. Do not confuse the
1461820 cumulative input tokens with active context occupancy.
