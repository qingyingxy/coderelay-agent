import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { audit, type RunRecord } from "../evals/memory-recovery/audit.ts";
import { PierBudget, parsePierRunConfig } from "../evals/memory-recovery/budget.ts";
import { freeze, parseAnswers, verifyFrozen } from "../evals/memory-recovery/data.ts";
import { run } from "../evals/memory-recovery/runner.ts";
import { sample } from "../evals/memory-recovery/sample.ts";

describe("historical memory evaluation", () => {
	it("blocks unaffordable requests and retains unknown usage without retrying", async () => {
		const faux = registerFauxProvider();
		try {
			const config = parsePierRunConfig({
				provider: "faux",
				model: "test",
				group: "A",
				maxCostUsd: 1,
				maxRequests: 10,
				contextWindow: 128000,
				maxOutputTokens: 4000,
				timeoutSeconds: 120,
				pricing: { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 2.5 },
			});
			let calls = 0;
			const dispatch: StreamFn = () => {
				calls++;
				throw new Error("simulated transport failure");
			};
			const low = new PierBudget({ ...config, maxCostUsd: 0.001 }, () => {});
			await (await low.wrap(dispatch)(faux.getModel(), { messages: [] })).result();
			expect(calls).toBe(0);
			const failed = new PierBudget(config, () => {});
			const wrapped = failed.wrap(dispatch);
			await (await wrapped(faux.getModel(), { messages: [] })).result();
			await (await wrapped(faux.getModel(), { messages: [] })).result();
			expect(calls).toBe(1);
			expect(failed.accountedUsd).toBeCloseTo(0.368);
			expect(failed.receipts[0].status).toBe("unknown");
			expect(() => parsePierRunConfig({ ...config, apiKey: "not-a-real-key" })).toThrow("Unknown configuration");
		} finally {
			faux.unregister();
		}
	});
	it("accounts cache usage and forces the configured output cap and zero retries", async () => {
		const faux = registerFauxProvider();
		try {
			const config = parsePierRunConfig({
				provider: "faux",
				model: "test",
				group: "C",
				maxCostUsd: 1,
				maxRequests: 10,
				contextWindow: 128000,
				maxOutputTokens: 4000,
				timeoutSeconds: 120,
				pricing: { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 2.5 },
			});
			const budget = new PierBudget(config, () => {});
			const dispatch: StreamFn = (_m, _c, options) => {
				expect(options?.maxTokens).toBe(4000);
				expect(options?.maxRetries).toBe(0);
				const message = fauxAssistantMessage("fixture");
				message.usage.input = 100;
				message.usage.output = 10;
				message.usage.cacheRead = 200;
				message.usage.cacheWrite = 30;
				const stream = createAssistantMessageEventStream();
				stream.push({ type: "done", reason: "stop", message });
				stream.end(message);
				return stream;
			};
			await (await budget.wrap(dispatch)(faux.getModel(), { messages: [] }, { maxTokens: 9000 })).result();
			expect(budget.accountedUsd).toBeCloseTo(0.000435);
			expect(budget.receipts[0].status).toBe("completed");
		} finally {
			faux.unregister();
		}
	});
	it("freezes synthetic input and rejects tampering, traversal, duplicates and missing user evidence", () => {
		const frozen = sample();
		expect(verifyFrozen(frozen)).toEqual(frozen);
		const mutated = structuredClone(frozen);
		mutated.datasets[0].batches[0][0].text += "changed";
		expect(() => verifyFrozen(mutated)).toThrow("hash mismatch");
		const d = frozen.datasets[0];
		expect(() => freeze([{ ...d, name: "../private" }])).toThrow();
		expect(() => freeze([d, d])).toThrow("Duplicate");
		expect(() => freeze([{ ...d, questions: [{ ...d.questions[0], quotes: ["missing"] }] }])).toThrow("Oracle");
		expect(() => freeze([{ ...d, questions: [{ ...d.questions[0], line: 2 }] }])).toThrow("user message");
		expect(() => parseAnswers('{"q1":{"answer":"unknown","evidence":[]},"extra":{}}', d.questions)).toThrow();
	});
	it("does not count interrupted or unattempted questions as incorrect and excludes faux spending", () => {
		const f = sample();
		const record: RunRecord = {
			inputHash: f.inputHash,
			group: "A",
			offline: true,
			knownUsd: 1,
			unknownReserveUsd: 0.3,
			results: [{ name: f.datasets[0].name, completed: false, maintenanceCompleted: 2, plannedFacts: 1 }],
		};
		expect(audit(f, record, {})).toMatchObject({
			graded: 0,
			unanswered: 1,
			completed: 0,
			knownUsd: 0,
			unknownReserveUsd: 0,
		});
		expect(() => audit(f, record, { [f.datasets[0].name]: { q1: { correct: false, note: "timeout" } } })).toThrow(
			"Do not grade",
		);
	});
	for (const group of ["A", "C"] as const) {
		it(`runs ${group} without network, verifies five real maintenance entries and preserves evidence`, async () => {
			const parent = mkdtempSync(join(tmpdir(), "pi-memory-recovery-"));
			try {
				const f = sample();
				const output = join(parent, "run");
				const results = await run(f, { group, output });
				expect(results[0].error).toBeUndefined();
				expect(results[0]).toMatchObject({ completed: true, maintenanceCompleted: 5 });
				if (group === "C") expect(results[0].evidence?.[0].oracleReturned).toBe(true);
				const record = JSON.parse(readFileSync(join(output, "run.json"), "utf8")) as RunRecord;
				expect(
					audit(f, record, {
						"synthetic-ledger": {
							q1: { correct: false, note: "Faux answer intentionally unknown; not a quality score" },
						},
					}),
				).toMatchObject({ graded: 1, correct: 0, knownUsd: 0 });
				await expect(run(f, { group, output })).rejects.toThrow();
			} finally {
				rmSync(parent, { recursive: true, force: true });
			}
		}, 60000);
	}
});
