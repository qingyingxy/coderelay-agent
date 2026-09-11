import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionEvent, PromptOptions } from "../../src/core/agent-session.ts";
import {
	createPlannerPromptEnvelope,
	executePlannerPrompt,
	parsePlannerPlanContentWithRepair,
} from "../../src/core/workflow/planner-runtime.ts";
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
	turnDelayMs = 0;
	requestFailed = false;

	getActiveToolNames(): string[] {
		return [...this.activeTools];
	}

	setActiveToolsByName(toolNames: string[]): void {
		this.activeTools = [...toolNames];
	}

	async prompt(_text: string, _options?: PromptOptions): Promise<void> {
		for (let turn = 0; turn < this.toolTurns; turn++) {
			if (this.turnDelayMs) await new Promise((resolve) => setTimeout(resolve, this.turnDelayMs));
			if (this.abortCount) break;
			this.activeToolsByTurn.push([...this.activeTools]);
			const message = fauxAssistantMessage(`progress ${turn}`, {
				stopReason: this.requestFailed ? "error" : "toolUse",
			});
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
	afterEach(() => vi.useRealTimers());
	it("does not accept a failed request as completed investigation", async () => {
		const session = new BudgetPromptSession();
		session.toolTurns = 1;
		session.requestFailed = true;
		await expect(executePlannerPrompt(session, envelope())).rejects.toMatchObject({ code: "planner.request_failed" });
		expect(session.listeners.size).toBe(0);
	});
	it("also watches stalled JSON repair and restores tools", async () => {
		vi.useFakeTimers();
		const session = new BudgetPromptSession();
		session.toolTurns = 1;
		session.turnDelayMs = 1_800_001;
		const result = expect(parsePlannerPlanContentWithRepair(session, "invalid")).rejects.toMatchObject({
			code: "planner.inactivity",
		});
		await vi.advanceTimersByTimeAsync(1_800_001);
		await result;
		expect(session.activeTools).toEqual(["read", "grep", "bash", "edit"]);
		expect(session.listeners.size).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
	});
	it("continues beyond 90 seconds, 240 seconds and twelve turns while progressing", async () => {
		vi.useFakeTimers();
		const session = new BudgetPromptSession();
		session.toolTurns = 16;
		session.turnDelayMs = 20_000;
		const result = executePlannerPrompt(session, envelope());
		await vi.advanceTimersByTimeAsync(320_000);
		await result;
		expect(session.abortCount).toBe(0);
		expect(session.activeToolsByTurn).toHaveLength(16);
		expect(vi.getTimerCount()).toBe(0);
	});
	it.each([
		[{}, 1_800_000, "planner.inactivity"],
		[{ budget: { maxDurationMs: 100 } }, 100, "planner.max_duration"],
		[{ investigationTimeoutMs: 100 }, 100, "planner.investigation_timeout"],
	])("stops stalled investigation or an explicit hard deadline: %j", async (options, timeout, code) => {
		vi.useFakeTimers();
		const session = new BudgetPromptSession();
		session.toolTurns = 1;
		session.turnDelayMs = timeout + 1;
		const result = expect(executePlannerPrompt(session, envelope(), options)).rejects.toMatchObject({ code });
		await vi.advanceTimersByTimeAsync(timeout + 1);
		await result;
		expect(session.abortCount).toBe(1);
		expect(session.listeners.size).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
	});
	it("allows dependent investigation rounds within the budget", async () => {
		const session = new BudgetPromptSession();
		session.toolTurns = 2;

		await executePlannerPrompt(session, envelope(), { budget: { maxTurns: 3 } });

		expect(session.activeToolsByTurn).toEqual([
			["read", "grep"],
			["read", "grep"],
		]);
		expect(session.steers).toHaveLength(0);
		expect(session.abortCount).toBe(0);
		expect(session.listeners).toHaveLength(0);
		expect(session.activeTools).toEqual(["read", "grep", "bash", "edit"]);
	});

	it("aborts investigation at the configured turn budget and releases listeners", async () => {
		const session = new BudgetPromptSession();
		session.toolTurns = 2;

		await expect(executePlannerPrompt(session, envelope(), { budget: { maxTurns: 1 } })).rejects.toMatchObject({
			code: "planner.max_turns",
		});
		expect(session.activeToolsByTurn).toEqual([
			["read", "grep"],
			["read", "grep"],
		]);
		expect(session.steers).toHaveLength(0);
		expect(session.abortCount).toBe(1);
		expect(session.listeners).toHaveLength(0);
		expect(session.activeTools).toEqual(["read", "grep", "bash", "edit"]);
	});
});
