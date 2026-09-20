# Security Policy

## Project scope

CodeRelay Agent is a personal, Windows-focused fork of
[earendil-works/pi](https://github.com/earendil-works/pi). This policy covers
security issues introduced by this fork's workflow, subagent, job, delivery,
recovery, model-routing, and Windows integration changes.

Issues that also reproduce on upstream Pi should be reported through the
[upstream security policy](https://github.com/earendil-works/pi/security/policy).

## Security model

The agent runs with the filesystem, process, network, and credential permissions
of the user who starts it. It is not a security sandbox.

- Run it only in repositories and worktrees you trust.
- Review commands and permission-expansion requests before approving them.
- Use a dedicated worktree, virtual machine, container, or external sandbox for
  untrusted code.
- Treat project instructions, extensions, skills, shell configuration, and local
  agent configuration as trusted inputs.
- Do not include API keys, access tokens, private source code, or personal data in
  reports or logs.

The fork's permission inheritance, read-only roles, budgets, single-writer lease,
bounded repair, and cancellation controls reduce accidental workflow damage. They
do not create an operating-system security boundary.

## Reporting a vulnerability

Do not open a public issue for a vulnerability that affects this fork.

Use GitHub's private vulnerability reporting for
[`qingyingxy/coderelay-agent`](https://github.com/qingyingxy/coderelay-agent/security/advisories/new).
Include:

- affected commit and Windows version;
- a concise description of the impact;
- minimal reproduction steps or a proof of concept;
- the affected workflow, package, or command;
- relevant logs with credentials and personal data removed.

## In scope

- A privilege or permission boundary bypass introduced by this fork.
- Incorrect permission or budget inheritance between workflows and subagents.
- Writer-lease failures that permit unintended concurrent workspace mutation.
- Cancellation or recovery behavior that executes work after it should stop.
- Credential disclosure caused by fork-specific logging or workflow output.

## Out of scope

- Expected command execution explicitly approved by the user.
- Prompt injection or malicious instructions in an already trusted repository.
- Behavior from untrusted third-party extensions, skills, models, or tools.
- Issues requiring prior write access to the user's workspace, home directory,
  shell startup files, or Pi configuration.
- Resource exhaustion caused by intentionally unsafe local configuration.
- Vulnerabilities that reproduce unchanged on upstream Pi.
