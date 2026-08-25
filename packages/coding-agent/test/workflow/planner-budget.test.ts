import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import type { AgentSessionEvent, PromptOptions } from "../../src/core/agent-session.ts";
import { createPlannerPromptEnvelope, executePlannerPrompt } from "../../src/core/workflow/planner-runtime.ts";
import type { PromptAgentSession } from "../../src/core/workflow/prompt-agent-session-adapter.ts";
import { NOW } from "./fixtures.ts";

function envelope() {
	return createPlannerPromptEnvelope({
		createdAt: NOW,
		task: {
			id: "task-root",
			workflowId: "workflow-1",
			title: "Plan request",
			description: "Plan a bounded repair",
			status: "pending",
			dependencyIds: [],
			verificationRequirements: [],
		},
		userRequest: "Plan a bounded repair",
		activeToolNames: ["read", "grep", "bash", "edit"],
	});
}

class BudgetPromptSession implements PromptAgentSession {
	isIdle = true;
	activeTools = ["read", "grep", "bash", "edit"];
	readonly activeToolsByTurn: string[][] = [];
	readonly steers: string[] = [];
	readonly listeners = new Set<(event: AgentSessionEvent) => void>();
	abortCount = 0;
	toolTurns = 0;

	getActiveToolNames(): string[] {
		return [...this.activeTools];
	}

	setActiveToolsByName(toolNames: string[]): void {
		this.activeTools = [...toolNames];
	}

	async prompt(_text: string, _options?: PromptOptions): Promise<void> {
		for (let turn = 0; turn < this.toolTurns; turn++) {
			this.activeToolsByTurn.push([...this.activeTools]);
			const message = fauxAssistantMessage("", { stopReason: "toolUse" });
			for (const listener of this.listeners) listener({ type: "message_end", message });
			for (const listener of this.listeners) listener({ type: "turn_end", message, toolResults: [] });
		}
	}

	async steer(text: string): Promise<void> {
		this.steers.push(text);
	}

	async abort(): Promise<void> {
		this.abortCount++;
	}

	subscribe(listener: (event: AgentSessionEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
}

describe("Planner budget", () => {
	it("closes Planner tools after one investigation round and requests final JSON", async () => {
		const session = new BudgetPromptSession();
		session.toolTurns = 1;

		await executePlannerPrompt(session, envelope(), { budget: { maxTurns: 3 } });

		expect(session.activeToolsByTurn).toEqual([["read", "grep"]]);
		expect(session.steers).toHaveLength(1);
		expect(session.steers[0]).toContain("single investigation round is complete");
		expect(session.abortCount).toBe(0);
		expect(session.listeners).toHaveLength(0);
		expect(session.activeTools).toEqual(["read", "grep", "bash", "edit"]);
	});

	it("rejects a second Planner tool round after tools were closed", async () => {
		const session = new BudgetPromptSession();
		session.toolTurns = 2;

		await expect(executePlannerPrompt(session, envelope(), { budget: { maxTurns: 3 } })).rejects.toMatchObject({
			code: "planner.investigation_round_exceeded",
		});
		expect(session.activeToolsByTurn).toEqual([["read", "grep"], []]);
		expect(session.steers).toHaveLength(1);
		expect(session.abortCount).toBe(1);
		expect(session.listeners).toHaveLength(0);
		expect(session.activeTools).toEqual(["read", "grep", "bash", "edit"]);
	});
});
