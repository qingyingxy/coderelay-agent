# Contributing to CodeRelay Agent

CodeRelay Agent is a personal, Windows-focused experimental fork of
[earendil-works/pi](https://github.com/earendil-works/pi). Contributions are
welcome when they are focused on the fork's workflow orchestration, subagent and
job runtimes, delivery verification, recovery, model routing, or Windows
experience.

The upstream Pi contributor approval gate does not apply to this repository.
Issues and pull requests are reviewed as maintainer time permits.

## Before opening an issue

- Search existing issues first.
- Include the commit SHA, Windows version, PowerShell version, and Node.js version.
- Provide minimal reproduction steps, expected behavior, and actual behavior.
- Include only the relevant logs and remove credentials, private code, and
  personal data.
- Report security issues privately according to [SECURITY.md](SECURITY.md).

If the behavior reproduces on upstream Pi without this fork's changes, report it
to [earendil-works/pi](https://github.com/earendil-works/pi/issues) instead.

## Before opening a pull request

- Base the change on the `windows-agent` branch.
- Keep the change focused and explain why it belongs in this fork rather than
  upstream Pi.
- Follow [AGENTS.md](AGENTS.md) and the existing TypeScript style.
- Add or update focused tests for behavior that changes.
- Do not include API keys, generated evaluation datasets, local artifacts, or
  unrelated formatting changes.

Run the repository checks:

```powershell
npm install --ignore-scripts
npm run check
Set-Location packages/coding-agent
node ../../node_modules/vitest/dist/cli.js --run test/suite/workflow-direct.test.ts
```

For workflow changes, also run the deterministic offline showcase from the
repository root:

```powershell
npm run demo:cli-agent-showcase
```

## AI-assisted contributions

AI assistance is acceptable, but the contributor is responsible for understanding
the implementation, reviewing the generated diff, running the relevant checks,
and explaining the design tradeoffs.
