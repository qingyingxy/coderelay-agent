import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "typebox";
import { defineTool, type ToolDefinition } from "../extensions/types.ts";
import type { PermissionSet } from "../workflow/runtime-policy.ts";
import type { AgentId, BudgetLimit } from "../workflow/types.ts";
import type { AgentProfileLoader, LoadedAgentProfile } from "./agent-profile-loader.ts";
import type { SubagentService } from "./subagent-service.ts";
import type { AgentBackendPolicy, AgentInstance, AgentRunResult, SpawnSubagentInput } from "./types.ts";

export interface DelegationBindingRequest {
	readonly description: string;
	readonly profile: LoadedAgentProfile;
	readonly runInBackground: boolean;
}

export type DelegationBinding = Omit<SpawnSubagentInput, "profile" | "scope" | "backend">;

export interface DelegationBindingHandle {
	readonly input: DelegationBinding;
	readonly settle?: (result: AgentRunResult | undefined, error?: unknown) => void | Promise<void>;
}

export interface SubagentToolControllerOptions {
	readonly service: SubagentService;
	readonly profiles: AgentProfileLoader;
	/**
	 * Creates or resolves the authoritative Workflow, Task, and Attempt binding.
	 * The tool adapter never invents IDs or writes Workflow state directly.
	 */
	readonly bind: (request: DelegationBindingRequest) => Promise<DelegationBindingHandle>;
	readonly inheritedContext?: () => string | undefined;
	readonly allowModelOverride?: (profile: LoadedAgentProfile, model: string) => boolean;
	readonly allowThinkingOverride?: (profile: LoadedAgentProfile, thinking: ThinkingLevel) => boolean;
}

export interface DelegateSubagentInput {
	readonly prompt: string;
	readonly description: string;
	readonly subagentType: string;
	readonly model?: string;
	readonly thinking?: ThinkingLevel;
	readonly maxTurns?: number;
	readonly runInBackground?: boolean;
	readonly inheritContext?: boolean;
	readonly backend?: AgentBackendPolicy;
}

export interface GetSubagentResultInput {
	readonly agentId: AgentId;
	readonly wait?: boolean;
	readonly verbose?: boolean;
}

export interface SteerSubagentInput {
	readonly agentId: AgentId;
	readonly message: string;
}

export interface SubagentView {
	readonly agent: AgentInstance;
	readonly status:
		| "starting"
		| "idle"
		| "running"
		| "waiting"
		| "stopping"
		| "stopped"
		| "completed"
		| "failed"
		| "interrupted";
	readonly result?: AgentRunResult;
	readonly events?: ReturnType<SubagentService["events"]>;
	readonly transcript?: ReturnType<SubagentService["getTranscript"]>;
}

export class SubagentToolError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "SubagentToolError";
		this.code = code;
	}
}

function abortedError(): Error {
	const error = new Error("Subagent tool execution was aborted");
	error.name = "AbortError";
	return error;
}

function assertNotAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) {
		throw abortedError();
	}
}

function awaitWithAbort<T>(
	promise: Promise<T>,
	signal: AbortSignal | undefined,
	onAbort: () => Promise<void>,
): Promise<T> {
	if (!signal) {
		return promise;
	}
	assertNotAborted(signal);
	return new Promise<T>((resolve, reject) => {
		let settled = false;
		const finish = (callback: () => void): void => {
			if (settled) {
				return;
			}
			settled = true;
			signal.removeEventListener("abort", abort);
			callback();
		};
		const abort = (): void => {
			void onAbort().finally(() => finish(() => reject(abortedError())));
		};
		signal.addEventListener("abort", abort, { once: true });
		promise.then(
			(value) => finish(() => resolve(value)),
			(error: unknown) => finish(() => reject(error)),
		);
	});
}

function effectiveRunInBackground(input: DelegateSubagentInput, loaded: LoadedAgentProfile): boolean {
	return input.runInBackground ?? loaded.runInBackground;
}

function effectiveInheritContext(input: DelegateSubagentInput, loaded: LoadedAgentProfile): boolean {
	return input.inheritContext ?? loaded.inheritContext;
}

function overriddenProfile(
	loaded: LoadedAgentProfile,
	input: DelegateSubagentInput,
	options: SubagentToolControllerOptions,
): LoadedAgentProfile["profile"] {
	const profile = loaded.profile;
	let model = profile.model;
	if (input.model !== undefined && input.model !== profile.model) {
		if (!options.allowModelOverride?.(loaded, input.model)) {
			throw new SubagentToolError(
				"subagent.model_override_denied",
				`Model override ${input.model} is not allowed for Agent Profile ${profile.name}`,
			);
		}
		model = input.model;
	}
	let thinkingLevel = profile.thinkingLevel;
	if (input.thinking !== undefined && input.thinking !== profile.thinkingLevel) {
		if (!options.allowThinkingOverride?.(loaded, input.thinking)) {
			throw new SubagentToolError(
				"subagent.thinking_override_denied",
				`Thinking override ${input.thinking} is not allowed for Agent Profile ${profile.name}`,
			);
		}
		thinkingLevel = input.thinking;
	}
	let defaultBudget: BudgetLimit = profile.defaultBudget;
	if (input.maxTurns !== undefined) {
		if (!Number.isInteger(input.maxTurns) || input.maxTurns < 0) {
			throw new SubagentToolError("subagent.invalid_max_turns", "max_turns must be a non-negative integer");
		}
		if (profile.defaultBudget.maxTurns !== undefined && input.maxTurns > profile.defaultBudget.maxTurns) {
			throw new SubagentToolError(
				"subagent.budget_escalation",
				`max_turns cannot exceed the Agent Profile limit ${profile.defaultBudget.maxTurns}`,
			);
		}
		defaultBudget = { ...profile.defaultBudget, maxTurns: input.maxTurns };
	}
	return {
		...profile,
		model,
		thinkingLevel,
		defaultBudget,
	};
}

function displayStatus(agent: AgentInstance): SubagentView["status"] {
	if (agent.handoffId) {
		return "completed";
	}
	return agent.status;
}

function permissionsRequireWriter(permission: PermissionSet): boolean {
	return permission.write || permission.executeCommands;
}

export class SubagentToolController {
	readonly #options: SubagentToolControllerOptions;

	constructor(options: SubagentToolControllerOptions) {
		this.#options = options;
	}

	async delegate(input: DelegateSubagentInput, signal?: AbortSignal): Promise<SubagentView> {
		assertNotAborted(signal);
		const loaded = this.#options.profiles.require(input.subagentType);
		const profile = overriddenProfile(loaded, input, this.#options);
		const runInBackground = effectiveRunInBackground(input, loaded);
		const binding = await this.#options.bind({
			description: input.description,
			profile: { ...loaded, profile },
			runInBackground,
		});
		let settled = false;
		const settle = async (result: AgentRunResult | undefined, error?: unknown): Promise<void> => {
			if (settled) {
				return;
			}
			settled = true;
			await binding.settle?.(result, error);
		};
		let agent: AgentInstance;
		try {
			assertNotAborted(signal);
			agent = await this.#options.service.spawn({
				...binding.input,
				profile,
				profileSource: loaded.source,
				profileSourcePath: loaded.sourcePath,
				scope: "delegation",
				backend: input.backend,
			});
		} catch (error) {
			await settle(undefined, error);
			throw error;
		}
		const context = effectiveInheritContext(input, loaded) ? this.#options.inheritedContext?.()?.trim() : undefined;
		const prompt = [
			`Delegation: ${input.description.trim()}`,
			input.prompt.trim(),
			context ? `Inherited context:\n${context}` : undefined,
		]
			.filter((part): part is string => part !== undefined)
			.join("\n\n");
		try {
			await this.#options.service.send(agent.id, prompt);
		} catch (error) {
			await this.#options.service.interrupt(agent.id, "Delegation dispatch failed").catch(() => undefined);
			await settle(undefined, error);
			throw error;
		}
		if (runInBackground) {
			void this.#options.service
				.wait(agent.id)
				.then((result) => settle(result))
				.catch((error: unknown) => settle(undefined, error));
			return {
				agent: this.#options.service.get(agent.id) ?? agent,
				status: "running",
			};
		}
		try {
			const result = await awaitWithAbort(this.#options.service.wait(agent.id), signal, async () => {
				await this.#options.service.interrupt(agent.id, "Parent tool call aborted");
			});
			await settle(result);
			const completed = this.#options.service.get(agent.id) ?? agent;
			return {
				agent: completed,
				status: result.status,
				result,
			};
		} catch (error) {
			await settle(undefined, error);
			throw error;
		}
	}

	async getResult(input: GetSubagentResultInput, signal?: AbortSignal): Promise<SubagentView> {
		assertNotAborted(signal);
		const agent = this.#options.service.get(input.agentId);
		if (!agent) {
			throw new SubagentToolError("subagent.not_found", `Agent ${input.agentId} was not found`);
		}
		let result: AgentRunResult | undefined;
		if (
			input.wait &&
			!agent.handoffId &&
			["starting", "idle", "running", "waiting", "stopping"].includes(agent.status)
		) {
			result = await awaitWithAbort(this.#options.service.wait(agent.id), signal, () => Promise.resolve());
		}
		const current = this.#options.service.get(agent.id) ?? agent;
		return {
			agent: current,
			status: result?.status ?? displayStatus(current),
			result,
			events: input.verbose ? this.#options.service.events(agent.id) : undefined,
			transcript: input.verbose ? this.#options.service.getTranscript(agent.id) : undefined,
		};
	}

	async steer(input: SteerSubagentInput, signal?: AbortSignal): Promise<SubagentView> {
		assertNotAborted(signal);
		const agent = this.#options.service.get(input.agentId);
		if (!agent) {
			throw new SubagentToolError("subagent.not_found", `Agent ${input.agentId} was not found`);
		}
		if (agent.handoffId || !["starting", "running", "waiting"].includes(agent.status)) {
			throw new SubagentToolError(
				"subagent.not_steerable",
				`Agent ${agent.id} cannot be steered while its status is ${displayStatus(agent)}`,
			);
		}
		await this.#options.service.send(agent.id, input.message.trim());
		const current = this.#options.service.get(agent.id) ?? agent;
		return { agent: current, status: displayStatus(current) };
	}

	writerRequired(input: DelegateSubagentInput): boolean {
		const loaded = this.#options.profiles.require(input.subagentType);
		return permissionsRequireWriter(loaded.profile.permissionCeiling);
	}
}

const thinkingSchema = Type.Union([
	Type.Literal("off"),
	Type.Literal("minimal"),
	Type.Literal("low"),
	Type.Literal("medium"),
	Type.Literal("high"),
	Type.Literal("xhigh"),
	Type.Literal("max"),
]);

const subagentSchema = Type.Object({
	prompt: Type.String({ minLength: 1, description: "The concrete task for the Subagent" }),
	description: Type.String({ minLength: 1, description: "A short delegation title" }),
	subagent_type: Type.String({ minLength: 1, description: "Agent Profile name" }),
	model: Type.Optional(Type.String({ minLength: 1 })),
	thinking: Type.Optional(thinkingSchema),
	max_turns: Type.Optional(Type.Integer({ minimum: 0 })),
	run_in_background: Type.Optional(Type.Boolean()),
	inherit_context: Type.Optional(Type.Boolean()),
	backend: Type.Optional(Type.Union([Type.Literal("auto"), Type.Literal("rpc"), Type.Literal("in-process")])),
});

const getSubagentResultSchema = Type.Object({
	agent_id: Type.String({ minLength: 1 }),
	wait: Type.Optional(Type.Boolean()),
	verbose: Type.Optional(Type.Boolean()),
});

const steerSubagentSchema = Type.Object({
	agent_id: Type.String({ minLength: 1 }),
	message: Type.String({ minLength: 1 }),
});

export interface SubagentToolDetails {
	readonly view: SubagentView;
}

function toolResult(view: SubagentView) {
	return {
		content: [{ type: "text" as const, text: JSON.stringify(view, null, 2) }],
		details: { view },
	};
}

export function createSubagentToolDefinitions(controller: SubagentToolController): readonly ToolDefinition[] {
	const subagent = defineTool<typeof subagentSchema, SubagentToolDetails>({
		name: "subagent",
		label: "Delegate",
		description:
			"Delegate a governed task to an isolated Agent Profile. The delegation remains bound to Workflow, Task, permissions, budget, and verification policy.",
		promptSnippet: "Delegate bounded work to a governed Subagent",
		executionMode: "sequential",
		parameters: subagentSchema,
		execute: async (_toolCallId, params, signal) =>
			toolResult(
				await controller.delegate(
					{
						prompt: params.prompt,
						description: params.description,
						subagentType: params.subagent_type,
						model: params.model,
						thinking: params.thinking,
						maxTurns: params.max_turns,
						runInBackground: params.run_in_background,
						inheritContext: params.inherit_context,
						backend: params.backend,
					},
					signal,
				),
			),
	});
	const getResult = defineTool<typeof getSubagentResultSchema, SubagentToolDetails>({
		name: "get_subagent_result",
		label: "Agent Result",
		description:
			"Inspect or wait for a governed Subagent and return its bounded status, handoff, and optional events.",
		promptSnippet: "Inspect or wait for a Subagent result",
		parameters: getSubagentResultSchema,
		execute: async (_toolCallId, params, signal) =>
			toolResult(
				await controller.getResult(
					{
						agentId: params.agent_id,
						wait: params.wait,
						verbose: params.verbose,
					},
					signal,
				),
			),
	});
	const steer = defineTool<typeof steerSubagentSchema, SubagentToolDetails>({
		name: "steer_subagent",
		label: "Steer Agent",
		description:
			"Send an additional instruction to a running governed Subagent without changing its Task, permissions, budget, or writer lease.",
		promptSnippet: "Steer a running Subagent",
		parameters: steerSubagentSchema,
		execute: async (_toolCallId, params, signal) =>
			toolResult(await controller.steer({ agentId: params.agent_id, message: params.message }, signal)),
	});
	return [subagent, getResult, steer];
}

export type SubagentToolParameters = Static<typeof subagentSchema>;
