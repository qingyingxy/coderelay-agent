import { describe, expect, it } from "vitest";
import {
	AGENT_PROFILE_ROLES,
	type AgentProfile,
	BUILTIN_AGENT_PROFILES,
	validateAgentProfile,
} from "../../src/core/workflow/agent-profile.ts";

describe("Agent Profiles", () => {
	it("defines one valid built-in Profile for every workflow role", () => {
		expect(Object.keys(BUILTIN_AGENT_PROFILES)).toEqual(AGENT_PROFILE_ROLES);
		for (const role of AGENT_PROFILE_ROLES) {
			const profile = BUILTIN_AGENT_PROFILES[role];
			expect(profile.role).toBe(role);
			expect(validateAgentProfile(profile)).toEqual([]);
		}
	});

	it("keeps advisory, planning, exploration, and review roles read-only", () => {
		for (const role of ["mode_advisor", "planner", "explorer", "reviewer"] as const) {
			const profile = BUILTIN_AGENT_PROFILES[role];
			expect(profile.permissionCeiling).toMatchObject({
				write: false,
				executeCommands: false,
				network: false,
			});
			expect(profile.allowedTools).not.toContain("bash");
			expect(profile.allowedTools).not.toContain("edit");
			expect(profile.allowedTools).not.toContain("write");
		}
	});

	it("gives only the Worker the default write and command ceiling", () => {
		const worker = BUILTIN_AGENT_PROFILES.worker;
		expect(worker.systemPrompt).toContain("non-empty conclusion");
		expect(worker.systemPrompt).toContain("verificationSummary result");
		expect(worker.systemPrompt).toContain("do not leave temporary verification scripts");
		expect(worker.permissionCeiling).toMatchObject({
			read: true,
			write: true,
			executeCommands: true,
			network: false,
		});
		expect(worker.allowedTools).toEqual(["read", "grep", "find", "ls", "bash", "edit", "write"]);
		expect(worker.defaultBudget.maxRetries).toBe(1);
		expect(worker.defaultBudget.maxTurns).toBe(48);
	});

	it("bounds the delivery Reviewer to one short stage", () => {
		expect(BUILTIN_AGENT_PROFILES.reviewer.defaultBudget).toMatchObject({
			maxTurns: 12,
			maxDurationMs: 150_000,
			maxRetries: 1,
		});
	});

	it("rejects tools that exceed a Profile permission ceiling", () => {
		const invalid: AgentProfile = {
			...BUILTIN_AGENT_PROFILES.planner,
			allowedTools: [...BUILTIN_AGENT_PROFILES.planner.allowedTools, "bash", "write"],
		};

		expect(validateAgentProfile(invalid).map(({ code }) => code)).toEqual([
			"agent_profile.write_tool_denied",
			"agent_profile.command_tool_denied",
		]);
	});

	it("rejects unsafe read-only roles and malformed configuration", () => {
		const invalid: AgentProfile = {
			...BUILTIN_AGENT_PROFILES.reviewer,
			name: "Invalid Reviewer",
			description: " ",
			allowedTools: ["read", "read"],
			permissionCeiling: {
				...BUILTIN_AGENT_PROFILES.reviewer.permissionCeiling,
				write: true,
			},
			defaultBudget: {
				maxTurns: -1,
			},
		};

		expect(validateAgentProfile(invalid).map(({ code }) => code)).toEqual([
			"agent_profile.invalid_name",
			"agent_profile.description_required",
			"agent_profile.duplicate_tool",
			"agent_profile.read_only_role",
			"agent_profile.invalid_budget",
		]);
	});
});
