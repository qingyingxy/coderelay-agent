import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { convertToLlm } from "../../src/core/messages.ts";

export interface RecordText { line: number; role: "user" | "assistant"; text: string }
export interface Question { id: string; line: number; question: string; quotes: string[] }
export interface Dataset { name: string; batches: RecordText[][]; questions: Question[] }
export interface Frozen { version: 1; inputHash: string; datasets: Dataset[] }
export interface Answer { answer: string; evidence: string[] }

export function hash(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function freeze(value: unknown): Frozen {
	assert.ok(Array.isArray(value) && value.length > 0, "Expected a nonempty dataset array");
	const names = new Set<string>();
	for (const candidate of value) {
		assert.ok(candidate && typeof candidate === "object");
		const d = candidate as Dataset;
		assert.ok(typeof d.name === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(d.name));
		assert.ok(!names.has(d.name), "Duplicate dataset"); names.add(d.name);
		assert.ok(Array.isArray(d.batches) && d.batches.length > 0);
		let previous = 0;
		for (const batch of d.batches) {
			assert.ok(Array.isArray(batch) && batch.length > 0);
			for (const r of batch) {
				assert.ok(r && Number.isSafeInteger(r.line) && r.line > previous, "Source lines must increase");
				assert.ok(r.role === "user" || r.role === "assistant");
				assert.ok(typeof r.text === "string" && r.text.trim()); previous = r.line;
			}
		}
		assert.ok(Array.isArray(d.questions) && d.questions.length > 0);
		const ids = new Set<string>();
		for (const q of d.questions) {
			assert.ok(typeof q.id === "string" && /^q[1-9][0-9]*$/.test(q.id) && !ids.has(q.id)); ids.add(q.id);
			assert.ok(typeof q.question === "string" && q.question.trim());
			assert.ok(Array.isArray(q.quotes) && q.quotes.length > 0);
			const source = d.batches.flat().find(r => r.line === q.line && r.role === "user");
			assert.ok(source, "Oracle must reference an original user message");
			assert.ok(q.quotes.every(s => typeof s === "string" && s.trim() && source.text.includes(s)), "Oracle missing from input");
		}
	}
	// Copy only schema fields: caller metadata and credentials must not become model inputs.
	const datasets = (value as Dataset[]).map(d => ({name: d.name,
		batches: d.batches.map(b => b.map(({line, role, text}) => ({line, role, text}))),
		questions: d.questions.map(({id, line, question, quotes}) => ({id, line, question, quotes: [...quotes]}))}));
	return {version: 1, inputHash: hash(datasets), datasets};
}

export function verifyFrozen(value: unknown): Frozen {
	assert.ok(value && typeof value === "object");
	const f = value as Frozen;
	assert.equal(f.version, 1);
	const verified = freeze(f.datasets);
	assert.equal(f.inputHash, verified.inputHash, "Frozen input hash mismatch");
	return verified;
}

export function visibleTexts(messages: AgentMessage[]): string[] {
	return convertToLlm(messages).flatMap(m => typeof m.content === "string" ? [m.content] :
		m.content.flatMap(b => b.type === "text" ? [b.text] : []));
}

export function historyTexts(messages: AgentMessage[]): string[] {
	return messages.flatMap(m => {
		if (m.role !== "toolResult" || m.toolName !== "history" || m.isError) return [];
		return m.content.flatMap(b => {
			if (b.type !== "text") return [];
			const data = JSON.parse(b.text) as {matches?: {snippet: string}[]; entries?: {content: string}[]};
			return [...(data.matches ?? []).map(r => r.snippet), ...(data.entries ?? []).map(r => r.content)];
		});
	});
}

export function parseAnswers(text: string, questions: Question[]): Record<string, Answer> {
	const value: unknown = JSON.parse(text);
	assert.ok(value && typeof value === "object" && !Array.isArray(value));
	const answers = value as Record<string, Answer>;
	assert.deepEqual(Object.keys(answers).sort(), questions.map(q => q.id).sort());
	for (const a of Object.values(answers)) {
		assert.ok(a && typeof a === "object");
		assert.deepEqual(Object.keys(a).sort(), ["answer", "evidence"]);
		assert.ok(typeof a.answer === "string" && a.answer.trim());
		assert.ok(Array.isArray(a.evidence) && a.evidence.every(s => typeof s === "string" && s.trim()));
	}
	return answers;
}

export function evidenceChecks(data: Dataset, answers: Record<string, Answer>, visible: string[], returned: string[]) {
	return data.questions.map(q => ({id: q.id,
		maintenanceAge: data.batches.length - data.batches.findIndex(b => b.some(r => r.line === q.line)),
		oracleVisible: q.quotes.every(s => visible.some(t => t.includes(s))),
		oracleReturned: q.quotes.every(s => returned.some(t => t.includes(s))),
		strictCitation: answers[q.id].evidence.length > 0 && answers[q.id].evidence.every(s => [...visible, ...returned].some(t => t.includes(s)))}));
}
