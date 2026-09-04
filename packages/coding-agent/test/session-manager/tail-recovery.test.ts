import { appendFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";

describe("SessionManager truncated tail recovery", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `session-tail-recovery-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("separates the first recovered append from an unterminated malformed line", () => {
		const original = SessionManager.create(tempDir, tempDir);
		original.appendMessage({ role: "user", content: "before crash", timestamp: 1 });
		original.appendMessage(fauxAssistantMessage("durable answer"));
		const sessionFile = original.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persisted Session JSONL");
		const malformedTail = '{"type":"context_window","id":"partial"';
		appendFileSync(sessionFile, malformedTail);

		const recovered = SessionManager.open(sessionFile, tempDir);
		recovered.appendMessage({ role: "user", content: "after recovery", timestamp: 2 });

		const physicalContent = readFileSync(sessionFile, "utf8");
		expect(physicalContent).toContain(`${malformedTail}\n{`);
		const reopened = SessionManager.open(sessionFile, tempDir);
		expect(reopened.getBranch().at(-1)).toMatchObject({
			type: "message",
			message: { role: "user", content: "after recovery" },
		});
	});

	it("separates an append from a valid final record without a trailing newline", () => {
		const original = SessionManager.create(tempDir, tempDir);
		original.appendMessage({ role: "user", content: "before close", timestamp: 1 });
		original.appendMessage(fauxAssistantMessage("valid final record"));
		const sessionFile = original.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persisted Session JSONL");
		const withoutNewline = readFileSync(sessionFile, "utf8").trimEnd();
		rmSync(sessionFile);
		appendFileSync(sessionFile, withoutNewline);

		const recovered = SessionManager.open(sessionFile, tempDir);
		recovered.appendSessionInfo("continued session");

		const reopened = SessionManager.open(sessionFile, tempDir);
		expect(reopened.getSessionName()).toBe("continued session");
	});
});
