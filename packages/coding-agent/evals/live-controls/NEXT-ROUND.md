# Next-round cost comparison protocol

Status: offline preparation only. No paid launch authorized by this document.

Objective: compare full successful-delivery cost for sol direct, sol planning + luna execution, and sol planning + terra execution. Count all planning, execution, context maintenance, review, correction and repair calls, including failed attempts. Report failures separately; do not compute successful-delivery savings for an undelivered arm.

Keep the original live-controls request, baseline, business-source write scope, one Worker, medium reasoning, common sol reviewer and at most one sol repair. Natural context cuts only. Do not extend the live tool's feature scope. Start each new arm from the same original baseline; do not reuse evaluated patches or plans.

Execution policy revision: remove the $2 soft stopping threshold and the 15-minute total-duration limit. Remove the candidate-only four-minute Worker cutoff as well. Record total elapsed time and all model costs as outcomes, not stopping criteria. A progressing task may run longer than 30 minutes. Apply the same policy to direct execution, planning, Worker execution, review and repair across all three arms.

Use 30 minutes without a response as an inactivity fallback, not a total task deadline. Detect suspected loops from repeated equivalent operations and unchanged results without new evidence or task-state progress; lack of file edits alone is not evidence of a loop. Read-only exploration and review are legitimate progress. Save the triggering evidence and classify watchdog termination separately from acceptance failure. No detector can guarantee that a run is a true infinite loop.

Implementation: use `packages/coding-agent/evals/live-controls/run-comparison.ts` in the next sealed snapshot. Parent execution/planning/repair and child Worker/reviewer runs use the same watchdog policy. The explicit SubagentRuntime option removes cost, duration and turn caps inherited from profiles and task budgets, including the candidate Worker cutoff; runs without this option retain their existing policy. The new launcher supplies no workflow cost/duration cap. Permission, concurrency, verification and repair-count constraints remain enforced.

The loop detector requires at least 12 repeated results without new evidence and a repeating sequence of one to four operations. It compares normalized tool inputs and results, ignores call IDs, and does not classify a broad second read pass as a loop. Stop records contain the reason, inactivity duration, repetition count and recent fingerprints. This is a conservative suspected-loop heuristic, not proof or complete detection of every loop. A watchdog-stopped review is not automatically retried. Transport/process errors and failed acceptance remain separate failures; the existing deterministic acceptance command keeps its own 120-second infrastructure timeout.

Offline regression covers progressing one-hour Worker runs, costs above $2, normal read-only work beyond profile turn caps, actual plan dispatch, review stop without retry, repeated-result loops, 30-minute inactivity and resource release. RPC idle waits can omit a total deadline while still rejecting promptly on process exit. Root and launcher TypeScript checks must pass before sealing. Do not launch the old fixed-limit driver under this protocol.

Validation (2026-09-10, no paid calls): 83 tests passed across 10 focused files, including Faux Provider direct execution/repair and in-process sessions, plan dispatch, RPC process exit, tool boundaries and cost accounting. Root `tsgo --noEmit`, launcher type checking with `.artifacts/live-controls-watchdog-check/tsconfig.json`, and launcher syntax checking passed. The full `npm run check` remains blocked by the previously deferred Biome configuration; it is not recorded as passing. These are offline framework checks, not new delivery or cost-comparison results.

Common acceptance is the original 59 backend tests and five browser scenarios, plus the two tests in acceptance/test_lifecycle_delivery.py. All three arms receive identical read-only acceptance inputs before execution. The additions enforce existing requirements:

1. After an open session becomes closed, failed resumption must not consume queued gifts.
2. Ending during an in-flight state poll must leave the dashboard cleared and must not dispatch queued registration after stopping. Both waiting for in-flight work and invalidating old callbacks are acceptable.

Reviewer evidence must use workspace-relative changedFiles paths and positive line numbers. The framework resolves a shortened path only when it uniquely matches a changed file; unresolved/ambiguous paths are infrastructure failures, not user scope questions, and must not authorize business repair. No automatic extra model call is added for path normalization. Reviewers must demonstrate reachable behavior for blockers; hypothetical injected state is not enough.

Original trial results and its frozen framework remain immutable. New acceptance cannot retroactively change old automatic outcomes. The offline replay matrix is sol 2/2, luna 0/2, terra 1/2; these are diagnostic checks, not new paid trials.

Before any paid run, create a separate full framework snapshot and three fresh workspaces. Install the additional common test beside the original backend tests in each NEW workspace before sealing manifests, so the existing unittest discovery and reviewer log transfer include all 61 tests. Verify all protected-input hashes match across arms and use this revised framework for all arms. Existing paid workspaces must never be used as setup targets. Do not run the old frozen paid launcher unchanged.

Preparation limitation: npm run check is blocked by the pre-existing nested Biome root under .artifacts/window-stage1-validation. This must be recorded, not silently treated as passing. This document freezes evaluation rules; a new executable full-framework snapshot is a separate prerequisite to the next paid trial.
