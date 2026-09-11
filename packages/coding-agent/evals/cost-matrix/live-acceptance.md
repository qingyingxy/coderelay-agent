# Live pagination acceptance

Implement server-side pagination for the free, ordinary and paid queues and revision-based state polling, using the existing project API and UI.

- The first state fetch returns a full snapshot. A matching `since` revision returns `unchanged: true` with the same revision and current `uptimeSeconds`.
- An unchanged response updates uptime while preserving all other dashboard fields. Revision and uptime are different fields.
- Each queue requests and displays the selected server page. A late response for an older page cannot replace the newer selected page.
- Common acceptance: six backend pagination cases, the existing 59 backend regression cases, and five browser scenarios (three queues, unchanged polling, out-of-order pages).
- Read tests and configuration as needed. Modify related business source only. Do not modify tests, dependencies, configuration, or unrelated projects.

The host executes tests and read-only review, then allows at most one bounded repair and repeats both checks. Mandatory review findings must identify a concrete violation of this task or a regression introduced by the patch. Optional hardening outside this scope does not block delivery. Passing tests does not by itself prove that all task requirements are met.
