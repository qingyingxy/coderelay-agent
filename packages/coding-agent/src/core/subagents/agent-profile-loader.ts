import type { Dirent } from "node:fs";
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { parseFrontmatter } from "../../utils/frontmatter.ts";
import {
	AGENT_PROFILE_ROLES,
	type AgentPermissionCeiling,
	type AgentProfile,
	type AgentProfileRole,
	BUILTIN_AGENT_PROFILES,
	validateAgentProfile,
} from "../workflow/agent-profile.ts";
import type { BudgetLimit } from "../workflow/types.ts";

export const AGENT_PROFILE_SOURCES = ["builtin", "global", "project"] as const;
export type AgentProfileSource = (typeof AGENT_PROFILE_SOURCES)[number];

export interface LoadedAgentProfile {
	readonly profile: AgentProfile;
	readonly source: AgentProfileSource;
	readonly sourcePath?: string;
	readonly runInBackground: boolean;
	readonly inheritContext: boolean;
}

export interface AgentProfileLoaderOptions {
	readonly cwd: string;
	readonly agentDir: string;
}

export class AgentProfileLoadError extends Error {
	readonly code: string;
	readonly sourcePath?: string;

	constructor(code: string, message: string, sourcePath?: string) {
		super(sourcePath ? `${message} (${sourcePath})` : message);
		this.name = "AgentProfileLoadError";
		this.code = code;
		this.sourcePath = sourcePath;
	}
}

type ProfileFrontmatter = Record<string, unknown>;

const ROOT_FIELDS = new Set([
	"description",
	"role",
	"model",
	"thinking",
	"tools",
	"run_in_background",
	"inherit_context",
	"permission",
	"budget",
]);
const PERMISSION_FIELDS = new Set(["read", "write", "execute_commands", "network", "allowed_paths", "denied_paths"]);
const BUDGET_FIELDS = new Set([
	"max_input_tokens",
	"max_output_tokens",
	"max_cost",
	"max_turns",
	"max_duration_ms",
	"max_concurrent_agents",
	"max_concurrent_jobs",
	"max_agent_depth",
	"max_retries",
]);
const THINKING_LEVELS: ReadonlySet<ThinkingLevel> = new Set([
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
]);
const KNOWN_TOOLS = new Set(["read", "grep", "find", "ls", "bash", "edit", "write"]);

const BUDGET_FIELD_MAP = {
	max_input_tokens: "maxInputTokens",
	max_output_tokens: "maxOutputTokens",
	max_cost: "maxCost",
	max_turns: "maxTurns",
	max_duration_ms: "maxDurationMs",
	max_concurrent_agents: "maxConcurrentAgents",
	max_concurrent_jobs: "maxConcurrentJobs",
	max_agent_depth: "maxAgentDepth",
	max_retries: "maxRetries",
} as const satisfies Record<string, keyof BudgetLimit>;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(frontmatter: ProfileFrontmatter, field: string, sourcePath: string): string {
	const value = frontmatter[field];
	if (typeof value !== "string" || !value.trim()) {
		throw new AgentProfileLoadError(
			"agent_profile.invalid_frontmatter",
			`Agent Profile ${field} must be a non-empty string`,
			sourcePath,
		);
	}
	return value.trim();
}

function optionalString(frontmatter: ProfileFrontmatter, field: string, sourcePath: string): string | undefined {
	const value = frontmatter[field];
	if (value === undefined) {
		return undefined;
	}
	if (typeof value !== "string" || !value.trim()) {
		throw new AgentProfileLoadError(
			"agent_profile.invalid_frontmatter",
			`Agent Profile ${field} must be a non-empty string`,
			sourcePath,
		);
	}
	return value.trim();
}

function optionalBoolean(
	frontmatter: ProfileFrontmatter,
	field: string,
	defaultValue: boolean,
	sourcePath: string,
): boolean {
	const value = frontmatter[field];
	if (value === undefined) {
		return defaultValue;
	}
	if (typeof value !== "boolean") {
		throw new AgentProfileLoadError(
			"agent_profile.invalid_frontmatter",
			`Agent Profile ${field} must be a boolean`,
			sourcePath,
		);
	}
	return value;
}

function assertKnownFields(
	value: Record<string, unknown>,
	knownFields: ReadonlySet<string>,
	section: string,
	sourcePath: string,
): void {
	const unknownFields = Object.keys(value).filter((field) => !knownFields.has(field));
	if (unknownFields.length > 0) {
		throw new AgentProfileLoadError(
			"agent_profile.unknown_field",
			`Unknown Agent Profile ${section} field${unknownFields.length === 1 ? "" : "s"}: ${unknownFields.join(", ")}`,
			sourcePath,
		);
	}
}

function parseRole(value: unknown, sourcePath: string): AgentProfileRole {
	const role = typeof value === "string" ? AGENT_PROFILE_ROLES.find((candidate) => candidate === value) : undefined;
	if (!role) {
		throw new AgentProfileLoadError(
			"agent_profile.invalid_role",
			`Agent Profile role must be one of: ${AGENT_PROFILE_ROLES.join(", ")}`,
			sourcePath,
		);
	}
	return role;
}

function parseThinkingLevel(value: unknown, sourcePath: string): ThinkingLevel | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (typeof value !== "string" || !THINKING_LEVELS.has(value as ThinkingLevel)) {
		throw new AgentProfileLoadError(
			"agent_profile.invalid_thinking",
			"Agent Profile thinking must be one of: off, minimal, low, medium, high, xhigh, max",
			sourcePath,
		);
	}
	return value as ThinkingLevel;
}

function parseTools(value: unknown, fallback: readonly string[], sourcePath: string): readonly string[] {
	if (value === undefined) {
		return [...fallback];
	}
	const tools =
		typeof value === "string"
			? value
					.split(",")
					.map((tool) => tool.trim())
					.filter(Boolean)
			: Array.isArray(value) && value.every((tool) => typeof tool === "string")
				? value.map((tool) => tool.trim()).filter(Boolean)
				: undefined;
	if (!tools || tools.length === 0) {
		throw new AgentProfileLoadError(
			"agent_profile.invalid_tools",
			"Agent Profile tools must be a comma-separated string or non-empty string array",
			sourcePath,
		);
	}
	const unknownTools = tools.filter((tool) => !KNOWN_TOOLS.has(tool));
	if (unknownTools.length > 0) {
		throw new AgentProfileLoadError(
			"agent_profile.unknown_tool",
			`Unknown Agent Profile tool${unknownTools.length === 1 ? "" : "s"}: ${unknownTools.join(", ")}`,
			sourcePath,
		);
	}
	return tools;
}

function stringArray(value: unknown, field: string, sourcePath: string): readonly string[] {
	if (value === undefined) {
		return [];
	}
	if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item.trim())) {
		throw new AgentProfileLoadError(
			"agent_profile.invalid_permission",
			`Agent Profile permission.${field} must be a string array`,
			sourcePath,
		);
	}
	return value.map((item) => item.trim());
}

function permissionBoolean(
	permission: Record<string, unknown>,
	field: string,
	fallback: boolean,
	sourcePath: string,
): boolean {
	const value = permission[field];
	if (value === undefined) {
		return fallback;
	}
	if (typeof value !== "boolean") {
		throw new AgentProfileLoadError(
			"agent_profile.invalid_permission",
			`Agent Profile permission.${field} must be a boolean`,
			sourcePath,
		);
	}
	return value;
}

function parsePermission(value: unknown, base: AgentPermissionCeiling, sourcePath: string): AgentPermissionCeiling {
	if (value === undefined) {
		return {
			...base,
			allowedPaths: [...base.allowedPaths],
			deniedPaths: [...base.deniedPaths],
		};
	}
	if (!isRecord(value)) {
		throw new AgentProfileLoadError(
			"agent_profile.invalid_permission",
			"Agent Profile permission must be an object",
			sourcePath,
		);
	}
	assertKnownFields(value, PERMISSION_FIELDS, "permission", sourcePath);
	const permission: AgentPermissionCeiling = {
		read: permissionBoolean(value, "read", base.read, sourcePath),
		write: permissionBoolean(value, "write", base.write, sourcePath),
		executeCommands: permissionBoolean(value, "execute_commands", base.executeCommands, sourcePath),
		network: permissionBoolean(value, "network", base.network, sourcePath),
		allowedPaths: stringArray(value.allowed_paths, "allowed_paths", sourcePath),
		deniedPaths: stringArray(value.denied_paths, "denied_paths", sourcePath),
	};
	if (
		(permission.read && !base.read) ||
		(permission.write && !base.write) ||
		(permission.executeCommands && !base.executeCommands) ||
		(permission.network && !base.network)
	) {
		throw new AgentProfileLoadError(
			"agent_profile.permission_escalation",
			"Agent Profile permission cannot exceed the built-in role ceiling",
			sourcePath,
		);
	}
	return permission;
}

function parseBudget(value: unknown, base: BudgetLimit, sourcePath: string): BudgetLimit {
	if (value === undefined) {
		return { ...base };
	}
	if (!isRecord(value)) {
		throw new AgentProfileLoadError(
			"agent_profile.invalid_budget",
			"Agent Profile budget must be an object",
			sourcePath,
		);
	}
	assertKnownFields(value, BUDGET_FIELDS, "budget", sourcePath);
	const budget: Record<string, number | undefined> = { ...base };
	for (const [frontmatterField, profileField] of Object.entries(BUDGET_FIELD_MAP)) {
		const candidate = value[frontmatterField];
		if (candidate === undefined) {
			continue;
		}
		if (typeof candidate !== "number" || !Number.isFinite(candidate) || candidate < 0) {
			throw new AgentProfileLoadError(
				"agent_profile.invalid_budget",
				`Agent Profile budget.${frontmatterField} must be a non-negative number`,
				sourcePath,
			);
		}
		const baseValue = base[profileField];
		if (baseValue !== undefined && candidate > baseValue) {
			throw new AgentProfileLoadError(
				"agent_profile.budget_escalation",
				`Agent Profile budget.${frontmatterField} cannot exceed the built-in role limit ${baseValue}`,
				sourcePath,
			);
		}
		budget[profileField] = candidate;
	}
	return budget;
}

function parseProfileFile(path: string, source: Exclude<AgentProfileSource, "builtin">): LoadedAgentProfile {
	const name = basename(path, ".md");
	if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
		throw new AgentProfileLoadError(
			"agent_profile.invalid_name",
			"Agent Profile filename must use lowercase kebab-case",
			path,
		);
	}
	let parsed: ReturnType<typeof parseFrontmatter>;
	try {
		parsed = parseFrontmatter(readFileSync(path, "utf8"));
	} catch (error) {
		throw new AgentProfileLoadError(
			"agent_profile.invalid_frontmatter",
			`Failed to parse Agent Profile frontmatter: ${error instanceof Error ? error.message : String(error)}`,
			path,
		);
	}
	const { frontmatter, body } = parsed;
	assertKnownFields(frontmatter, ROOT_FIELDS, "root", path);
	const role = parseRole(frontmatter.role, path);
	const base = BUILTIN_AGENT_PROFILES[role];
	const profile: AgentProfile = {
		name,
		role,
		description: requiredString(frontmatter, "description", path),
		model: optionalString(frontmatter, "model", path),
		thinkingLevel: parseThinkingLevel(frontmatter.thinking, path),
		systemPrompt: body,
		allowedTools: parseTools(frontmatter.tools, base.allowedTools, path),
		permissionCeiling: parsePermission(frontmatter.permission, base.permissionCeiling, path),
		defaultBudget: parseBudget(frontmatter.budget, base.defaultBudget, path),
	};
	const violations = validateAgentProfile(profile);
	if (violations.length > 0) {
		throw new AgentProfileLoadError(
			violations[0]?.code ?? "agent_profile.invalid",
			violations.map(({ message }) => message).join("; "),
			path,
		);
	}
	return {
		profile,
		source,
		sourcePath: path,
		runInBackground: optionalBoolean(frontmatter, "run_in_background", false, path),
		inheritContext: optionalBoolean(frontmatter, "inherit_context", false, path),
	};
}

function readProfileDirectory(
	directory: string,
	source: Exclude<AgentProfileSource, "builtin">,
): readonly LoadedAgentProfile[] {
	let entries: Dirent[];
	try {
		entries = readdirSync(directory, { withFileTypes: true });
	} catch (error) {
		const code = isRecord(error) && typeof error.code === "string" ? error.code : undefined;
		if (code === "ENOENT") {
			return [];
		}
		throw error;
	}
	return entries
		.filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
		.sort((left, right) => left.name.localeCompare(right.name))
		.map((entry) => parseProfileFile(join(directory, entry.name), source));
}

function builtinProfiles(): readonly LoadedAgentProfile[] {
	return Object.values(BUILTIN_AGENT_PROFILES).map((profile) => ({
		profile,
		source: "builtin",
		runInBackground: false,
		inheritContext: false,
	}));
}

export class AgentProfileLoader {
	readonly #options: AgentProfileLoaderOptions;

	constructor(options: AgentProfileLoaderOptions) {
		this.#options = options;
	}

	load(): readonly LoadedAgentProfile[] {
		const profiles = new Map<string, LoadedAgentProfile>();
		for (const profile of builtinProfiles()) {
			profiles.set(profile.profile.name, profile);
		}
		for (const profile of readProfileDirectory(join(this.#options.agentDir, "agents"), "global")) {
			profiles.set(profile.profile.name, profile);
		}
		for (const profile of readProfileDirectory(join(this.#options.cwd, ".pi", "agents"), "project")) {
			profiles.set(profile.profile.name, profile);
		}
		return [...profiles.values()].sort((left, right) => left.profile.name.localeCompare(right.profile.name));
	}

	get(name: string): LoadedAgentProfile | undefined {
		return this.load().find(({ profile }) => profile.name === name);
	}

	require(name: string): LoadedAgentProfile {
		const loaded = this.get(name);
		if (!loaded) {
			throw new AgentProfileLoadError("agent_profile.not_found", `Agent Profile ${name} was not found`);
		}
		return loaded;
	}
}
