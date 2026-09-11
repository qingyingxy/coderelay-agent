import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { expect, it, vi } from "vitest";
import { ExecutionWatchdog, LONG_TASK_WATCHDOG } from "../../src/core/workflow/execution-watchdog.ts";
import { createHarness } from "./harness.ts";

it.each(["execution", "repair"])("records a long direct %s costing over $2 without a budget stop", async (stage) => {
	const harness = await createHarness({
		extensionFactories: [
			(pi) => {
				pi.on("message_end", (event) => {
					if (event.message.role !== "assistant") return;
					return {
						message: {
							...event.message,
							usage: { ...event.message.usage, cost: { ...event.message.usage.cost, total: 3 } },
						},
					};
				});
			},
		],
	});
	const stop = vi.fn();
	const monitor = new ExecutionWatchdog(LONG_TASK_WATCHDOG, stop);
	const unsubscribe = harness.session.subscribe((event) => monitor.observe(event));
	const started = Date.now();
	try {
		harness.session.enableWorkflowTracking("direct", false, undefined, {
			maxRetries: 0,
			maxConcurrentAgents: 1,
			maxConcurrentJobs: 1,
		});
		harness.setResponses([
			() => {
				vi.spyOn(Date, "now").mockReturnValue(started + 60 * 60_000);
				return fauxAssistantMessage(`${stage} completed`);
			},
		]);
		await harness.session.prompt("Complete the assigned task", {
			isolatedDirectExecution: { reason: "Host-owned offline evaluation" },
		});
		expect(harness.session.getWorkflowView()?.workflow.status).toBe("completed");
		expect(harness.session.getSessionStats().cost).toBe(3);
		expect(stop).not.toHaveBeenCalled();
		expect(harness.faux.state.callCount).toBe(1);
	} finally {
		unsubscribe();
		monitor.dispose();
		vi.restoreAllMocks();
		harness.cleanup();
	}
});
