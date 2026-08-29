# Pi Windows Agent

Windows-first experimental fork of [Pi](https://github.com/earendil-works/pi) focused on governed coding workflows, multi-agent execution, deterministic verification, and recovery.

> **Status:** Beta. Developed and tested primarily on Windows 11 with PowerShell. This is a secondary-development project based on Pi, not an independently implemented agent framework.

This fork reuses Pi's provider abstraction, Agent Loop, tool calling, sessions, extensions, and terminal UI. Its main additions are:

- Direct, Plan, and automatic workflow selection with approval-backed plans and persistent task graphs.
- Governed Subagent and background Job runtimes with inherited permissions, budgets, structured handoffs, and single-writer enforcement.
- Delivery verification, bounded repair, recovery, and unified Interactive, Print, JSON, and RPC workflow output.
- Role-aware model routing across fast, balanced, and strong model tiers.

[Architecture](docs/cli-agent-architecture.md) | [Offline showcase](docs/cli-agent-showcase.md) | [Coding agent documentation](packages/coding-agent/README.md)

## Windows quick start

Requires Node.js 22.19 or newer.

```powershell
npm install --ignore-scripts
.\pi-test.ps1
```

Run the deterministic showcase without an API key:

```powershell
npm run demo:cli-agent-showcase
```

## Code map

| Area | Entry point |
|---|---|
| Workflow state, planning, scheduling, and recovery | [`packages/coding-agent/src/core/workflow`](packages/coding-agent/src/core/workflow) |
| Governed Subagent and team execution | [`packages/coding-agent/src/core/subagents`](packages/coding-agent/src/core/subagents) |
| Background process lifecycle | [`packages/coding-agent/src/core/jobs`](packages/coding-agent/src/core/jobs) |
| Diff, review, verification, and bounded repair | [`packages/coding-agent/src/core/delivery`](packages/coding-agent/src/core/delivery) |
| AgentSession integration | [`agent-session.ts`](packages/coding-agent/src/core/agent-session.ts) |
| Representative CLI regression test | [`workflow-direct.test.ts`](packages/coding-agent/test/suite/workflow-direct.test.ts) |

## Current limitations

- The fork is currently distributed from source; a signed Windows installer is not yet available.
- Windows 11 and PowerShell are the primary development targets. Other platforms retain upstream support but are not the focus of this fork.
- Upstream release and package-publishing workflows are not used for this personal fork.

## Development

```powershell
npm run check
Set-Location packages/coding-agent
node ../../node_modules/vitest/dist/cli.js --run test/suite/workflow-direct.test.ts
```

## Security

The agent runs with the filesystem, process, network, and credential permissions of its host process. Use a dedicated worktree, container, or sandbox for untrusted tasks. See the retained [containerization guide](packages/coding-agent/docs/containerization.md) and [security policy](SECURITY.md).

## Upstream and license

This project is a fork of [earendil-works/pi](https://github.com/earendil-works/pi) and retains Pi's provider abstraction, Agent Loop, sessions, extensions, terminal UI, package structure, and original history. The workflow, orchestration, verification, recovery, model-routing, and Windows-focused product work described above are the additions of this fork.

Licensed under the [MIT License](LICENSE). Upstream documentation is available at [pi.dev](https://pi.dev/docs/latest).
