import assert from "node:assert/strict";
import { test } from "node:test";
import { selectCheckpoint } from "./prepare-controlled-checkpoint.mjs";

const entries = [
  { type: "session" },
  { id: "user", parentId: null, type: "message", message: { role: "user", content: "task" } },
  { id: "call", parentId: "user", type: "message", message: { role: "assistant", stopReason: "toolUse",
    content: [{ type: "toolCall", id: "tool", name: "container_exec", arguments: { command: "git status" } }] } },
  { id: "result", parentId: "call", type: "message", message: { role: "toolResult", toolCallId: "tool", content: [] } },
  { id: "future", parentId: "result", type: "message", message: { role: "assistant", content: "SECRET_FUTURE" } },
];
const raw = (items) => Buffer.from(items.map((item) => JSON.stringify(item)).join("\n"));

test("exports exact prefix, complete tool pairs and no future outcome", () => {
  const result = selectCheckpoint(raw(entries), "future");
  assert.equal(result.session, `${raw(entries.slice(0, -1)).toString()}\n`);
  assert.equal(result.messages.length, 3);
  assert.equal(result.commands[0].resultEntryId, "result");
  assert.ok(!JSON.stringify(result).includes("SECRET_FUTURE"));
});

test("rejects pending tools, missing boundary, branch changes and maintenance", () => {
  assert.throws(() => selectCheckpoint(raw(entries), "result"), /completed tool batch/);
  assert.throws(() => selectCheckpoint(raw(entries), "absent"), /Missing/);
  const branched = structuredClone(entries);
  branched[3].parentId = "user";
  assert.throws(() => selectCheckpoint(raw(branched), "future"), /uninterrupted branch/);
  const maintained = structuredClone(entries);
  maintained[3].type = "compaction";
  assert.throws(() => selectCheckpoint(raw(maintained), "future"), /precede maintenance/);
});

test("rejects final replies and mismatched results", () => {
  const final = structuredClone(entries);
  final[2].message.stopReason = "stop";
  assert.throws(() => selectCheckpoint(raw(final), "future"), /final or failed/);
  const mismatch = structuredClone(entries);
  mismatch[3].message.toolCallId = "other";
  assert.throws(() => selectCheckpoint(raw(mismatch), "future"), /Unmatched/);
});
