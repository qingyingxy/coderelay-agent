/** Free checkpoint/SDK plumbing probe. Scripted text is not a quality evaluation. */
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import type { SessionEntry } from "../../src/core/session-manager.ts";
import { compact, prepareCompaction } from "../../src/core/compaction/compaction.ts";
import { createHarness, getMessageText } from "../../test/suite/harness.ts";

const [checkpoint, output] = process.argv.slice(2);
if (!checkpoint || !output || existsSync(output)) throw new Error("Pass checkpoint and fresh output directory");
mkdirSync(output, { recursive: true });
const manifest = JSON.parse(readFileSync(join(checkpoint, "checkpoint.json"), "utf8")) as { sessionSha256: string };
const rows = [];
function canonicalMessages(messages: readonly AgentMessage[]): string {
  return JSON.stringify(messages.map((message) => ({ role: message.role, content: message.content,
    ...(message.role === "toolResult" ? { toolCallId: message.toolCallId, toolName: message.toolName } : {}) })));
}

for (const arm of ["A", "C"] as const) {
  const raw = readFileSync(join(checkpoint, arm, "session.jsonl"));
  assert.equal(createHash("sha256").update(raw).digest("hex"), manifest.sessionSha256);
  const entries = raw.toString("utf8").trim().split("\n").map((line) => JSON.parse(line) as SessionEntry);
  const messages = entries.flatMap((entry) => entry.type === "message" ? [entry.message] : []);
  const original = messages.find((message) => message.role === "user");
  assert.ok(original);
  const assistants = messages.filter((message) => message.role === "assistant");
  const results = messages.filter((message) => message.role === "toolResult");
  const calls = assistants.flatMap((message) => message.content.filter((part) => part.type === "toolCall"));
  assert.equal(results.length, calls.length);
  let replayed = 0;
  let executions = 0;
  let boundaryReached = false;
  let beforeSha256 = "";
  let maintenanceRequests = 0;
  let continuationStart = 0;
  let executingWorkflowAtBoundary = false;
  const tool: AgentTool = {
    name: "container_exec", label: "Inert probe", description: "Scripted probe; does not execute shell commands",
    parameters: Type.Object({ command: Type.String() }),
    execute: async (callId, params) => {
      if (replayed < results.length) {
        const result = results[replayed];
        const call = calls[replayed];
        assert.equal(callId, call.id);
        assert.equal(result.toolCallId, call.id);
        assert.equal(params.command, call.arguments.command);
        replayed++;
        return { content: result.content, details: result.details };
      }
      assert.equal(params.command, "INERT_CONTINUATION_PROBE");
      executions++;
      return { content: [{ type: "text", text: "Scripted continuation reached; no real task work performed." }], details: {} };
    },
  };
  const harness = await createHarness({
    models: [{ id: "controlled-free", contextWindow: 128000, maxTokens: 4000 }],
    tools: [tool], initialActiveToolNames: ["container_exec", "history", ...(arm === "C" ? ["new_context"] : [])],
    settings: { compaction: { enabled: true, keepRecentTokens: 20000, reserveTokens: 16000 },
      contextManagement: { mode: arm === "A" ? "summary" : "windowed", reserveTokens: 16000 } },
  });
  try {
    if (arm === "C") harness.session.enableWorkflowTracking("direct");
    const previousRefresh = harness.session.agent.prepareNextTurnWithContext;
    harness.session.agent.prepareNextTurnWithContext = async (turn, signal) => {
      if (!boundaryReached && replayed === results.length) {
        boundaryReached = true;
        const before = canonicalMessages(harness.session.messages);
        assert.equal(before, canonicalMessages(messages), "Replay changed task-visible prefix");
        beforeSha256 = createHash("sha256").update(before).digest("hex");
        writeFileSync(join(output, `${arm}-before.json`), before);
        assert.equal(harness.session.agent.state.pendingToolCalls.size, 0);
        if (arm === "A") {
          // Manual AgentSession.compact aborts an active run. At this settled tool
          // boundary use the same compaction primitives without ending the run.
          const settings = harness.settingsManager.getCompactionSettings();
          const preparation = prepareCompaction(harness.sessionManager.getBranch(), settings);
          assert.ok(preparation);
          const started = harness.faux.state.callCount;
          const result = await compact(preparation, harness.getModel(), "faux-key", undefined,
            undefined, signal, "off", harness.session.agent.streamFunction);
          maintenanceRequests = harness.faux.state.callCount - started;
          harness.sessionManager.appendCompaction(result.summary, result.firstKeptEntryId,
            result.tokensBefore, result.details, false, result.usage);
          harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
          const refreshed = await previousRefresh?.({ ...turn,
            context: { ...turn.context, messages: harness.session.messages.slice() } }, signal);
          return { ...refreshed, context: { ...(refreshed?.context ?? turn.context),
            messages: harness.session.messages.slice() } };
        }
        executingWorkflowAtBoundary = harness.session.getWorkflowView()?.workflow.status === "executing";
        assert.ok(executingWorkflowAtBoundary);
      }
      return await previousRefresh?.(turn, signal);
    };
    const summary = fauxAssistantMessage(
      "SCRIPTED SUMMARY FOR PLUMBING ONLY. Repository reading is recorded; task implementation remains unfinished.");
    const handoff = "Repository reading completed on rolling-window-min-max-median-quantile. No source changes yet. Implementation and verification remain unfinished. Next: implement the original requirements, then verify.";
    harness.setResponses([
      ...assistants,
      ...(arm === "A" ? [summary] : [() => {
        maintenanceRequests++;
        return fauxAssistantMessage(fauxToolCall("new_context", { handoff }), { stopReason: "toolUse" });
      }]),
      () => {
        assert.ok(boundaryReached);
        continuationStart = harness.faux.state.callCount - 1;
        const branch = harness.sessionManager.getBranch();
        if (arm === "C") {
          const cuts = branch.filter((entry) => entry.type === "context_window");
          assert.equal(cuts.length, 1);
          const cut = cuts[0];
          assert.ok(cut.snapshotEntryId && cut.workflowId);
          assert.notEqual(cut.contextSeed.workflowSnapshotSequence, undefined);
          assert.equal(harness.sessionManager.getEntry(cut.snapshotEntryId)?.type, "custom");
          assert.ok(cut.contextSeed.content.includes(handoff));
          assert.ok(!cut.contextSeed.content.includes("No active Workflow Snapshot"));
          assert.equal(harness.session.getWorkflowView()?.workflow.status, "executing");
        } else assert.equal(branch.filter((entry) => entry.type === "compaction").length, 1);
        writeFileSync(join(output, `${arm}-after.json`), JSON.stringify(harness.session.messages, null, 2));
        return fauxAssistantMessage(fauxToolCall("container_exec", { command: "INERT_CONTINUATION_PROBE" }), { stopReason: "toolUse" });
      },
      fauxAssistantMessage("Scripted probe finished; no functional result claimed."),
    ]);
    await harness.session.prompt(getMessageText(original), { expandPromptTemplates: false,
      ...(arm === "C" ? { isolatedDirectExecution: { reason: "Free cached-prefix probe with inert tools only" } } : {}) });
    assert.equal(executions, 1);
    assert.equal(replayed, results.length);
    assert.equal(harness.getPendingResponseCount(), 0);
    const branch = harness.sessionManager.getBranch();
    assert.equal(branch.filter((entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.isError).length, 0);
    const cut = branch.find((entry) => entry.type === "context_window");
    writeFileSync(join(output, `${arm}-session.json`), JSON.stringify(branch, null, 2));
    rows.push({ arm, beforeSha256, replayedToolResults: replayed, replayModelCalls: assistants.length,
      executingWorkflowAtBoundary, workflowStatus: harness.session.getWorkflowView()?.workflow.status ?? null,
      maintenanceRequests, continuationRequests: harness.faux.state.callCount - continuationStart,
      compactions: branch.filter((entry) => entry.type === "compaction").length,
      cuts: branch.filter((entry) => entry.type === "context_window").length,
      snapshotBacked: Boolean(cut?.snapshotEntryId && cut.workflowId),
      snapshotEntryId: cut?.snapshotEntryId, workflowId: cut?.workflowId,
      postBoundaryProbeCalls: executions,
      afterBytes: Buffer.byteLength(readFileSync(join(output, `${arm}-after.json`))),
      fallbackSeed: readFileSync(join(output, `${arm}-after.json`), "utf8").includes("No active Workflow Snapshot"),
      lastReply: getMessageText(harness.session.messages.at(-1)),
    });
  } finally { harness.cleanup(); }
}
assert.equal(rows[0].beforeSha256, rows[1].beforeSha256);
const report = { identicalInputMessages: true, paidCalls: 0, scriptedProbePassed: true,
  fullStrategyReady: rows[1].snapshotBacked, rows,
  limitation: "Live Workflow continuation plumbing verified with cached responses and inert tools. Scripted summary/handoff are not model quality evidence. No real repository continuation or paid Pier dispatch was performed." };
writeFileSync(join(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
