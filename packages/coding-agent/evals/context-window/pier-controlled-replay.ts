import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, type ToolCall, type ToolResultMessage, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { AgentSession, ModelRuntime, SessionEntry, SessionManager } from "../../src/index.ts";
import { compact, prepareCompaction } from "../../src/core/compaction/compaction.ts";

function canonical(messages: readonly AgentMessage[]): string {
  return JSON.stringify(messages.map((message) => ({ role: message.role, content: "content" in message ? message.content : undefined,
    ...(message.role === "toolResult" ? { toolCallId: message.toolCallId, toolName: message.toolName } : {}) })));
}

/** Evaluation-only cached prefix; never executes a recorded command. */
export class PierControlledReplay {
  readonly messages: AgentMessage[];
  readonly assistants: AssistantMessage[];
  readonly results: ToolResultMessage<unknown>[];
  readonly calls: ToolCall[];
  readonly group: "A" | "C";
  readonly output: string;
  readonly restoreCommand: string;
  replayRequests = 0;
  replayResults = 0;
  reached = false;
  continued = false;
  beforeSha256: string | undefined;

  constructor(checkpoint: string, group: "A" | "C", output: string, instruction: string) {
    this.group = group;
    this.output = output;
    const repository = JSON.parse(readFileSync(join(checkpoint, "repository.json"), "utf8")) as { base: string; tree: string; branch: string };
    assert.match(repository.base, /^[a-f0-9]{40}$/);
    assert.match(repository.tree, /^[a-f0-9]{40}$/);
    assert.match(repository.branch, /^[a-zA-Z0-9][a-zA-Z0-9_/-]*$/);
    this.restoreCommand = `git rev-parse HEAD && test "$(git rev-parse HEAD)" = '${repository.base}' && test "$(git rev-parse HEAD^{tree})" = '${repository.tree}' && test -z "$(git status --porcelain)" && test ! -e /tests/test.sh && test ! -S /var/run/docker.sock && git switch -c '${repository.branch}' && git status --porcelain`;
    const manifest = JSON.parse(readFileSync(join(checkpoint, "checkpoint.json"), "utf8")) as { sessionSha256: string };
    const raw = readFileSync(join(checkpoint, group, "session.jsonl"));
    assert.equal(createHash("sha256").update(raw).digest("hex"), manifest.sessionSha256);
    const entries = raw.toString("utf8").trim().split("\n").map((line) => JSON.parse(line) as SessionEntry);
    assert.ok(!entries.some((entry) => ["compaction", "context_window"].includes(entry.type)));
    this.messages = entries.flatMap((entry) => entry.type === "message" ? [entry.message] : []);
    const users = this.messages.filter((message) => message.role === "user");
    assert.equal(users.length, 1);
    const content = users[0].content;
    assert.equal(typeof content === "string" ? content : content.filter((part) => part.type === "text").map((part) => part.text).join("\n"), instruction);
    this.assistants = this.messages.filter((message) => message.role === "assistant");
    assert.ok(this.assistants.every((message) => message.stopReason === "toolUse"));
    this.results = this.messages.filter((message) => message.role === "toolResult");
    this.calls = this.assistants.flatMap((message) => message.content.filter((part) => part.type === "toolCall"));
    assert.ok(this.calls.length > 0 && this.calls.every((call) => call.name === "container_exec"));
    assert.equal(this.calls.length, this.results.length);
  }

  toolResult(id: string, command: string) {
    if (this.replayResults === this.results.length) {
      assert.ok(this.continued, "Repository execution before controlled maintenance");
      return undefined;
    }
    const call = this.calls[this.replayResults];
    const result = this.results[this.replayResults];
    assert.equal(id, call.id);
    assert.equal(result.toolCallId, id);
    assert.equal(command, call.arguments.command);
    this.replayResults++;
    return { content: result.content, details: result.details };
  }

  install(session: AgentSession, manager: SessionManager, runtime: ModelRuntime) {
    const dispatch = session.agent.streamFunction;
    session.agent.streamFunction = (model, context, options) => {
      if (this.replayRequests < this.assistants.length) {
        const message = structuredClone(this.assistants[this.replayRequests++]);
        const stream = createAssistantMessageEventStream();
        stream.push({ type: "start", partial: message });
        stream.push({ type: "done", reason: "toolUse", message });
        stream.end(message);
        return stream;
      }
      assert.ok(this.reached, "Provider dispatch before frozen boundary");
      const boundaries = manager.getBranch().filter((entry) => entry.type === (this.group === "A" ? "compaction" : "context_window"));
      if (boundaries.length) {
        assert.equal(boundaries.length, 1);
        const boundary = boundaries[0];
        if (boundary.type === "context_window") {
          assert.ok(boundary.snapshotEntryId && boundary.workflowId);
          assert.notEqual(boundary.contextSeed.workflowSnapshotSequence, undefined);
          assert.equal(session.getWorkflowView()?.workflow.status, "executing");
        }
        if (!this.continued) writeFileSync(join(this.output, "controlled-after.json"), JSON.stringify(session.messages, null, 2));
        this.continued = true;
      }
      if (this.group === "C" && !this.continued) {
        const instruction = "Controlled evaluation boundary: prepare a short handoff from the existing history and call new_context before further repository work. Do not claim unfinished implementation or checks are complete.";
        writeFileSync(join(this.output, "controlled-handoff-instruction.txt"), instruction);
        return dispatch(model, { ...context, systemPrompt: `${context.systemPrompt ?? ""}\n\n${instruction}` }, options);
      }
      return dispatch(model, context, options);
    };
    const refresh = session.agent.prepareNextTurnWithContext;
    session.agent.prepareNextTurnWithContext = async (turn, signal) => {
      if (!this.reached && this.replayResults === this.results.length) {
        this.reached = true;
        assert.equal(session.agent.state.pendingToolCalls.size, 0);
        const before = canonical(session.messages);
        assert.equal(before, canonical(this.messages));
        this.beforeSha256 = createHash("sha256").update(before).digest("hex");
        writeFileSync(join(this.output, "controlled-before.json"), before);
        if (this.group === "C") assert.equal(session.getWorkflowView()?.workflow.status, "executing");
        else {
          const preparation = prepareCompaction(manager.getBranch(), session.settingsManager.getCompactionSettings());
          assert.ok(preparation);
          assert.ok(session.model);
          const auth = await runtime.getAuth(session.model);
          const headers = Object.fromEntries(Object.entries(auth?.auth.headers ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
          const result = await compact(preparation, session.model, auth?.auth.apiKey, headers,
            undefined, signal, "medium", session.agent.streamFunction, auth?.env);
          manager.appendCompaction(result.summary, result.firstKeptEntryId, result.tokensBefore, result.details, false, result.usage);
          session.agent.state.messages = manager.buildSessionContext().messages;
          const updated = await refresh?.({ ...turn, context: { ...turn.context, messages: session.messages.slice() } }, signal);
          return { ...updated, context: { ...(updated?.context ?? turn.context), messages: session.messages.slice() } };
        }
      }
      return await refresh?.(turn, signal);
    };
  }

  report() {
    const report = { group: this.group, replayRequests: this.replayRequests, replayResults: this.replayResults,
      reached: this.reached, continued: this.continued, beforeSha256: this.beforeSha256 };
    writeFileSync(join(this.output, "controlled-replay.json"), JSON.stringify(report, null, 2));
    return report;
  }
}
