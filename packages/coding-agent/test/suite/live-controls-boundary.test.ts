import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { expect, it } from "vitest";
import { liveBoundaryExtension, liveToolViolation } from "../../evals/live-controls/tool-boundary.ts";
import { createHarness } from "./harness.ts";

it("rejects traversal, sibling arms, links, protected writes and shell dispatch before side effects", async () => {
	const harness = await createHarness();
	try {
		const workspace = join(harness.tempDir, "arm");
		const business = join(workspace, "Tools/LiveCommentBridge/ballfight_live_bridge");
		const other = join(harness.tempDir, "other");
		mkdirSync(business, { recursive: true });
		mkdirSync(other);
		writeFileSync(join(other, "answer.txt"), "hidden");
		symlinkSync(other, join(business, "escape"), "junction");
		const policy = { workspace, dependencyRoots: [], writable: true };
		for (const path of [
			"@../other/answer.txt",
			"~/.pi/agent/auth.json",
			"../other/answer.txt",
			join(other, "answer.txt"),
			`${workspace}-sibling/answer.txt`,
			join(business, "escape/answer.txt"),
		]) {
			expect(liveToolViolation(policy, "read", { path })).toBeTruthy();
			expect(liveToolViolation(policy, "write", { path })).toBeTruthy();
		}
		for (const path of [
			"Tools/LiveCommentBridge/tests/test_router.py",
			"Tools/LiveCommentBridge/desktop/package.json",
			"Tools/LiveCommentBridge/desktop/node_modules/x.js",
			"Tools/LiveOcrBridge/x.py",
			"Tools/LiveCommentBridge/desktop/src/x.ts:stream",
		]) {
			expect(liveToolViolation(policy, "write", { path })).toBeTruthy();
		}
		expect(
			liveToolViolation(policy, "read", { path: "Tools/LiveCommentBridge/tests/test_router.py" }),
		).toBeUndefined();
		expect(liveToolViolation(policy, "write", { path: join(business, "new.py") })).toBeUndefined();
		expect(
			liveToolViolation({ ...policy, writable: false }, "write", { path: join(business, "new.py") }),
		).toBeTruthy();
		for (const command of [
			"cat ../other/answer.txt",
			"python -c print(1)",
			"node --test",
			"echo ok; cat ../other/answer.txt",
		])
			expect(liveToolViolation(policy, "bash", { command })).toBeTruthy();
	} finally {
		harness.cleanup();
	}
});

it("enforces the boundary in the actual agent tool-call pipeline", async () => {
	const workspace = mkdtempSync(join(tmpdir(), "live-boundary-"));
	const harness = await createHarness({
		initialActiveToolNames: ["read", "write", "bash"],
		extensionFactories: [(pi) => liveBoundaryExtension({ workspace, dependencyRoots: [], writable: true })(pi)],
	});
	try {
		// The extension resolves this fixed directory at registration, before any model call.
		const source = join(workspace, "Tools/LiveCommentBridge/ballfight_live_bridge/a.py");
		mkdirSync(join(workspace, "Tools/LiveCommentBridge/ballfight_live_bridge"), { recursive: true });
		writeFileSync(source, "original");
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("read", { path: source }), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("write", { path: source, content: "allowed" }), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("read", { path: "../outside.txt" }), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("write", { path: join(workspace, "package.json"), content: "bad" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage(fauxToolCall("bash", { command: "echo forbidden" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("Done"),
		]);
		await harness.session.prompt("Exercise boundary");
		const outputs = harness.session.messages.filter((message) => message.role === "toolResult");
		expect(outputs).toHaveLength(5);
		expect(JSON.stringify(outputs[0])).toContain("original");
		for (const output of outputs.slice(2)) expect(JSON.stringify(output)).toContain("Evaluation boundary");
		expect(readFileSync(source, "utf8")).toBe("allowed");
	} finally {
		harness.cleanup();
		rmSync(workspace, { recursive: true, force: true });
	}
});
