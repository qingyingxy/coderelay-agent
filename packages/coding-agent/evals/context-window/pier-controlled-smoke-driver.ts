/** Real Pier transport and submission, exclusively Faux model responses. */
import { strict as assert } from "node:assert";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { ModelRuntime } from "../../src/index.ts";
import { runPierSession, type ContainerReply } from "./pier-real-session.ts";

const [output, checkpoint, group] = process.argv.slice(2);
assert.ok(output && checkpoint && (group === "A" || group === "C"));
const reader = createInterface({ input: process.stdin });
const lines = reader[Symbol.asyncIterator]();
const faux = registerFauxProvider({ models: [{ id: "controlled-pier", contextWindow: 128000, maxTokens: 4000 }] });
try {
  const first = await lines.next();
  assert.ok(!first.done);
  const input = JSON.parse(first.value) as { instruction: string };
  const model = faux.getModel();
  const runtime = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false });
  runtime.registerProvider(model.provider, { baseUrl: model.baseUrl, api: model.api, models: [model] });
  await runtime.setRuntimeApiKey(model.provider, "faux-key", { allowNetwork: false });
  faux.setResponses([
    group === "A" ? fauxAssistantMessage("SCRIPTED SUMMARY: reading complete; implementation and verification remain unfinished.") :
      fauxAssistantMessage(fauxToolCall("new_context", { handoff: "Reading complete; no source changes. Implementation and verification remain unfinished." }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("container_exec", { command: "printf 'Controlled continuation smoke only.\\n' > PI_TRANSPORT_SMOKE.txt" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("container_submit", { verification_command: "test -s PI_TRANSPORT_SMOKE.txt", message: "Controlled continuation smoke fixture" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("Smoke fixture submitted; no task implementation claimed."),
  ]);
  const result = await runPierSession({ provider: model.provider, model: model.id, group, contextWindow: 128000,
    maxOutputTokens: 4000, maxCostUsd: 2, maxRequests: 8, timeoutSeconds: 180,
    pricing: { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 2.5 } }, input.instruction, output, runtime, model,
    async (command): Promise<ContainerReply> => {
      process.stdout.write(`${JSON.stringify({ type: "exec", command })}\n`);
      const line = await lines.next();
      assert.ok(!line.done);
      return JSON.parse(line.value) as ContainerReply;
    }, checkpoint);
  const passed = result.status === "runtime_completed" && result.controlledReplay?.continued === true &&
    result.controlledReplay.replayRequests === 7 && result.controlledReplay.replayResults === 13 &&
    result.requests === 4 && result.containerCalls === 3 && result.containerReplies === 3 &&
    result.submission?.submitted === true && (group === "A" ? result.compactions === 1 && result.windows === 0 : result.snapshotWindows === 1 && result.compactions === 0);
  writeFileSync(join(output, "sdk-result.json"), JSON.stringify({ ...result, passed, provider: "faux", costUsd: 0,
    scenario: "controlled-continuation", qualityEvaluation: false }, null, 2));
  assert.ok(passed, "Controlled Pier smoke failed");
  process.stdout.write(`${JSON.stringify({ type: "complete" })}\n`);
} finally { faux.unregister(); reader.close(); }
