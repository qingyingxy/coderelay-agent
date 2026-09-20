/** Free normal repair/submission test using the session runner and real Pier bridge. */
import { strict as assert } from "node:assert";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { ModelRuntime } from "../../src/index.ts";
import { runPierSession, type ContainerReply } from "./pier-real-session.ts";

const output = process.argv[2];
if (!output || process.argv.length !== 3) throw new Error("Only an output directory is accepted; no paid model configuration");
const reader = createInterface({ input: process.stdin });
const lines = reader[Symbol.asyncIterator]();

async function execute(command: string): Promise<ContainerReply> {
	process.stdout.write(`${JSON.stringify({ type: "exec", command })}\n`);
	const line = await lines.next();
	if (line.done) throw new Error("Bridge closed");
	const reply: unknown = JSON.parse(line.value);
	if (!reply || typeof reply !== "object" || !("stdout" in reply) || typeof reply.stdout !== "string" ||
		!("stderr" in reply) || typeof reply.stderr !== "string" || !("return_code" in reply) || !Number.isInteger(reply.return_code)) {
		throw new Error("Invalid bridge reply");
	}
	return reply as ContainerReply;
}

const faux = registerFauxProvider({ models: [{ id: "submission-smoke", contextWindow: 64000, maxTokens: 4000 }] });
try {
	const initial = await lines.next();
	if (initial.done) throw new Error("Missing instruction");
	const input: unknown = JSON.parse(initial.value);
	if (!input || typeof input !== "object" || !("instruction" in input) || typeof input.instruction !== "string") throw new Error("Invalid instruction");
	const baseline = await execute("git rev-parse HEAD && test ! -e /tests/test.sh && test ! -S /var/run/docker.sock");
	assert.equal(baseline.return_code, 0);
	const baseHead = baseline.stdout.trim();
	let failedVerificationPreservedHead = false;
	let normalToolsAfterRepair = false;
	let normalToolsAfterFailure = false;
	let capabilitiesDisclosed = false;
	const verificationCommand = 'test "$(cat PI_TRANSPORT_SMOKE.txt)" = "Pi SDK submission smoke only. No feature implementation."';
	const model = faux.getModel();
	const runtime = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false });
	runtime.registerProvider(model.provider, { api: model.api, baseUrl: model.baseUrl, models: [model] });
	await runtime.setRuntimeApiKey(model.provider, "faux-key", { allowNetwork: false });
	faux.setResponses([
		(context) => {
			const probe = JSON.parse(readFileSync(join(output, "capabilities.json"), "utf8"));
			assert.ok(context.systemPrompt?.includes(probe.stdout));
			assert.ok(probe.stdout.includes("git=available"));
			capabilitiesDisclosed = true;
			return fauxAssistantMessage(fauxToolCall("container_exec", {
				command: "printf 'Broken fixture.\\n' > PI_TRANSPORT_SMOKE.txt",
			}), { stopReason: "toolUse" });
		},
		fauxAssistantMessage(fauxToolCall("container_submit", {
			verification_command: verificationCommand, message: "Must not commit failing verification",
		}), { stopReason: "toolUse" }),
		async (context) => {
			const failed = JSON.parse(readFileSync(join(output, "submission.json"), "utf8"));
			assert.equal(failed.submitted, false);
			assert.notEqual(failed.verification.return_code, 0);
			assert.equal(failed.commit, undefined);
			const unchanged = await execute("git rev-parse HEAD && test -f PI_TRANSPORT_SMOKE.txt");
			assert.equal(unchanged.return_code, 0);
			assert.equal(unchanged.stdout.trim(), baseHead);
			failedVerificationPreservedHead = true;
			assert.deepEqual(context.tools?.map((tool) => tool.name), ["container_exec", "container_submit", "history", "notes", "new_context"]);
			assert.ok(!context.systemPrompt?.includes("Current execution budget:"));
			normalToolsAfterFailure = true;
			return fauxAssistantMessage(fauxToolCall("container_exec", {
				command: "printf 'Pi SDK submission smoke only. No feature implementation.\\n' > PI_TRANSPORT_SMOKE.txt",
			}), { stopReason: "toolUse" });
		},
		(context) => {
			assert.deepEqual(context.tools?.map((tool) => tool.name), ["container_exec", "container_submit", "history", "notes", "new_context"]);
			normalToolsAfterRepair = true;
			return fauxAssistantMessage(fauxToolCall("container_submit", {
				verification_command: verificationCommand,
				message: "Transport smoke's fixture",
			}), { stopReason: "toolUse" });
		},
		fauxAssistantMessage("Fixture verified and submitted. No feature implementation or official success claimed."),
	]);
	const result = await runPierSession({ provider: model.provider, model: model.id, group: "C", maxCostUsd: 1,
		maxRequests: 5, maxOutputTokens: 4000, contextWindow: 64000, timeoutSeconds: 120,
		pricing: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 } }, input.instruction, output, runtime, model, execute);
	const finalHead = await execute("git rev-parse HEAD && git log -1 --format=%s && git status --porcelain");
	assert.equal(finalHead.return_code, 0);
	const finalLines = finalHead.stdout.trim().split(/\r?\n/);
	const cleanCommittedFixture = finalLines.length === 2 && finalLines[0] !== baseHead && finalLines[1] === "Transport smoke's fixture";
	const passed = result.status === "runtime_completed" && result.requests === 5 && result.submission?.submitted === true &&
		result.submissionAttempts === 2 && normalToolsAfterFailure &&
		failedVerificationPreservedHead && normalToolsAfterRepair && capabilitiesDisclosed && cleanCommittedFixture;
	writeFileSync(join(output, "sdk-result.json"), JSON.stringify({ ...result, passed, provider: "faux", costUsd: 0,
		qualityEvaluation: false, scenario: "submission-v4", failedVerificationPreservedHead, normalToolsAfterRepair, normalToolsAfterFailure,
		capabilitiesDisclosed, cleanCommittedFixture, baseHead, finalHead: finalLines[0] }, null, 2));
	assert.ok(passed, "Submission smoke did not satisfy all checks");
	process.stdout.write(`${JSON.stringify({ type: "complete" })}\n`);
} finally {
	faux.unregister();
	reader.close();
}
