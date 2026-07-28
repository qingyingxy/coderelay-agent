import { describe, expect, it } from "vitest";
import { type AgentInstance, AgentRegistry, AgentRegistryError, FULL_PERMISSION_SET } from "../../src/index.ts";
import { NOW, ZERO_USAGE } from "./fixtures.ts";

function instance(id: string, parentAgentId?: string): AgentInstance {
	return {
		id,
		workflowId: "workflow-1",
		parentAgentId,
		taskId: `task-${id}`,
		attemptId: `attempt-${id}`,
		profileName: "explorer",
		scope: "task",
		backend: "rpc",
		status: "starting",
		depth: parentAgentId ? 2 : 1,
		retryCount: 0,
		effectivePermissions: FULL_PERMISSION_SET,
		budget: {},
		usage: ZERO_USAGE,
		revision: 0,
		createdAt: NOW,
		updatedAt: NOW,
	};
}

describe("AgentRegistry", () => {
	it("stores parent-child identity, session, status, usage, and events", () => {
		const registry = new AgentRegistry({ now: () => NOW });
		registry.create(instance("parent"));
		registry.create(instance("child", "parent"));
		registry.setSession("child", "session-child");
		registry.transition("child", "idle");
		registry.transition("child", "running");
		registry.progress("child", "Reading files");
		registry.block("child", "Waiting for parent input");
		registry.transition("child", "running");
		registry.setUsage("child", { ...ZERO_USAGE, inputTokens: 10, turns: 1 });
		registry.transition("child", "idle", "Completed");

		expect(registry.get("child")).toMatchObject({
			parentAgentId: "parent",
			sessionId: "session-child",
			status: "idle",
			usage: { inputTokens: 10, turns: 1 },
		});
		expect(registry.children("parent").map(({ id }) => id)).toEqual(["child"]);
		expect(registry.events("child").map(({ type }) => type)).toEqual([
			"created",
			"ready",
			"started",
			"progress",
			"blocked",
			"started",
			"usage",
			"completed",
		]);
		expect(registry.events("child").map(({ eventName }) => eventName)).toEqual([
			"subagent_created",
			"subagent_queued",
			"subagent_started",
			"subagent_progress",
			"subagent_waiting",
			"subagent_started",
			"subagent_usage",
			"subagent_completed",
		]);
	});

	it("rejects invalid hierarchy and state transitions", () => {
		const registry = new AgentRegistry({ now: () => NOW });
		expect(() => registry.create(instance("child", "missing"))).toThrow(AgentRegistryError);
		registry.create(instance("agent"));
		expect(() => registry.transition("agent", "stopped")).toThrow(AgentRegistryError);
	});

	it("isolates observer failures from authoritative state transitions", () => {
		const listenerErrors: unknown[] = [];
		const registry = new AgentRegistry({
			now: () => NOW,
			onListenerError: (error) => listenerErrors.push(error),
		});
		registry.subscribe(() => {
			throw new Error("observer failed");
		});

		expect(() => registry.create(instance("agent"))).not.toThrow();
		expect(() => registry.transition("agent", "idle")).not.toThrow();
		expect(registry.get("agent")).toMatchObject({ status: "idle" });
		expect(registry.events("agent")[0]).toMatchObject({
			attemptId: "attempt-agent",
			type: "created",
		});
		expect(listenerErrors).toHaveLength(2);
	});
});
