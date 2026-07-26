import { describe, expect, it } from "vitest";
import {
	assertBudgetAvailable,
	evaluateBudget,
	FULL_PERMISSION_SET,
	filterToolsByPermissions,
	inheritBudgetLimits,
	intersectPermissions,
	permissionAllowsPath,
	RuntimePolicyError,
	resolveEffectivePermissions,
} from "../../src/core/workflow/index.ts";
import { ZERO_USAGE } from "./fixtures.ts";

describe("Runtime policy", () => {
	it("intersects parent, Profile, Workflow, and Task permissions without escalation", () => {
		const readOnly = {
			...FULL_PERMISSION_SET,
			write: false,
			executeCommands: false,
			network: false,
			allowedPaths: ["src"],
		};
		const effective = resolveEffectivePermissions({
			parent: { ...FULL_PERMISSION_SET, deniedPaths: ["src/secrets"] },
			profile: readOnly,
			workflow: { ...FULL_PERMISSION_SET, allowedPaths: ["src/core"] },
			task: FULL_PERMISSION_SET,
		});

		expect(effective).toMatchObject({
			read: true,
			write: false,
			executeCommands: false,
			network: false,
			allowedPaths: ["src/core"],
			deniedPaths: ["src/secrets"],
		});
		expect(filterToolsByPermissions(["read", "bash", "edit", "write"], effective)).toEqual(["read"]);
		expect(permissionAllowsPath(effective, "src/core/workflow.ts")).toBe(true);
		expect(permissionAllowsPath(effective, "src/secrets/key.ts")).toBe(false);
		expect(permissionAllowsPath(effective, "test/example.test.ts")).toBe(false);
	});

	it("uses the narrowest path scope and budget at every layer", () => {
		expect(
			intersectPermissions(
				{ ...FULL_PERMISSION_SET, allowedPaths: ["src"] },
				{ ...FULL_PERMISSION_SET, allowedPaths: ["src/core", "test"] },
			).allowedPaths,
		).toEqual(["src/core"]);
		const disjoint = intersectPermissions(
			{ ...FULL_PERMISSION_SET, allowedPaths: ["src"] },
			{ ...FULL_PERMISSION_SET, allowedPaths: ["test"] },
		);
		expect(disjoint.denyAllPaths).toBe(true);
		expect(permissionAllowsPath(disjoint, "src/index.ts")).toBe(false);
		expect(permissionAllowsPath(disjoint, "test/index.test.ts")).toBe(false);
		expect(
			inheritBudgetLimits(
				{ maxTurns: 20, maxCost: 5, maxConcurrentAgents: 4 },
				{ maxTurns: 8, maxCost: 10, maxRetries: 2 },
			),
		).toEqual({
			maxCost: 5,
			maxTurns: 8,
			maxConcurrentAgents: 4,
			maxRetries: 2,
		});
	});

	it("reports soft warnings and rejects hard resource or capacity limits", () => {
		const warning = evaluateBudget(
			{ maxInputTokens: 100, maxConcurrentAgents: 2 },
			{ ...ZERO_USAGE, inputTokens: 80 },
			{ activeAgents: 2 },
		);
		expect(warning.warnings.map(({ dimension }) => dimension)).toEqual(["maxInputTokens", "maxConcurrentAgents"]);
		expect(warning.exceeded).toEqual([]);

		expect(() =>
			assertBudgetAvailable(
				{ maxInputTokens: 100, maxConcurrentAgents: 2 },
				{ ...ZERO_USAGE, inputTokens: 100 },
				{ activeAgents: 3 },
			),
		).toThrow(RuntimePolicyError);
	});
});
