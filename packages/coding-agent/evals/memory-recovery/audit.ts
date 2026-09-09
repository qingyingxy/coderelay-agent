import assert from "node:assert/strict";
import type { Frozen } from "./data.ts";
import { verifyFrozen } from "./data.ts";
import type { SessionResult } from "./runner.ts";

export interface Judgment { correct: boolean; note: string }
export interface RunRecord {
	inputHash: string; group: "A" | "C"; offline: boolean; results: SessionResult[];
	knownUsd: number; unknownReserveUsd: number;
}

export function audit(input: Frozen, record: RunRecord, judgments: Record<string, Record<string, Judgment>>) {
	const frozen = verifyFrozen(input);
	assert.equal(record.inputHash, frozen.inputHash, "Cannot mix different inputs");
	assert.ok([record.knownUsd, record.unknownReserveUsd].every(n => Number.isFinite(n) && n >= 0));
	assert.ok(new Set(record.results.map(r => r.name)).size === record.results.length, "Duplicate results");
	for (const r of record.results) assert.ok(frozen.datasets.some(d => d.name === r.name), "Unknown session");
	for (const name of Object.keys(judgments)) assert.ok(record.results.some(r => r.name === name && r.completed), "Do not grade failed/unattempted sessions");
	const rows = frozen.datasets.map(d => {
		const result = record.results.find(r => r.name === d.name);
		if (!result?.completed) return {name: d.name, status: result ? "incomplete" : "unattempted", correct: 0, graded: 0, unanswered: d.questions.length};
		assert.equal(result.maintenanceCompleted, d.batches.length);
		assert.ok(result.answers);
		const grades = judgments[d.name]; assert.ok(grades, "Manual semantic judgments required");
		assert.deepEqual(Object.keys(grades).sort(), d.questions.map(q => q.id).sort());
		for (const q of d.questions) {
			assert.ok(result.answers[q.id]);
			assert.ok(typeof grades[q.id].correct === "boolean" && typeof grades[q.id].note === "string" && grades[q.id].note.trim());
		}
		return {name: d.name, status: "completed", correct: Object.values(grades).filter(g => g.correct).length, graded: d.questions.length, unanswered: 0};
	});
	return {group: record.group, offline: record.offline, inputHash: frozen.inputHash, rows,
		correct: rows.reduce((n, r) => n + r.correct, 0), graded: rows.reduce((n, r) => n + r.graded, 0),
		unanswered: rows.reduce((n, r) => n + r.unanswered, 0), completed: rows.filter(r => r.status === "completed").length,
		knownUsd: record.offline ? 0 : record.knownUsd, unknownReserveUsd: record.offline ? 0 : record.unknownReserveUsd,
		costNote: record.offline ? "Faux usage is not real spending" : "Estimated model usage; unknown reserve is not a confirmed charge"};
}
