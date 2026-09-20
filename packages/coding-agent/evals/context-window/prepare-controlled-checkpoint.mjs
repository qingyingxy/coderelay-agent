import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export function selectCheckpoint(raw, beforeEntryId) {
  const lines = raw.toString("utf8").trimEnd().split("\n");
  const entries = lines.map((line) => JSON.parse(line));
  const position = entries.findIndex((entry) => entry.id === beforeEntryId);
  if (position < 1) throw new Error("Missing checkpoint boundary");
  const prefix = entries.slice(0, position);
  const pending = new Map();
  const commands = [];
  let previousId = null;
  for (const entry of prefix) {
    if (entry.type === "session") continue;
    if (entry.parentId !== previousId) throw new Error("Prefix must be one uninterrupted branch");
    previousId = entry.id;
    if (["context_window", "compaction", "branch_summary"].includes(entry.type)) {
      throw new Error("Checkpoint must precede maintenance");
    }
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message.role === "assistant") {
      if (pending.size) throw new Error("Assistant preceded pending tool results");
      if (message.stopReason !== "toolUse") throw new Error("Prefix must not contain a final or failed assistant reply");
      for (const call of message.content.filter((part) => part.type === "toolCall")) {
        if (call.name !== "container_exec") throw new Error("Only repository execution is supported in the shared prefix");
        if (pending.has(call.id)) throw new Error("Duplicate tool call");
        pending.set(call.id, { entryId: entry.id, callId: call.id, command: call.arguments.command });
      }
    } else if (message.role === "toolResult") {
      const call = pending.get(message.toolCallId);
      if (!call) throw new Error("Unmatched tool result");
      commands.push({ ...call, resultEntryId: entry.id });
      pending.delete(message.toolCallId);
    }
  }
  if (pending.size || commands.length === 0) throw new Error("Checkpoint must follow a completed tool batch");
  const messages = prefix.filter((entry) => entry.type === "message").map((entry) => entry.message);
  if (messages.filter((message) => message.role === "user").length !== 1) throw new Error("Expected one original task instruction");
  return { session: `${lines.slice(0, position).join("\n")}\n`, messages, commands, lastEntryId: previousId };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [source, beforeEntryId, output] = process.argv.slice(2);
  if (!source || !beforeEntryId || !output) throw new Error("Usage: prepare-controlled-checkpoint.mjs SESSION BEFORE_ENTRY OUTPUT");
  if (existsSync(output)) throw new Error("Output must be fresh");
  const raw = readFileSync(source);
  const checkpoint = selectCheckpoint(raw, beforeEntryId);
  const hash = (value) => createHash("sha256").update(value).digest("hex");
  mkdirSync(output, { recursive: true });
  for (const arm of ["A", "C"]) {
    mkdirSync(join(output, arm));
    writeFileSync(join(output, arm, "session.jsonl"), checkpoint.session);
    writeFileSync(join(output, arm, "messages.json"), `${JSON.stringify(checkpoint.messages)}\n`);
  }
  const manifest = { source, sourceSha256: hash(raw), beforeEntryId, lastEntryId: checkpoint.lastEntryId,
    sessionSha256: hash(checkpoint.session), messagesSha256: hash(JSON.stringify(checkpoint.messages)),
    messageCount: checkpoint.messages.length, commands: checkpoint.commands,
    commandExecution: "Inert audit data; never executed by this exporter", contextWindow: 128000,
    futureContentIncluded: false, maintenanceGenerated: false, paidCalls: 0 };
  writeFileSync(join(output, "checkpoint.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(JSON.stringify({ output, messages: manifest.messageCount, commands: manifest.commands.length,
    prefixBytes: Buffer.byteLength(checkpoint.session), sessionSha256: manifest.sessionSha256, paidCalls: 0 }));
}
