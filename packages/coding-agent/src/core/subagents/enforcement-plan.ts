import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type { PermissionSet } from "../workflow/runtime-policy.ts";
import type { AgentBackend, AgentWorkspace } from "./types.ts";

export const ENFORCEMENT_MODES = ["best-effort", "strict"] as const;
export type EnforcementMode = (typeof ENFORCEMENT_MODES)[number];

export const SANDBOX_ASSURANCE_LEVELS = ["tool-guarded", "process-restricted", "sandboxed"] as const;
export type SandboxAssuranceLevel = (typeof SANDBOX_ASSURANCE_LEVELS)[number];
export const SUBAGENT_PATH_POLICY_ENV = "PI_SUBAGENT_PATH_POLICY";
export const SUBAGENT_ASSURANCE_ENV = "PI_SUBAGENT_ASSURANCE";

export interface AgentEnforcementPlan {
	readonly schemaVersion: 1;
	readonly mode: EnforcementMode;
	readonly filesystem: {
		readonly readableRoots: readonly string[];
		readonly writableRoots: readonly string[];
		readonly deniedRoots: readonly string[];
		readonly denyAll: boolean;
	};
	readonly environment: {
		readonly allowedKeys: readonly string[];
		readonly providerKeys: readonly string[];
	};
	readonly commands: {
		readonly enabled: boolean;
		readonly workingDirectory: string;
	};
	readonly network: {
		readonly enabled: boolean;
		readonly allowedHosts: readonly string[];
	};
	readonly digest: string;
}

export interface SandboxVerification {
	readonly assurance: SandboxAssuranceLevel;
	readonly mode: EnforcementMode;
	readonly enforced: readonly string[];
	readonly missingGuarantees: readonly string[];
	readonly platform: NodeJS.Platform;
	readonly planDigest: string;
}

export interface CompileAgentEnforcementPlanInput {
	readonly mode: EnforcementMode;
	readonly backend: AgentBackend;
	readonly workspace: AgentWorkspace;
	readonly permissions: PermissionSet;
	readonly providerEnvironmentKeys?: readonly string[];
}

function stableValues(values: readonly string[]): readonly string[] {
	return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}

function resolvedRoots(paths: readonly string[], workspacePath: string): readonly string[] {
	return stableValues(paths.map((path) => resolve(workspacePath, path)));
}

function digestPlan(plan: Omit<AgentEnforcementPlan, "digest">): string {
	return createHash("sha256").update(JSON.stringify(plan)).digest("hex");
}

export function compileAgentEnforcementPlan(input: CompileAgentEnforcementPlanInput): AgentEnforcementPlan {
	const explicitRoots = resolvedRoots(input.permissions.allowedPaths, input.workspace.path);
	const readableRoots = input.permissions.read
		? explicitRoots.length > 0
			? explicitRoots
			: [resolve(input.workspace.path)]
		: [];
	const writableRoots = input.permissions.write
		? explicitRoots.length > 0
			? explicitRoots
			: [resolve(input.workspace.path)]
		: [];
	const plan: Omit<AgentEnforcementPlan, "digest"> = {
		schemaVersion: 1,
		mode: input.mode,
		filesystem: {
			readableRoots,
			writableRoots,
			deniedRoots: resolvedRoots(input.permissions.deniedPaths, input.workspace.path),
			denyAll: Boolean(input.permissions.denyAllPaths),
		},
		environment: {
			allowedKeys: [],
			providerKeys: stableValues(input.providerEnvironmentKeys ?? []),
		},
		commands: {
			enabled: input.permissions.executeCommands,
			workingDirectory: resolve(input.workspace.path),
		},
		network: {
			enabled: input.permissions.network,
			allowedHosts: [],
		},
	};
	return { ...plan, digest: digestPlan(plan) };
}

export function parseEnforcementMode(value: string | undefined): EnforcementMode {
	return value === "strict" ? "strict" : "best-effort";
}
