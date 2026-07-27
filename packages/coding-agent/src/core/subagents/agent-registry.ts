import type { AgentId, HandoffId, IsoDateTime, ResourceUsage, WorkflowId } from "../workflow/types.ts";
import type { AgentInstance, AgentInstanceStatus, AgentRuntimeEvent, AgentRuntimeEventType, Handoff } from "./types.ts";

const TRANSITIONS: Readonly<Record<AgentInstanceStatus, ReadonlySet<AgentInstanceStatus>>> = {
	starting: new Set(["idle", "failed", "stopping"]),
	idle: new Set(["running", "stopping", "failed"]),
	running: new Set(["idle", "waiting", "stopping", "failed"]),
	waiting: new Set(["running", "stopping", "failed"]),
	stopping: new Set(["stopped", "failed", "interrupted"]),
	stopped: new Set(),
	failed: new Set(),
	interrupted: new Set(),
};

export class AgentRegistryError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "AgentRegistryError";
		this.code = code;
	}
}

export interface AgentRegistryOptions {
	readonly now?: () => IsoDateTime;
}

export class AgentRegistry {
	readonly #agents = new Map<AgentId, AgentInstance>();
	readonly #handoffs = new Map<HandoffId, Handoff>();
	readonly #events: AgentRuntimeEvent[] = [];
	readonly #listeners = new Set<(event: AgentRuntimeEvent) => void>();
	readonly #now: () => IsoDateTime;
	#sequence = 0;

	constructor(options: AgentRegistryOptions = {}) {
		this.#now = options.now ?? (() => new Date().toISOString());
	}

	create(instance: AgentInstance): AgentInstance {
		if (this.#agents.has(instance.id)) {
			throw new AgentRegistryError("agent_registry.agent_exists", `Agent ${instance.id} already exists`);
		}
		if (instance.parentAgentId) {
			const parent = this.#agents.get(instance.parentAgentId);
			if (!parent || parent.workflowId !== instance.workflowId) {
				throw new AgentRegistryError(
					"agent_registry.parent_missing",
					`Parent Agent ${instance.parentAgentId} does not exist in Workflow ${instance.workflowId}`,
				);
			}
			if (instance.depth !== parent.depth + 1) {
				throw new AgentRegistryError("agent_registry.invalid_depth", `Agent ${instance.id} has an invalid depth`);
			}
		}
		this.#agents.set(instance.id, structuredClone(instance));
		this.#emit(instance, "created");
		return structuredClone(instance);
	}

	get(agentId: AgentId): AgentInstance | undefined {
		const instance = this.#agents.get(agentId);
		return instance ? structuredClone(instance) : undefined;
	}

	list(workflowId?: WorkflowId): readonly AgentInstance[] {
		return [...this.#agents.values()]
			.filter((agent) => workflowId === undefined || agent.workflowId === workflowId)
			.map((agent) => structuredClone(agent));
	}

	children(parentAgentId: AgentId): readonly AgentInstance[] {
		return this.list().filter((agent) => agent.parentAgentId === parentAgentId);
	}

	transition(agentId: AgentId, toStatus: AgentInstanceStatus, message?: string): AgentInstance {
		const current = this.#require(agentId);
		if (current.status === toStatus) {
			return structuredClone(current);
		}
		if (!TRANSITIONS[current.status].has(toStatus)) {
			throw new AgentRegistryError(
				"agent_registry.invalid_transition",
				`Agent ${agentId} cannot transition from ${current.status} to ${toStatus}`,
			);
		}
		const eventType = current.status === "starting" && toStatus === "idle" ? "ready" : this.#eventType(toStatus);
		return this.#replace(
			{ ...current, status: toStatus, revision: current.revision + 1, updatedAt: this.#now() },
			eventType,
			message,
		);
	}

	setSession(agentId: AgentId, sessionId: string): AgentInstance {
		const current = this.#require(agentId);
		return this.#replace({
			...current,
			sessionId,
			revision: current.revision + 1,
			updatedAt: this.#now(),
		});
	}

	setUsage(agentId: AgentId, usage: ResourceUsage): AgentInstance {
		const current = this.#require(agentId);
		return this.#replace(
			{
				...current,
				usage: structuredClone(usage),
				revision: current.revision + 1,
				updatedAt: this.#now(),
			},
			"usage",
			`${usage.inputTokens + usage.outputTokens} tokens, ${usage.turns} turns, $${usage.cost.toFixed(4)}`,
		);
	}

	fail(agentId: AgentId, message: string): AgentInstance {
		const failed = this.transition(agentId, "failed", message);
		return this.#replace({
			...failed,
			lastError: message,
			revision: failed.revision + 1,
			updatedAt: this.#now(),
		});
	}

	recordHandoff(agentId: AgentId, handoff: Handoff): AgentInstance {
		const current = this.#require(agentId);
		if (
			handoff.agentId !== agentId ||
			handoff.workflowId !== current.workflowId ||
			handoff.taskId !== current.taskId ||
			handoff.attemptId !== current.attemptId
		) {
			throw new AgentRegistryError("agent_registry.handoff_owner", `Handoff ${handoff.id} has invalid ownership`);
		}
		if (this.#handoffs.has(handoff.id)) {
			throw new AgentRegistryError("agent_registry.handoff_exists", `Handoff ${handoff.id} already exists`);
		}
		this.#handoffs.set(handoff.id, structuredClone(handoff));
		return this.#replace({
			...current,
			handoffId: handoff.id,
			revision: current.revision + 1,
			updatedAt: this.#now(),
		});
	}

	getHandoff(handoffId: HandoffId): Handoff | undefined {
		const handoff = this.#handoffs.get(handoffId);
		return handoff ? structuredClone(handoff) : undefined;
	}

	listHandoffs(workflowId?: WorkflowId): readonly Handoff[] {
		return [...this.#handoffs.values()]
			.filter((handoff) => workflowId === undefined || handoff.workflowId === workflowId)
			.map((handoff) => structuredClone(handoff));
	}

	progress(agentId: AgentId, message: string): void {
		this.#emit(this.#require(agentId), "progress", message);
	}

	block(agentId: AgentId, message: string): AgentInstance {
		const current = this.#require(agentId);
		if (current.status === "waiting") {
			this.#emit(current, "blocked", message);
			return structuredClone(current);
		}
		if (current.status !== "running") {
			throw new AgentRegistryError(
				"agent_registry.not_blockable",
				`Agent ${agentId} cannot be blocked while ${current.status}`,
			);
		}
		return this.#replace(
			{
				...current,
				status: "waiting",
				revision: current.revision + 1,
				updatedAt: this.#now(),
			},
			"blocked",
			message,
		);
	}

	events(agentId?: AgentId): readonly AgentRuntimeEvent[] {
		return this.#events
			.filter((event) => agentId === undefined || event.agentId === agentId)
			.map((event) => structuredClone(event));
	}

	subscribe(listener: (event: AgentRuntimeEvent) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	#replace(instance: AgentInstance, eventType?: AgentRuntimeEventType, message?: string): AgentInstance {
		this.#agents.set(instance.id, structuredClone(instance));
		if (eventType) {
			this.#emit(instance, eventType, message);
		}
		return structuredClone(instance);
	}

	#require(agentId: AgentId): AgentInstance {
		const instance = this.#agents.get(agentId);
		if (!instance) {
			throw new AgentRegistryError("agent_registry.agent_missing", `Agent ${agentId} does not exist`);
		}
		return instance;
	}

	#eventType(status: AgentInstanceStatus): AgentRuntimeEventType {
		switch (status) {
			case "running":
				return "started";
			case "waiting":
				return "waiting";
			case "idle":
				return "completed";
			case "failed":
				return "failed";
			case "interrupted":
				return "interrupted";
			case "stopped":
				return "stopped";
			case "stopping":
				return "stopping";
			case "starting":
				return "created";
		}
	}

	#emit(instance: AgentInstance, type: AgentRuntimeEventType, message?: string): void {
		const event: AgentRuntimeEvent = {
			sequence: ++this.#sequence,
			agentId: instance.id,
			workflowId: instance.workflowId,
			taskId: instance.taskId,
			type,
			occurredAt: this.#now(),
			message,
		};
		this.#events.push(event);
		for (const listener of this.#listeners) {
			listener(structuredClone(event));
		}
	}
}
