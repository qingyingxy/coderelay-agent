import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PIER_CAPABILITY_PROBE, runPierSession } from "../evals/context-window/pier-real-session.ts";
import { ModelRuntime, SessionManager } from "../src/index.ts";

const config = {
	provider: "faux",
	model: "repair",
	group: "C" as const,
	maxCostUsd: 1,
	maxRequests: 12,
	contextWindow: 64000,
	maxOutputTokens: 4000,
	timeoutSeconds: 30,
	pricing: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 },
};

function call(name: string, args: Record<string, string>) {
	return fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
}

const submit = () => call("container_submit", { verification_command: "check fixture", message: "Fixture" });
const handoff =
	"Modified but unverified: fixture. Failed: check fixture. Next action: repair fixture and rerun check fixture.";
const activeTools = ["container_exec", "container_submit", "history", "notes", "new_context"];

describe("Pier normal repair and submission", () => {
	let output: string;
	let faux: ReturnType<typeof registerFauxProvider>;
	let runtime: ModelRuntime;
	let commands: string[];
	let checkResults: number[];
	let commitResults: number[];

	beforeEach(async () => {
		output = mkdtempSync(join(tmpdir(), "pi-pier-repair-"));
		faux = registerFauxProvider({ models: [{ id: "repair", contextWindow: 64000, maxTokens: 4000 }] });
		const model = faux.getModel();
		runtime = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false });
		runtime.registerProvider(model.provider, { api: model.api, baseUrl: model.baseUrl, models: [model] });
		await runtime.setRuntimeApiKey(model.provider, "faux-key", { allowNetwork: false });
		commands = [];
		checkResults = [1, 0];
		commitResults = [0];
	});

	afterEach(() => {
		faux.unregister();
		rmSync(output, { recursive: true, force: true });
	});

	async function execute(command: string) {
		commands.push(command);
		if (command === PIER_CAPABILITY_PROBE) {
			return { stdout: "git=available\npython=available\n", stderr: "", return_code: 0 };
		}
		const code = command.startsWith("git diff --check")
			? (checkResults.shift() ?? 0)
			: command.startsWith("git add")
				? (commitResults.shift() ?? 0)
				: command === "broken repair"
					? 1
					: 0;
		return { stdout: code ? "fixture failure evidence" : "fixture passed", stderr: "", return_code: code };
	}

	it.each(["success", "unresolved", "repair-error", "changed-check", "commit-retry"] as const)(
		"handles %s with normal tools after failed submission",
		async (scenario) => {
			if (scenario === "unresolved" || scenario === "repair-error") checkResults = [1, 1];
			if (scenario === "commit-retry") {
				checkResults = [0, 0];
				commitResults = [1, 0];
			}
			faux.setResponses([
				call("container_exec", { command: "create broken fixture" }),
				submit(),
				(context) => {
					expect(context.tools?.map((tool) => tool.name)).toEqual(activeTools);
					expect(context.systemPrompt).not.toContain("Current execution budget:");
					expect(JSON.parse(readFileSync(join(output, "submission.json"), "utf8")).submitted).toBe(false);
					if (scenario !== "commit-retry")
						expect(commands.some((command) => command.startsWith("git add"))).toBe(false);
					return call("container_exec", {
						command: scenario === "repair-error" ? "broken repair" : "repair fixture",
					});
				},
				scenario === "changed-check"
					? call("container_submit", { verification_command: "true", message: "Weaker check" })
					: submit(),
				fauxAssistantMessage("Report actual submission outcome."),
			]);
			const result = await runPierSession(
				{ ...config, maxRequests: 5 },
				"Implement a disposable fixture.",
				output,
				runtime,
				faux.getModel(),
				execute,
			);
			const success = scenario === "success" || scenario === "commit-retry";
			expect(result.requests).toBe(5);
			expect(result.status).toBe(success ? "runtime_completed" : "submission_incomplete");
			expect(result.submission?.submitted).toBe(success);
			expect(commands).toContain(scenario === "repair-error" ? "broken repair" : "repair fixture");
			const checks = commands.filter((command) => command.startsWith("git diff --check"));
			expect(checks).toHaveLength(scenario === "changed-check" ? 1 : 2);
			expect(new Set(checks).size).toBe(1);
			const attempts = readFileSync(join(output, "submission-attempts.jsonl"), "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));
			expect(attempts).toHaveLength(checks.length);
			expect(attempts[0].submitted).toBe(false);
			expect(attempts[0].verificationCommand).toBe("check fixture");
		},
	);

	it("allows multiple repair attempts after repeated verification failures", async () => {
		checkResults = [1, 1, 0];
		faux.setResponses([
			submit(),
			call("container_exec", { command: "first repair" }),
			submit(),
			call("container_exec", { command: "second repair" }),
			submit(),
			fauxAssistantMessage("Verified and submitted."),
		]);
		const result = await runPierSession(
			config,
			"Implement a disposable fixture.",
			output,
			runtime,
			faux.getModel(),
			execute,
		);
		expect(result.status).toBe("runtime_completed");
		expect(result.submissionAttempts).toBe(3);
		expect(commands).toContain("second repair");
		expect(commands.filter((command) => command.startsWith("git add"))).toHaveLength(1);
	});

	it.each([false, true])(
		"requires fresh submission after subsequent shell execution (resubmit=%s)",
		async (resubmit) => {
			checkResults = [0, 0];
			faux.setResponses([
				submit(),
				call("container_exec", { command: "modify after submission" }),
				...(resubmit ? [submit()] : []),
				fauxAssistantMessage("Report actual status."),
			]);
			const result = await runPierSession(
				config,
				"Implement a disposable fixture.",
				output,
				runtime,
				faux.getModel(),
				execute,
			);
			expect(result.status).toBe(resubmit ? "runtime_completed" : "submission_incomplete");
			expect(commands).toContain("modify after submission");
			if (!resubmit) {
				expect(result.submission).toBeNull();
				expect(JSON.parse(readFileSync(join(output, "submission.json"), "utf8"))).toBeNull();
			}
		},
	);

	it.each([false, true])("persists a failed-check handoff across a cut (externalLimit=%s)", async (externalLimit) => {
		faux.setResponses([
			submit(),
			call("notes", {
				action: "upsert",
				category: "constraint",
				note_id: "fixture",
				content: "Preserve fixture compatibility.",
			}),
			call("new_context", { handoff }),
			(context) => {
				expect(JSON.stringify(context.messages)).toContain(handoff);
				expect(context.tools?.map((tool) => tool.name)).toEqual(activeTools);
				return call("history", { action: "search", query: "fixture failure evidence" });
			},
			call("container_exec", { command: "repair fixture" }),
			submit(),
			fauxAssistantMessage("Verified and submitted."),
		]);
		const result = await runPierSession(
			{ ...config, maxRequests: externalLimit ? 3 : 7 },
			"Implement a disposable fixture.",
			output,
			runtime,
			faux.getModel(),
			execute,
		);
		expect(result.status).toBe(externalLimit ? "budget_or_provider_stop" : "runtime_completed");
		expect(result.snapshotWindows).toBe(1);
		expect(result.requests).toBe(externalLimit ? 3 : 7);
		expect(result.submission?.submitted).toBe(!externalLimit);
		const sessionFile = readdirSync(join(output, "sessions")).find((file) => file.endsWith(".jsonl"));
		if (!sessionFile) throw new Error("Missing session evidence");
		const saved = SessionManager.open(join(output, "sessions", sessionFile));
		expect(JSON.stringify(saved.getBranch())).toContain(handoff);
		expect(JSON.stringify(saved.getBranch())).toContain("fixture failure evidence");
		expect(JSON.stringify(saved.getMemoryNotes())).toContain("Preserve fixture compatibility.");
		if (externalLimit) {
			expect(commands).not.toContain("repair fixture");
			expect(commands.some((command) => command.startsWith("git add"))).toBe(false);
		} else {
			const events = readFileSync(join(output, "events.jsonl"), "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));
			expect(events.some((event) => event.type === "history_query" && event.resultCount > 0)).toBe(true);
		}
	});

	it("does not commit when the caller's timeout cancels in-flight verification", async () => {
		checkResults = [0];
		faux.setResponses([submit(), fauxAssistantMessage("Must not be requested after cancellation.")]);
		const result = await runPierSession(
			{ ...config, timeoutSeconds: 1 },
			"Implement a disposable fixture.",
			output,
			runtime,
			faux.getModel(),
			async (command) => {
				if (command.startsWith("git diff --check")) await new Promise((resolve) => setTimeout(resolve, 1100));
				return execute(command);
			},
		);
		expect(result.status).toBe("timeout");
		expect(result.requests).toBe(1);
		expect(result.submission?.submitted).toBe(false);
		expect(commands.some((command) => command.startsWith("git add"))).toBe(false);
		expect(readFileSync(join(output, "submission-attempts.jsonl"), "utf8")).toContain("check fixture");
	});
});
