import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { PierBudget, type PierRunConfig, parsePierRunConfig } from "../evals/context-window/pier-budget.ts";
import {
	classifyPierRuntime,
	PIER_CAPABILITY_PROBE,
	runPierSession,
} from "../evals/context-window/pier-real-session.ts";
import { completeSummarization } from "../src/core/compaction/compaction.ts";
import { requiresPlanMode } from "../src/core/workflow/autonomous-workflow-policy.ts";
import { ModelRuntime } from "../src/index.ts";

const config: PierRunConfig = {
	provider: "faux",
	model: "test",
	group: "A",
	maxCostUsd: 1,
	maxRequests: 12,
	contextWindow: 64000,
	maxOutputTokens: 4000,
	timeoutSeconds: 30,
	pricing: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 },
};

const instruction = readFileSync(
	new URL("./fixtures/pier-safe-import-instruction.md", import.meta.url),
	"utf8",
).replace(/\r\n/g, "\n");

describe("Pier routing and result regressions", () => {
	it("uses the pinned original instruction without a command-name false positive", () => {
		expect(createHash("sha256").update(instruction).digest("hex")).toBe(
			"dcdf0f34992ce86f4ef516fbc4cac6daaf159ae4542a6bbebe055e37851ff7a6",
		);
		expect(requiresPlanMode({ text: instruction })).toBe(false);
	});
	it.each([
		"Remove the database",
		"delete old files",
		"drop the table",
		"truncate records",
		"Deploy to production",
		"Change permission",
		"Rotate secret credential",
		"迁移数据库",
		"Run remove-import-invariant now",
		"Execute `remove-import-invariant`",
		"Add commands: remove-import-invariant. Then remove existing data.",
	])("retains production risk detection: %s", (text) => {
		expect(requiresPlanMode({ text })).toBe(true);
	});
	it.each([
		[{ workflowStatus: "awaiting_approval" }, "waiting_for_approval"],
		[{ clarificationPending: true }, "waiting_for_clarification"],
		[{ workflowStatus: "planning" }, "planning"],
		[{ containerCalls: 0, containerReplies: 0 }, "no_execution"],
		[{ containerReplies: 0 }, "incomplete"],
		[{ workflowStatus: "failed" }, "incomplete"],
		[{ timedOut: true }, "timeout"],
		[{ budgetStopped: true }, "budget_or_provider_stop"],
	] as const)("does not confuse normal model stop with completion: %j", (overrides, expected) => {
		expect(
			classifyPierRuntime({
				timedOut: false,
				budgetStopped: false,
				failed: false,
				normalFinal: true,
				clarificationPending: false,
				containerCalls: 1,
				containerReplies: 1,
				...overrides,
			}),
		).toBe(expected);
	});
});

describe("Pier request budget", () => {
	it("passes main and summary contexts through unchanged even with few requests left", async () => {
		const faux = registerFauxProvider();
		try {
			const budget = new PierBudget({ ...config, maxCostUsd: 0.1, maxRequests: 3 }, () => {});
			let dispatches = 0;
			const contexts: unknown[] = [];
			const dispatch: StreamFn = (_model, context) => {
				contexts.push(context);
				dispatches++;
				const message = fauxAssistantMessage("fixture");
				message.usage = {
					input: 10000,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 10001,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				};
				const stream = createAssistantMessageEventStream();
				stream.push({ type: "done", reason: "stop", message });
				stream.end(message);
				return stream;
			};
			const wrapped = budget.wrap(dispatch);
			const context = {
				systemPrompt: "Original instructions",
				messages: [],
				tools: [{ name: "container_exec", description: "fixture", parameters: Type.Object({}) }],
			};
			await (await wrapped(faux.getModel(), context)).result();
			const summaryContext = { messages: [] };
			const auxiliary = await (await wrapped(faux.getModel(), summaryContext)).result();
			expect(auxiliary.stopReason).toBe("stop");
			expect(budget.stopped).toBeUndefined();
			await (await wrapped(faux.getModel(), context)).result();
			expect(dispatches).toBe(3);
			expect(contexts[0]).toBe(context);
			expect(contexts[1]).toBe(summaryContext);
			expect(contexts[2]).toBe(context);
			expect((await (await wrapped(faux.getModel(), context)).result()).stopReason).toBe("error");
			expect(dispatches).toBe(3);
		} finally {
			faux.unregister();
		}
	});
	it("rejects invalid and missing explicit cost configuration", () => {
		expect(() => parsePierRunConfig({ ...config, maxCostUsd: Number.NaN })).toThrow();
		expect(() => parsePierRunConfig({ ...config, maxRequests: 0.5 })).toThrow();
		expect(() => parsePierRunConfig({ ...config, pricing: undefined })).toThrow();
		expect(() => parsePierRunConfig({ ...config, contextWindow: 300000 })).toThrow();
		expect(() => parsePierRunConfig({ ...config, apiKey: "not-a-real-secret" })).toThrow("Unknown configuration");
	});

	it("blocks dispatch before the first unaffordable request", async () => {
		const faux = registerFauxProvider();
		try {
			let calls = 0;
			const dispatch: StreamFn = () => {
				calls++;
				throw new Error("Must not dispatch");
			};
			const budget = new PierBudget({ ...config, maxCostUsd: 0.001 }, () => {});
			const reply = await (await budget.wrap(dispatch)(faux.getModel(), { messages: [] })).result();
			expect(reply.stopReason).toBe("error");
			expect(calls).toBe(0);
			expect(budget.requests).toBe(0);
		} finally {
			faux.unregister();
		}
	});

	it("accounts cached tokens and summary requests once, caps output and disables retries", async () => {
		const faux = registerFauxProvider();
		try {
			const budget = new PierBudget({ ...config, maxRequests: 1 }, () => {});
			const dispatch: StreamFn = (_model, _context, options) => {
				expect(options?.maxTokens).toBe(4000);
				expect(options?.maxRetries).toBe(0);
				const message = {
					...fauxAssistantMessage("summary"),
					usage: {
						input: 100,
						output: 50,
						cacheRead: 200,
						cacheWrite: 30,
						totalTokens: 380,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 999 },
					},
				};
				const stream = createAssistantMessageEventStream();
				stream.push({ type: "done", reason: "stop", message });
				stream.end(message);
				return stream;
			};
			const wrapped = budget.wrap(dispatch);
			const summary = await completeSummarization(faux.getModel(), { messages: [] }, { maxTokens: 9000 }, wrapped);
			expect(summary.stopReason).toBe("stop");
			expect(budget.accountedUsd).toBeCloseTo(0.00025, 8);
			expect((await (await wrapped(faux.getModel(), { messages: [] })).result()).stopReason).toBe("error");
			expect(budget.requests).toBe(1);
		} finally {
			faux.unregister();
		}
	});

	it("keeps reservations and stops after transport failure or absent usage", async () => {
		const faux = registerFauxProvider();
		try {
			for (const missing of [true, false]) {
				const budget = new PierBudget(config, () => {});
				const dispatch: StreamFn = () => {
					if (!missing) throw new Error("private endpoint details");
					const message = fauxAssistantMessage("no usage");
					const stream = createAssistantMessageEventStream();
					stream.push({ type: "done", reason: "stop", message });
					stream.end(message);
					return stream;
				};
				await (await budget.wrap(dispatch)(faux.getModel(), { messages: [] })).result();
				expect(budget.accountedUsd).toBeCloseTo(0.072);
				expect(budget.receipts[0]?.status).toBe("unknown");
				expect(budget.stopped).toBeDefined();
			}
		} finally {
			faux.unregister();
		}
	});
});

describe("Pier real-session runner with free provider", () => {
	for (const scenario of [
		"A",
		"C",
		"C-risk",
		"no-execution",
		"low-request-limit",
		"late-execution",
		"unsubmitted",
		"failed-verification",
		"failed-commit",
	] as const) {
		const group = scenario === "C" || scenario === "C-risk" || scenario === "no-execution" ? "C" : "A";
		it(`runs ${scenario} with only remote repository execution and captures independent runtime status`, async () => {
			const output = mkdtempSync(join(tmpdir(), "pi-pier-session-"));
			const faux = registerFauxProvider({
				models: [{ id: "test", contextWindow: 64000, maxTokens: 4000, reasoning: true }],
			});
			try {
				const model = faux.getModel();
				const runtime = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false });
				runtime.registerProvider(model.provider, { api: model.api, baseUrl: model.baseUrl, models: [model] });
				await runtime.setRuntimeApiKey(model.provider, "faux-key", { allowNetwork: false });
				faux.setResponses(
					scenario === "no-execution"
						? [fauxAssistantMessage("Here is a plan only.")]
						: [
								fauxAssistantMessage(fauxToolCall("container_exec", { command: "git status --short" }), {
									stopReason: "toolUse",
								}),
								...(group === "C"
									? [
											fauxAssistantMessage(
												fauxToolCall("notes", {
													action: "upsert",
													category: "constraint",
													note_id: "fixture",
													content: "pier-regression-memory-marker",
												}),
												{ stopReason: "toolUse" },
											),
											fauxAssistantMessage(fauxToolCall("new_context", {}), { stopReason: "toolUse" }),
											fauxAssistantMessage(
												fauxToolCall("history", { action: "search", query: "git status --short" }),
												{ stopReason: "toolUse" },
											),
										]
									: []),
								...(scenario === "late-execution"
									? [
											fauxAssistantMessage(
												fauxToolCall("container_exec", { command: "continue implementation" }),
												{ stopReason: "toolUse" },
											),
										]
									: scenario === "unsubmitted"
										? []
										: [
												fauxAssistantMessage(
													fauxToolCall("container_submit", {
														verification_command: "python -m py_compile fixture.py",
														message: "Implement fixture",
													}),
													{ stopReason: "toolUse" },
												),
											]),
								(context) => {
									expect(context.systemPrompt).toContain("Observed container capabilities:");
									expect(context.systemPrompt).not.toContain("Current execution budget:");
									expect(context.tools?.map((tool) => tool.name)).toEqual(
										group === "C"
											? ["container_exec", "container_submit", "history", "notes", "new_context"]
											: ["container_exec", "container_submit"],
									);
									return fauxAssistantMessage("Finished fixture.");
								},
							],
				);
				const commands: string[] = [];
				const result = await runPierSession(
					{
						...config,
						group,
						maxRequests:
							scenario === "low-request-limit" || scenario === "late-execution" ? 3 : config.maxRequests,
					},
					scenario === "C-risk" ? `${instruction}\nRemove the disposable fixture database.` : instruction,
					output,
					runtime,
					model,
					async (command) => {
						commands.push(command);
						if (command === PIER_CAPABILITY_PROBE)
							return {
								stdout: "git=available\npython=available\napply_patch=missing\n",
								stderr: "",
								return_code: 0,
							};
						if (scenario === "failed-commit" && command.startsWith("git add"))
							return { stdout: "Commit failed", stderr: "", return_code: 1 };
						if (scenario === "failed-verification" && command.startsWith("git diff --check"))
							return { stdout: "SyntaxError", stderr: "", return_code: 1 };
						return { stdout: "", stderr: "", return_code: 0 };
					},
				);
				expect(result.status).toBe(
					scenario === "unsubmitted" ||
						scenario === "failed-verification" ||
						scenario === "failed-commit" ||
						scenario === "late-execution"
						? "submission_incomplete"
						: scenario === "no-execution"
							? "no_execution"
							: "runtime_completed",
				);
				expect(result.officialTaskSuccess).toBeNull();
				expect(commands[0]).toBe(PIER_CAPABILITY_PROBE);
				if (scenario !== "no-execution") expect(commands[1]).toBe("git status --short");
				expect(result.containerCalls).toBe(commands.length - 1);
				if (scenario === "late-execution")
					expect(commands).toEqual([PIER_CAPABILITY_PROBE, "git status --short", "continue implementation"]);
				expect(result.requests).toBeGreaterThanOrEqual(scenario === "no-execution" ? 1 : 2);
				if (scenario === "failed-verification") {
					expect(commands.some((command) => command.startsWith("git add"))).toBe(false);
					expect(result.submission?.submitted).toBe(false);
				}
				if (scenario === "low-request-limit") {
					expect(result.submission?.submitted).toBe(true);
					expect(result.requests).toBe(3);
				}
				const saved = JSON.parse(readFileSync(join(output, "run-config.json"), "utf8"));
				expect(saved.tools).not.toContain("bash");
				expect(saved.tools).not.toContain("read");
				expect(saved.tools).not.toContain("subagent");
				expect(saved.executionPolicy).toBe("isolated-fixed-direct-v4");
				expect(saved.tools).not.toContain("container_repair");
				expect(result.windows).toBe(group === "C" && scenario !== "no-execution" ? 1 : 0);
				expect(result.snapshotWindows).toBe(result.windows);
				if (group === "C") expect(result.workflowModeDecision?.mode).toBe("direct");
				if (scenario === "C-risk") expect(result.workflowModeDecision?.riskLevel).toBe("high");
				if (result.windows > 0) {
					const events = readFileSync(join(output, "events.jsonl"), "utf8")
						.trim()
						.split("\n")
						.map((line) => JSON.parse(line));
					expect(events.some((event) => event.type === "notes_changed")).toBe(true);
					expect(events.some((event) => event.type === "history_query" && event.resultCount > 0)).toBe(true);
					expect(events.filter((event) => event.type === "tool_execution_end" && event.isError)).toEqual([]);
				}
			} finally {
				faux.unregister();
				rmSync(output, { recursive: true, force: true });
			}
		});
	}
});
