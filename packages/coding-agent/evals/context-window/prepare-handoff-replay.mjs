import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const source = process.argv[2];
const output = process.argv[3];
if (!source || !output) throw new Error("Usage: prepare-handoff-replay.mjs SESSION_JSONL OUTPUT_JSON");
const raw = readFileSync(source);
const entries = raw.toString("utf8").trim().split("\n").map((line) => JSON.parse(line));
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const messageText = (message) => typeof message.content === "string" ? message.content : message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
const calls = new Map();
const handoffs = [];
for (const entry of entries) {
  if (entry.type !== "message" || entry.message.role !== "assistant") continue;
  for (const call of entry.message.content.filter((part) => part.type === "toolCall")) {
    calls.set(call.id, call);
    if (call.name === "new_context") handoffs.push({ entryId: entry.id, callId: call.id, text: call.arguments.handoff, sha256: sha256(call.arguments.handoff) });
  }
}
const instruction = entries.find((entry) => entry.id === "3bc0d7c5");
if (!instruction || handoffs.length !== 3) throw new Error("Expected pinned CW18.14 source");
// Selected in original chronological order, without duplicating or padding output.
const selections = [
  ["a8979d11", "376805f2", "420a5099"],
  ["a8be3204", "154a7408", "0c47a2c7", "2959ba6b"],
  ["cbcdbb57", "811b9211", "2598314a", "14c1c74b", "a0462464", "1879905a", "c1664c73", "b5f95dfc"],
];
const windows = selections.map((ids, window) => ({
  cut: window + 1,
  records: ids.map((id) => {
    const entry = entries.find((item) => item.id === id);
    if (!entry || entry.message?.toolName !== "container_exec") throw new Error(`Missing source ${id}`);
    const call = calls.get(entry.message.toolCallId);
    if (!call || typeof call.arguments.command !== "string") throw new Error(`Missing command ${id}`);
    const text = messageText(entry.message);
    const position = entries.indexOf(entry);
    const lower = window === 0 ? -1 : entries.findIndex((item) => item.id === handoffs[window - 1].entryId);
    if (position <= lower || position >= entries.findIndex((item) => item.id === handoffs[window].entryId)) throw new Error("Evidence outside its original window");
    return { entryId: id, command: call.arguments.command, text, sha256: sha256(text) };
  }),
}));
const text = messageText(instruction.message);
const fixture = { provenance: { report: "CW18.14", source: source.replaceAll("\\", "/"), sourceSha256: sha256(raw), transformation: "Exact selected message texts and tool commands; no padding. Command text is inert replay data. Selection is not the complete execution trace." }, instruction: { entryId: instruction.id, text, sha256: sha256(text) }, handoffs, windows };
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify(fixture, null, 2)}\n`);
console.log(JSON.stringify({ handoffs: handoffs.length, windowBytes: windows.map((window) => Buffer.byteLength(JSON.stringify(window.records))), output }));
