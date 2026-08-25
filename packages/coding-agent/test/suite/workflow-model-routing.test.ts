import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

describe("Workflow model routing AgentSession integration", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("switches low-risk Direct work to the configured fast model and persists the decision", async () => {
		const harness = await createHarness({
			models: [
				{ id: "faux-strong", name: "Faux Strong" },
				{ id: "faux-fast", name: "Faux Fast" },
			],
			modelRouting: {
				enabled: true,
				fastModel: "faux/faux-fast",
				strongModel: "faux/faux-strong",
			},
		});
		harnesses.push(harness);
		harness.session.enableWorkflowTracking("direct");
		harness.setResponses([fauxAssistantMessage("Implemented")]);

		await harness.session.prompt("Make a small text-only change");

		expect(harness.session.model?.id).toBe("faux-fast");
		expect(harness.session.getWorkflowView()?.modelRoutes).toMatchObject([
			{
				role: "main",
				tier: "fast",
				modelName: "faux/faux-fast",
				previousModelName: "faux/faux-strong",
				source: "configured",
				reasonCode: "model.main.low_risk_fast",
			},
		]);
		expect(harness.eventsOfType("model_route_decided")).toHaveLength(1);
		expect(
			harness.sessionManager
				.getEntries()
				.some(
					(entry) =>
						entry.type === "custom" &&
						entry.customType === "workflow-model-routing" &&
						(entry.data as { modelName?: string } | undefined)?.modelName === "faux/faux-fast",
				),
		).toBe(true);
	});

	it("preserves an explicitly selected initial model", async () => {
		const harness = await createHarness({
			models: [
				{ id: "faux-strong", name: "Faux Strong" },
				{ id: "faux-fast", name: "Faux Fast" },
			],
			modelRouting: {
				enabled: true,
				fastModel: "faux/faux-fast",
				strongModel: "faux/faux-strong",
			},
			modelRoutingUserOverride: true,
		});
		harnesses.push(harness);
		harness.session.enableWorkflowTracking("direct");
		harness.setResponses([fauxAssistantMessage("Implemented")]);

		await harness.session.prompt("Make a small text-only change");

		expect(harness.session.model?.id).toBe("faux-strong");
		expect(harness.session.getWorkflowView()?.modelRoutes).toMatchObject([
			{
				modelName: "faux/faux-strong",
				source: "explicit",
				reasonCode: "model.explicit_preserved",
			},
		]);
	});

	it("preserves a model selected interactively before automatic routing", async () => {
		const harness = await createHarness({
			models: [
				{ id: "faux-strong", name: "Faux Strong" },
				{ id: "faux-fast", name: "Faux Fast" },
			],
			modelRouting: {
				enabled: true,
				fastModel: "faux/faux-fast",
				strongModel: "faux/faux-strong",
			},
		});
		harnesses.push(harness);
		harness.session.enableWorkflowTracking("direct");
		await harness.session.setModel(harness.models[0]);
		harness.setResponses([fauxAssistantMessage("Implemented")]);

		await harness.session.prompt("Make a small text-only change");

		expect(harness.session.model?.id).toBe("faux-strong");
		expect(harness.session.getWorkflowView()?.modelRoutes).toMatchObject([
			{
				modelName: "faux/faux-strong",
				source: "explicit",
				reasonCode: "model.explicit_preserved",
			},
		]);
	});

	it("preserves a model selected by interactive cycling before automatic routing", async () => {
		const harness = await createHarness({
			models: [
				{ id: "faux-strong", name: "Faux Strong" },
				{ id: "faux-fast", name: "Faux Fast" },
			],
			modelRouting: {
				enabled: true,
				fastModel: "faux/faux-fast",
				strongModel: "faux/faux-strong",
			},
		});
		harnesses.push(harness);
		harness.session.enableWorkflowTracking("direct");
		await expect(harness.session.cycleModel()).resolves.toMatchObject({
			model: { id: "faux-fast" },
		});
		harness.setResponses([fauxAssistantMessage("Implemented")]);

		await harness.session.prompt("Make a small text-only change");

		expect(harness.session.model?.id).toBe("faux-fast");
		expect(harness.session.getWorkflowView()?.modelRoutes).toMatchObject([
			{
				modelName: "faux/faux-fast",
				source: "explicit",
				reasonCode: "model.explicit_preserved",
			},
		]);
	});
});
