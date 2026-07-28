import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentProfileLoader } from "../../src/index.ts";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), "pi-agent-profiles-"));
	temporaryDirectories.push(directory);
	return directory;
}

function writeProfile(directory: string, name: string, content: string): string {
	mkdirSync(directory, { recursive: true });
	const path = join(directory, `${name}.md`);
	writeFileSync(path, content);
	return path;
}

function profileContent(description: string, extra = ""): string {
	return `---
description: ${description}
role: explorer
tools: read, grep
thinking: high
run_in_background: true
permission:
  read: true
  write: false
  execute_commands: false
  network: false
budget:
  max_turns: 4
${extra}---
Inspect only the assigned scope and return evidence.
`;
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("AgentProfileLoader", () => {
	it("loads built-in, global, and project profiles with project precedence", () => {
		const root = temporaryDirectory();
		const cwd = join(root, "project");
		const agentDir = join(root, "agent");
		writeProfile(join(agentDir, "agents"), "audit", profileContent("Global audit"));
		const projectPath = writeProfile(join(cwd, ".pi", "agents"), "audit", profileContent("Project audit"));

		const loaded = new AgentProfileLoader({ cwd, agentDir }).require("audit");

		expect(loaded).toMatchObject({
			source: "project",
			sourcePath: projectPath,
			runInBackground: true,
			inheritContext: false,
			profile: {
				name: "audit",
				role: "explorer",
				description: "Project audit",
				thinkingLevel: "high",
				allowedTools: ["read", "grep"],
				defaultBudget: {
					maxTurns: 4,
				},
			},
		});
		expect(new AgentProfileLoader({ cwd, agentDir }).require("worker").source).toBe("builtin");
	});

	it("does not silently fall back when a project override is invalid", () => {
		const root = temporaryDirectory();
		const cwd = join(root, "project");
		const agentDir = join(root, "agent");
		writeProfile(join(agentDir, "agents"), "audit", profileContent("Global audit"));
		writeProfile(
			join(cwd, ".pi", "agents"),
			"audit",
			`---
description: Invalid project audit
role: explorer
permission:
  write: true
---
Inspect the project.
`,
		);

		expect(() => new AgentProfileLoader({ cwd, agentDir }).require("audit")).toThrowError(
			expect.objectContaining({ code: "agent_profile.permission_escalation" }),
		);
	});

	it("rejects profile budgets that expand the built-in role limit", () => {
		const root = temporaryDirectory();
		const cwd = join(root, "project");
		const agentDir = join(root, "agent");
		writeProfile(join(cwd, ".pi", "agents"), "audit", profileContent("Project audit", "  max_duration_ms: 600000\n"));

		expect(() => new AgentProfileLoader({ cwd, agentDir }).load()).toThrowError(
			expect.objectContaining({ code: "agent_profile.budget_escalation" }),
		);
	});

	it("rejects unknown fields instead of ignoring misspelled safety settings", () => {
		const root = temporaryDirectory();
		const cwd = join(root, "project");
		const agentDir = join(root, "agent");
		writeProfile(
			join(cwd, ".pi", "agents"),
			"audit",
			`---
description: Project audit
role: explorer
permissions:
  write: false
---
Inspect the project.
`,
		);

		expect(() => new AgentProfileLoader({ cwd, agentDir }).load()).toThrowError(
			expect.objectContaining({ code: "agent_profile.unknown_field" }),
		);
	});
});
