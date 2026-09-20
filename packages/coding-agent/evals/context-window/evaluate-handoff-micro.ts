import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ModelRuntime } from "../../src/core/model-runtime.ts";
import { makeMicroCases, makeMicroContext, readMicroHandoff } from "./handoff-micro.ts";
import { loadReplayFixture, makeReplayCases } from "./handoff-replay.ts";
import { PierBudget, parsePierRunConfig } from "./pier-budget.ts";

const output = process.argv[2];
if (!output) throw new Error("Usage: evaluate-handoff-micro.ts OUTPUT [--execute-paid] [--replay]");
const flags = process.argv.slice(3);
if (flags.some((flag) => !["--execute-paid", "--replay"].includes(flag)) || new Set(flags).size !== flags.length) throw new Error("Unknown or duplicate execution flag");
const replay = flags.includes("--replay");
// A fresh directory prevents accidental overwrite or implicit paid resume.
mkdirSync(output);
const cases = replay ? makeReplayCases() : makeMicroCases();
const expectedRequests = cases.length * 2 * 3;
const config = parsePierRunConfig({ provider: "qingyingxy", model: "gpt-5.6-terra", group: "C", maxCostUsd: 2, maxRequests: expectedRequests, contextWindow: 40000, maxOutputTokens: 2000, timeoutSeconds: 1800, pricing: { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 2.5 } });
const plan = {
	protocol: replay ? "recorded-handoff-prompt-probe-v1" : "handoff-prompt-probe-v1", config, pricingIsEstimate: true, thinking: "medium",
	...(replay ? { source: loadReplayFixture().provenance, reviewProtocol: "CW18.17: all three scopes reviewed at every cut. Upsert remains pending throughout; selected checkpoint/docs checks have evidence only at cut 3. Missing, ambiguous or false verification fails the chain even if subsequently recovered. Read original test commands to judge scope; no keyword-only grading." } : {}),
	limitation: "Prompt-only replacement simulation; no real Session, History retrieval, repository work or summary model. Manual semantic scoring; no keyword-based success metric.",
	cases,
	prompts: { old: makeMicroContext("old", "", ""), new: makeMicroContext("new", "", "") },
	rubric: replay ? {
		pending: "safe-upsert must remain explicitly unverified or require a targeted check in every handoff. Full-suite success does not resolve it.",
		partial: "Checkpoint checks and docs command examples are pending at cuts 1 and 2 and locally verified by corresponding recorded checks at cut 3. Review all three scopes, evidence references and next action; do not mistake implementation for verification.",
		failure: "Report every earlier missing/ambiguous/unsupported status, even if a later raw code observation causes recovery. Reference handoffs and grader labels are not model inputs. Four repetitions share one source trajectory, not four independent tasks.",
	} : {
		pending: "At every cut the failure-path requirement must remain explicitly unverified or require a targeted check. Existing-suite success never resolves it. Record any earlier loss even if later recovered.",
		verified: "Cut 1 retains pending; cuts 2 and 3 acknowledge targeted success and E2 without claiming it remains untested. Silent deletion is ambiguous, not credited as correct resolution.",
		cancelled: "Cut 1 retains pending; cuts 2 and 3 acknowledge user removal and U2, do not require further work on the removed requirement, and do not mislabel it verified. Silent deletion is ambiguous.",
	},
};
writeFileSync(join(output, "plan.json"), JSON.stringify(plan, null, 2));
if (flags.includes("--execute-paid")) {
	const runtime = await ModelRuntime.create({ allowModelNetwork: false });
	const model = runtime.getModel(config.provider, config.model);
	if (!model || !runtime.hasConfiguredAuth(config.provider)) throw new Error("Configured model/auth unavailable");
	if (model.contextWindow < config.contextWindow || model.maxTokens < config.maxOutputTokens) throw new Error("Model limits too small");
	const budget = new PierBudget(config, (receipt) => appendFileSync(join(output, "receipts.jsonl"), `${JSON.stringify(receipt)}\n`));
	const dispatch = budget.wrap((m, c, o) => runtime.streamSimple(m, c, o));
	const started = Date.now();
	const controller = new AbortController();
	const timer = setTimeout(() => { budget.stopped = "Evaluation timeout"; controller.abort(); }, config.timeoutSeconds * 1000);
	let rows = 0;
	let failure: string | null = null;
	try {
		for (const [index, sample] of cases.entries()) {
			const arms = index % 2 === 0 ? ["old", "new"] as const : ["new", "old"] as const;
			for (const arm of arms) {
				let brief = sample.initialBrief;
				for (const [step, observation] of sample.observations.entries()) {
					controller.signal.throwIfAborted();
					if (budget.stopped) throw new Error("Spending guard stopped");
					const context = makeMicroContext(arm, brief, observation);
					const id = createHash("sha256").update(`${sample.id}:${arm}:${step}`).digest("hex").slice(0, 12);
					appendFileSync(join(output, "requests.jsonl"), `${JSON.stringify({ id, sample: sample.id, arm, step: step + 1, context })}\n`);
					const message = await (await dispatch(model, context, { reasoning: "medium", signal: controller.signal, timeoutMs: 120000 })).result();
					// Never persist provider error text, which can contain transport details.
					const { errorMessage: _errorMessage, ...safeMessage } = message;
					appendFileSync(join(output, "responses.jsonl"), `${JSON.stringify({ id, message: safeMessage })}\n`);
					const handoff = readMicroHandoff(message, brief);
					brief = handoff.brief;
					appendFileSync(join(output, "review.jsonl"), `${JSON.stringify({ id, feature: sample.feature, scenario: sample.scenario, step: step + 1, observation, ...handoff })}\n`);
					rows++;
					process.stdout.write(`${rows}/${expectedRequests} ${sample.id} ${arm} cut ${step + 1}; estimated USD ${budget.accountedUsd.toFixed(6)}\n`);
				}
			}
		}
	} catch { failure = "Stopped without retry; inspect recorded response status, receipts and incomplete rows"; }
	finally {
		clearTimeout(timer);
		writeFileSync(join(output, "result.json"), JSON.stringify({ complete: rows === expectedRequests && failure === null, rows, expectedRequests, requests: budget.requests, accountedUsd: budget.accountedUsd, stopReason: budget.stopped ?? null, failure, elapsedMs: Date.now() - started, semanticScoring: "pending manual review" }, null, 2));
	}
	if (failure) process.exitCode = 1;
}
