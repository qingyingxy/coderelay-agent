import { randomUUID } from "node:crypto";
import { findEnvKeys } from "@earendil-works/pi-ai/compat";
import {
	type AgentEnforcementPlan,
	type SandboxAssuranceLevel,
	type SandboxVerification,
	SUBAGENT_ASSURANCE_ENV,
	SUBAGENT_PATH_POLICY_ENV,
} from "./enforcement-plan.ts";
import type { AgentBackend } from "./types.ts";

const BASE_ENVIRONMENT_KEYS = [
	"APPDATA",
	"COMSPEC",
	"HOME",
	"HOMEDRIVE",
	"HOMEPATH",
	"HTTPS_PROXY",
	"HTTP_PROXY",
	"LANG",
	"LC_ALL",
	"LOCALAPPDATA",
	"NODE_EXTRA_CA_CERTS",
	"NO_PROXY",
	"PATH",
	"PATHEXT",
	"PI_CODING_AGENT_DIR",
	"PI_OFFLINE",
	"PI_PACKAGE_DIR",
	"PROGRAMDATA",
	"SHELL",
	"SSL_CERT_FILE",
	"SYSTEMROOT",
	"TEMP",
	"TERM",
	"TMP",
	"TMPDIR",
	"USERPROFILE",
	"WINDIR",
] as const;

export interface SandboxPrepareRequest {
	readonly agentId: string;
	readonly backend: AgentBackend;
	readonly plan: AgentEnforcementPlan;
}

export interface SandboxHandle {
	readonly id: string;
	readonly environment: Readonly<Record<string, string>>;
	readonly verification: SandboxVerification;
}

export interface SandboxBackend {
	prepare(request: SandboxPrepareRequest): Promise<SandboxHandle>;
	verify(handle: SandboxHandle): Promise<SandboxVerification>;
	release(handle: SandboxHandle): Promise<void>;
}

export class SandboxPolicyError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "SandboxPolicyError";
		this.code = code;
	}
}

export function providerEnvironmentKeys(modelName: string | undefined): readonly string[] {
	const separator = modelName?.indexOf("/") ?? -1;
	if (!modelName || separator < 1) {
		return [];
	}
	return findEnvKeys(modelName.slice(0, separator)) ?? [];
}

function copyEnvironment(keys: readonly string[]): Record<string, string> {
	const environment: Record<string, string> = {};
	for (const key of keys) {
		const value = process.env[key];
		if (value !== undefined) {
			environment[key] = value;
		}
	}
	return environment;
}

function assuranceFor(backend: AgentBackend): SandboxAssuranceLevel {
	return backend === "rpc" ? "process-restricted" : "tool-guarded";
}

function missingGuarantees(plan: AgentEnforcementPlan, backend: AgentBackend): readonly string[] {
	const missing: string[] = [];
	if (backend === "in-process") {
		missing.push("in-process session shares the parent environment, memory, and filesystem");
	}
	if (plan.commands.enabled) {
		missing.push("command child processes are not filesystem-sandboxed");
	}
	if (plan.network.enabled) {
		missing.push("network destinations are not restricted");
	}
	return missing;
}

function enforcedGuarantees(plan: AgentEnforcementPlan, backend: AgentBackend): readonly string[] {
	const enforced = ["tool allowlist"];
	if (backend === "rpc") {
		enforced.push(
			"environment allowlist",
			"RPC process boundary",
			"process tree cleanup",
			"filesystem tool path guard",
		);
	}
	if (plan.filesystem.writableRoots.length > 0) {
		enforced.push("write roots");
	}
	if (plan.filesystem.denyAll) {
		enforced.push("deny all filesystem paths");
	}
	return enforced;
}

/**
 * Baseline enforcement available without an external container runtime.
 *
 * It provides a minimal environment, tool path policy and process boundary.
 * It deliberately reports command/network limitations instead of claiming a
 * complete operating-system sandbox.
 */
export class BaselineSandboxBackend implements SandboxBackend {
	async prepare(request: SandboxPrepareRequest): Promise<SandboxHandle> {
		const assurance = assuranceFor(request.backend);
		const missing = missingGuarantees(request.plan, request.backend);
		if (request.plan.mode === "strict" && missing.length > 0) {
			throw new SandboxPolicyError(
				"sandbox.strict_guarantee_unavailable",
				`Strict Subagent enforcement is unavailable: ${missing.join("; ")}`,
			);
		}
		const environment = copyEnvironment([
			...BASE_ENVIRONMENT_KEYS,
			...request.plan.environment.allowedKeys,
			...request.plan.environment.providerKeys,
		]);
		environment[SUBAGENT_PATH_POLICY_ENV] = JSON.stringify({
			readableRoots: request.plan.filesystem.readableRoots,
			writableRoots: request.plan.filesystem.writableRoots,
			deniedRoots: request.plan.filesystem.deniedRoots,
			denyAll: request.plan.filesystem.denyAll,
		});
		environment[SUBAGENT_ASSURANCE_ENV] = assurance;
		const verification: SandboxVerification = {
			assurance,
			mode: request.plan.mode,
			enforced: enforcedGuarantees(request.plan, request.backend),
			missingGuarantees: missing,
			platform: process.platform,
			planDigest: request.plan.digest,
		};
		return {
			id: `sandbox-${request.agentId}-${randomUUID()}`,
			environment,
			verification,
		};
	}

	async verify(handle: SandboxHandle): Promise<SandboxVerification> {
		return structuredClone(handle.verification);
	}

	async release(_handle: SandboxHandle): Promise<void> {}
}
