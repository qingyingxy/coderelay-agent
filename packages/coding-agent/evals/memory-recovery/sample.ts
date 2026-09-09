import { type Dataset, freeze } from "./data.ts";

export function sample() {
	let line = 0;
	const batches = Array.from({length: 5}, (_, stage) => Array.from({length: 24}, (_, i) => ({
		line: ++line, role: i % 2 === 0 ? "user" as const : "assistant" as const,
		text: stage === 0 && i === 0 ? "Synthetic requirement: archive retention is 17 days." :
			`Synthetic stage ${stage + 1} record ${i + 1}. ${"The demonstration parcel ledger contains no personal records. ".repeat(45)}`,
	})));
	const data: Dataset = {name: "synthetic-ledger", batches, questions: [
		{id: "q1", line: 1, question: "What archive retention period did the user specify?", quotes: ["archive retention is 17 days"]},
	]};
	return freeze([data]);
}
