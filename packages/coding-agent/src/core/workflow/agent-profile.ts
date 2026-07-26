import type { BudgetLimit } from "./types.ts";

export const AGENT_PROFILE_ROLES = ["mode_advisor", "planner", "explorer", "worker", "reviewer"] as const;
export type AgentProfileRole = (typeof AGENT_PROFILE_ROLES)[number];

export interface AgentPermissionCeiling {
	readonly read: boolean;
	readonly write: boolean;
	readonly executeCommands: boolean;
	readonly network: boolean;
	/** Empty means the Profile adds no path restriction; parent and Workflow policies still apply. */
	readonly allowedPaths: readonly string[];
	readonly deniedPaths: readonly string[];
	/** Effective permission intersection uses this when constrained path scopes do not overlap. */
	readonly denyAllPaths?: boolean;
}

export interface AgentProfile {
	readonly name: string;
	readonly role: AgentProfileRole;
	readonly description: string;
	readonly model?: string;
	readonly systemPrompt: string;
	readonly allowedTools: readonly string[];
	readonly permissionCeiling: AgentPermissionCeiling;
	readonly defaultBudget: BudgetLimit;
}

export interface AgentProfileViolation {
	readonly code: string;
	readonly message: string;
}

const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"] as const;
const READ_ONLY_ROLES: ReadonlySet<AgentProfileRole> = new Set(["mode_advisor", "planner", "explorer", "reviewer"]);
const READ_TOOLS: ReadonlySet<string> = new Set(READ_ONLY_TOOLS);
const WRITE_TOOLS: ReadonlySet<string> = new Set(["edit", "write"]);

const READ_ONLY_PERMISSION_CEILING: AgentPermissionCeiling = {
	read: true,
	write: false,
	executeCommands: false,
	network: false,
	allowedPaths: [],
	deniedPaths: [],
};

const ISOLATED_ROLE_BUDGET: BudgetLimit = {
	maxConcurrentAgents: 0,
	maxConcurrentJobs: 0,
	maxAgentDepth: 0,
	maxRetries: 1,
};

export const BUILTIN_AGENT_PROFILES: Readonly<Record<AgentProfileRole, AgentProfile>> = {
	mode_advisor: {
		name: "mode-advisor",
		role: "mode_advisor",
		description: "Assesses request complexity, risk, confidence, and execution mode",
		systemPrompt:
			"Assess the supplied request and context. Return only the structured mode assessment requested by the caller. Do not execute or modify the project.",
		allowedTools: [],
		permissionCeiling: READ_ONLY_PERMISSION_CEILING,
		defaultBudget: {
			...ISOLATED_ROLE_BUDGET,
			maxTurns: 1,
			maxDurationMs: 60_000,
		},
	},
	planner: {
		name: "planner",
		role: "planner",
		description: "Creates a concrete, risk-aware implementation and verification plan",
		systemPrompt:
			"Analyze requirements and repository context, then produce a structured implementation plan. Do not modify files or execute commands.",
		allowedTools: READ_ONLY_TOOLS,
		permissionCeiling: READ_ONLY_PERMISSION_CEILING,
		defaultBudget: {
			...ISOLATED_ROLE_BUDGET,
			maxTurns: 8,
			maxDurationMs: 300_000,
		},
	},
	explorer: {
		name: "explorer",
		role: "explorer",
		description: "Investigates repository structure and returns evidence-backed findings",
		systemPrompt:
			"Inspect the repository with read-only tools and return concise findings with exact file locations. Do not modify files or execute commands.",
		allowedTools: READ_ONLY_TOOLS,
		permissionCeiling: READ_ONLY_PERMISSION_CEILING,
		defaultBudget: {
			...ISOLATED_ROLE_BUDGET,
			maxTurns: 10,
			maxDurationMs: 300_000,
		},
	},
	worker: {
		name: "worker",
		role: "worker",
		description: "Implements an assigned Task within inherited permissions and budget",
		systemPrompt:
			"Execute only the assigned Task. Respect inherited permissions and budget, verify changes, and return a structured handoff.",
		allowedTools: ["read", "grep", "find", "ls", "bash", "edit", "write"],
		permissionCeiling: {
			read: true,
			write: true,
			executeCommands: true,
			network: false,
			allowedPaths: [],
			deniedPaths: [],
		},
		defaultBudget: {
			...ISOLATED_ROLE_BUDGET,
			maxTurns: 24,
			maxDurationMs: 900_000,
			maxRetries: 2,
		},
	},
	reviewer: {
		name: "reviewer",
		role: "reviewer",
		description: "Reviews supplied changes for correctness, safety, and maintainability",
		systemPrompt:
			"Review the supplied diff and repository context. Report evidence-backed findings with file locations. Do not modify files or execute commands.",
		allowedTools: READ_ONLY_TOOLS,
		permissionCeiling: READ_ONLY_PERMISSION_CEILING,
		defaultBudget: {
			...ISOLATED_ROLE_BUDGET,
			maxTurns: 8,
			maxDurationMs: 300_000,
		},
	},
};

export function validateAgentProfile(profile: AgentProfile): readonly AgentProfileViolation[] {
	const violations: AgentProfileViolation[] = [];
	const name = profile.name.trim();
	if (!name) {
		violations.push({ code: "agent_profile.name_required", message: "Agent Profile name is required" });
	} else if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
		violations.push({
			code: "agent_profile.invalid_name",
			message: "Agent Profile name must use lowercase kebab-case",
		});
	}
	if (!profile.description.trim()) {
		violations.push({
			code: "agent_profile.description_required",
			message: "Agent Profile description is required",
		});
	}
	if (!profile.systemPrompt.trim()) {
		violations.push({
			code: "agent_profile.prompt_required",
			message: "Agent Profile system prompt is required",
		});
	}

	const tools = profile.allowedTools.map((tool) => tool.trim());
	if (tools.some((tool) => !tool)) {
		violations.push({
			code: "agent_profile.invalid_tool",
			message: "Agent Profile tool names must be non-empty",
		});
	}
	if (new Set(tools).size !== tools.length) {
		violations.push({
			code: "agent_profile.duplicate_tool",
			message: "Agent Profile tools must be unique",
		});
	}
	if (!profile.permissionCeiling.read && tools.some((tool) => READ_TOOLS.has(tool))) {
		violations.push({
			code: "agent_profile.read_tool_denied",
			message: "Read tools exceed the Agent Profile permission ceiling",
		});
	}
	if (!profile.permissionCeiling.write && tools.some((tool) => WRITE_TOOLS.has(tool))) {
		violations.push({
			code: "agent_profile.write_tool_denied",
			message: "Write tools exceed the Agent Profile permission ceiling",
		});
	}
	if (!profile.permissionCeiling.executeCommands && tools.includes("bash")) {
		violations.push({
			code: "agent_profile.command_tool_denied",
			message: "The bash tool exceeds the Agent Profile permission ceiling",
		});
	}
	if (
		READ_ONLY_ROLES.has(profile.role) &&
		(profile.permissionCeiling.write ||
			profile.permissionCeiling.executeCommands ||
			profile.permissionCeiling.network)
	) {
		violations.push({
			code: "agent_profile.read_only_role",
			message: `${profile.role} must remain read-only and offline`,
		});
	}

	const budgetValues = Object.values(profile.defaultBudget);
	if (budgetValues.some((value) => value !== undefined && (!Number.isFinite(value) || value < 0))) {
		violations.push({
			code: "agent_profile.invalid_budget",
			message: "Agent Profile budget values must be non-negative numbers",
		});
	}
	return violations;
}
