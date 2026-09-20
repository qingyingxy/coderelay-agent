/** Scripted lifecycle rehearsal with real, isolated source/test stages. */
import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type FauxResponseStep, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { compact, prepareCompaction, estimateContextTokens } from "../../src/core/compaction/compaction.ts";
import { createHarness, getMessageText } from "../../test/suite/harness.ts";

const output = process.argv[2];
const group = process.argv[3] ?? "C";
if (group !== "A" && group !== "C") throw new Error("Group must be A or C");
if (!output || existsSync(output)) throw new Error("Pass a fresh output directory");
mkdirSync(output, { recursive: true });
const execute = promisify(execFile);
const winOutput = resolve(output);
const linuxOutput = `/mnt/${winOutput[0].toLowerCase()}${winOutput.slice(2).replaceAll("\\", "/")}`;
const root = "/mnt/e/code/pi";
let completed = 0;
const reports: unknown[] = [];
const maintenanceAttempts: { stage: number; eligible: boolean; tokensBefore: number; summaryRequests: number }[] = [];
const tool: AgentTool = {
  name: "fixture_stage", label: "Reference fixture stage", description: "Free scripted changes and real tests; no Agent implementation score",
  parameters: Type.Object({ stage: Type.Integer({ minimum: 1, maximum: 5 }) }),
  execute: async (_id, parameters) => {
    assert.equal(parameters.stage, completed + 1);
    const result = await execute("wsl", ["-d", "Ubuntu", "-u", "qingying", "--",
      "/home/qingying/.local/share/pi-featurebench/venv/bin/python",
      `${root}/packages/coding-agent/evals/context-window/transitions_fixture_stage.py`,
      "--baseline", `${root}/.artifacts/transitions-final-preparation-20260907/transitions-db2941a7ff5da45ff84f35a90a966c36c1104ff2`,
      "--feature", `${root}/.artifacts/transitions-final-preparation-20260907/transitions-e7f1101163dbce8248140e9fda5e34a83c04d02c`,
      "--reference", `${root}/.artifacts/light-repositories-20260907/transitions-master`,
      "--output", linuxOutput, "--stage", String(parameters.stage)], { maxBuffer: 1024 * 1024, timeout: 240000 });
    const report: unknown = JSON.parse(result.stdout);
    reports.push(report);
    completed++;
    return { content: [{ type: "text", text: result.stdout.trim() }], details: report };
  },
};
const harness = await createHarness({ models: [{ id: "four-handoffs", contextWindow: 128000, maxTokens: 4000 }],
  tools: [tool], initialActiveToolNames: ["fixture_stage", ...(group === "C" ? ["new_context", "history"] : [])],
  settings: { compaction: { enabled: true, keepRecentTokens: 20000, reserveTokens: 16000 },
    contextManagement: { mode: group === "C" ? "windowed" : "summary", reserveTokens: 16000 } } });
const handoffs = [
  "Verified: ordinary core final-state checks. Known failures: hierarchical final-state entry and failed-condition checks, since nested support is not implemented. Unverified: parallel, async and stubs. Next: nested implementation and rerun the failed checks.",
  "Verified: ordinary core and nested checks, including both previously failing hierarchical checks. Unverified: parallel, async and stub behavior. Next: parallel ordering checks.",
  "Known failure: parallel last-region-first ordering. Unverified: async and stubs. Existing passed tests do not resolve this failure. Next: async implementation and checks.",
  "Known failures: parallel and async last-region-first ordering. Stubs and full regression are still unverified. Next: scripted reference correction, full contract and regression.",
];
try {
  if (group === "C") harness.session.enableWorkflowTracking("direct");
  const responses: FauxResponseStep[] = [];
  for (let stage = 1; stage <= 5; stage++) {
    responses.push((context) => {
      if (stage > 1 && group === "C") {
        const cuts = harness.sessionManager.getBranch().filter((entry) => entry.type === "context_window");
        assert.equal(cuts.length, stage - 1);
        const cut = cuts.at(-1)!;
        assert.ok(cut.snapshotEntryId && cut.workflowId);
        assert.equal(cut.contextSeed.truncated, false);
        assert.ok(context.messages.map(getMessageText).join("\n").includes(handoffs[stage - 2]));
        assert.equal(harness.session.getWorkflowView()?.workflow.status, "executing");
      }
      return fauxAssistantMessage(fauxToolCall("fixture_stage", { stage }), { stopReason: "toolUse" });
    });
    if (stage < 5 && group === "C") responses.push(() => {
      assert.equal(completed, stage);
      return fauxAssistantMessage(fauxToolCall("new_context", { handoff: handoffs[stage - 1] }), { stopReason: "toolUse" });
    });
  }
  responses.push(fauxAssistantMessage("Scripted fixture validation completed. No model quality claim."));
  if (group === "A") {
    const refresh = harness.session.agent.prepareNextTurnWithContext;
    harness.session.agent.prepareNextTurnWithContext = async (turn, signal) => {
      if (completed > 0 && completed < 5 && !maintenanceAttempts.some((attempt) => attempt.stage === completed)) {
        const preparation = prepareCompaction(harness.sessionManager.getBranch(), harness.settingsManager.getCompactionSettings());
        const attempt = { stage: completed, eligible: Boolean(preparation),
          tokensBefore: estimateContextTokens(harness.session.messages).tokens, summaryRequests: 0 };
        maintenanceAttempts.push(attempt);
        if (preparation) {
          const count = preparation.isSplitTurn && preparation.turnPrefixMessages.length > 0
            ? 1 + Number(preparation.messagesToSummarize.length > 0) : 1;
          harness.setResponses([
            ...Array.from({ length: count }, () => fauxAssistantMessage(`SCRIPTED SUMMARY: ${handoffs[completed - 1]}`)),
            ...responses.slice(completed),
          ]);
          const before = harness.faux.state.callCount;
          const result = await compact(preparation, harness.getModel(), "faux-key", undefined, undefined,
            signal, "off", harness.session.agent.streamFunction);
          attempt.summaryRequests = harness.faux.state.callCount - before;
          harness.sessionManager.appendCompaction(result.summary, result.firstKeptEntryId,
            result.tokensBefore, result.details, false, result.usage);
          harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
          const updated = await refresh?.({ ...turn, context: { ...turn.context, messages: harness.session.messages.slice() } }, signal);
          return { ...updated, context: { ...(updated?.context ?? turn.context), messages: harness.session.messages.slice() } };
        }
      }
      return await refresh?.(turn, signal);
    };
  }
  harness.setResponses(responses);
  const instruction = readFileSync(new URL("./fixtures/transitions-final/instruction.md", import.meta.url), "utf8");
  await harness.session.prompt(instruction, { expandPromptTemplates: false,
    ...(group === "C" ? { isolatedDirectExecution: { reason: "Free scripted reference stages in a disposable local fixture; no paid model" } } : {}) });
  const branch = harness.sessionManager.getBranch();
  const cuts = branch.filter((entry) => entry.type === "context_window");
  assert.equal(completed, 5);
  const compactions = branch.filter((entry) => entry.type === "compaction");
  assert.equal(cuts.length, group === "C" ? 4 : 0);
  assert.equal(harness.faux.state.callCount, group === "C" ? 10 : 6 + maintenanceAttempts.reduce((sum, attempt) => sum + attempt.summaryRequests, 0));
  assert.equal(harness.getPendingResponseCount(), 0);
  if (group === "C") assert.equal(compactions.length, 0);
  else {
    assert.equal(maintenanceAttempts.length, 4);
    assert.equal(compactions.length, maintenanceAttempts.filter((attempt) => attempt.eligible).length);
  }
  assert.equal(branch.filter((entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.isError).length, 0);
  for (const cut of cuts) {
    assert.ok(branch.slice(branch.indexOf(cut) + 1).some((entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "fixture_stage"));
  }
  const report = { passed: true, group, paidCalls: 0, costUsd: 0, scriptedResponses: true,
    scriptedReferenceChanges: true, modelQualityEvaluation: false, contextWindow: 128000,
    stages: completed, cuts: cuts.length, compactions: compactions.length,
    fourMaintenanceEventsVerified: group === "C" ? cuts.length === 4 : compactions.length === 4,
    maintenanceAttempts, fauxRequests: harness.faux.state.callCount,
    stagesAfterCuts: group === "C" ? [2, 3, 4, 5] : [], snapshotEntries: cuts.map((cut) => cut.snapshotEntryId), reports };
  writeFileSync(join(output, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: true, group, stages: completed, cuts: cuts.length,
    compactions: compactions.length, maintenanceAttempts, paidCalls: 0, output }));
} finally {
  writeFileSync(join(output, "session.json"), JSON.stringify(harness.sessionManager.getBranch(), null, 2));
  writeFileSync(join(output, "events.json"), JSON.stringify(harness.events, null, 2));
  if (!existsSync(join(output, "report.json"))) writeFileSync(join(output, "report.json"), JSON.stringify({
    passed: false, stages: completed, paidCalls: 0, scriptedReferenceChanges: true, reports }, null, 2));
  harness.cleanup();
}
