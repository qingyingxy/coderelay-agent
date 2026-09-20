import type { AssistantMessage, Context } from "@earendil-works/pi-ai";
import { Type } from "typebox";

export const OLD_HANDOFF = "Direct Workflow only: current task brief, at most 2000 UTF-8 bytes. Put modified-but-unverified work, unchecked regressions and next action first; then list verified checks with evidence references. Replaces the previous task brief; does not mark verification passed.";
export const NEW_HANDOFF = `${OLD_HANDOFF} Carry forward every unresolved item from the previous brief unless you cite evidence covering that item or a user instruction removing it. Passing the existing suite is not evidence for untested requirements; when unsure, keep the item unverified.`;
export const OLD_SCOPE = "Verification scope: changed code and runtime success do not establish test coverage. Resolve unchecked work before final submission; consult original requirements in History.";
export const NEW_SCOPE = `${OLD_SCOPE} In each replacement handoff, retain unresolved items unless item-specific evidence or a user scope change resolves them. Existing-suite success alone does not resolve untested requirements.`;

export interface MicroCase {
	id: string;
	feature: string;
	scenario: "pending" | "verified" | "cancelled";
	initialBrief: string;
	observations: string[];
}

export function makeMicroCases(): MicroCase[] {
	const cases: MicroCase[] = [];
	for (const feature of ["safe_bulk_upsert transaction rollback", "resumable_download checksum mismatch"]) {
		for (const scenario of ["pending", "verified", "cancelled"] as const) {
			for (let repetition = 1; repetition <= (scenario === "pending" ? 2 : 1); repetition++) {
				cases.push({
					id: `${cases.length + 1}-${scenario}-${repetition}`,
					feature, scenario,
					initialBrief: `Objective: finish the reliability update. Modified but unverified: ${feature}; add a targeted failure-path test before submission. Verified: ordinary success path, E0 (12 tests passed). Next: validate the failure path, then compatibility checks.`,
					observations: [
						"E1: existing repository suite passed, 1060 tests, exit 0. Coverage inventory: ordinary success paths, CLI help, tracing, docs examples. No new tests were added. Working tree has implementation and documentation edits.",
						scenario === "verified"
							? `E2: new targeted test for ${feature} passed. It injects the specified failure and asserts atomic cleanup, unchanged prior data and expected error. Exit 0. The original requirement is fully covered by this test.`
							: scenario === "cancelled"
								? `U2: User explicitly removed ${feature} from this task's acceptance scope; no implementation or verification of that requirement is requested now. Finish the remaining compatibility checks.`
								: "E2: CLI help and tracing compatibility tests passed, exit 0. Documentation spelling was corrected. No other tests ran.",
						"E3: final existing repository suite passed again, 1060 tests, exit 0. git diff --check passed. No additional targeted tests ran and no new user instructions arrived. A fresh window is needed before the final review.",
					],
				});
			}
		}
	}
	return cases;
}

export function makeMicroContext(arm: "old" | "new", brief: string, observation: string): Context {
	return {
		systemPrompt: `You are a coding agent preparing a replacement task brief for a fresh context window. This is a synthetic handoff-only evaluation: do not execute code or invent observations. Call new_context once. Its handoff is the only task progress passed to the next window. Notes are empty. History is not available in this isolated probe.\n${arm === "new" ? NEW_SCOPE : OLD_SCOPE}`,
		messages: [{ role: "user", content: `Current Snapshot task brief:\n${brief}\n\nCurrent window observations:\n${observation}\n\nPrepare the next handoff now.`, timestamp: 0 }],
		tools: [{
			name: "new_context",
			description: "Request a hard context-window cut after the current assistant response and tool batch finish. In an active Direct Workflow, pass a short handoff to persist current progress in its Snapshot. Otherwise omit handoff.",
			parameters: Type.Object({ handoff: Type.Optional(Type.String({ minLength: 1, maxLength: 2000, description: arm === "new" ? NEW_HANDOFF : OLD_HANDOFF })) }, { additionalProperties: false }),
		}],
	};
}

export function readMicroHandoff(message: AssistantMessage, previous: string): { brief: string; omittedParameter: boolean } {
	const calls = message.content.filter((part) => part.type === "toolCall");
	if (message.stopReason !== "toolUse" || calls.length !== 1 || calls[0].name !== "new_context") throw new Error("Expected one new_context call");
	const args = calls[0].arguments;
	if (Object.keys(args).some((key) => key !== "handoff")) throw new Error("Unknown tool argument");
	if (args.handoff === undefined) return { brief: previous, omittedParameter: true };
	if (typeof args.handoff !== "string" || !args.handoff.trim() || Buffer.byteLength(args.handoff, "utf8") > 2000) throw new Error("Invalid handoff bytes");
	return { brief: args.handoff.trim(), omittedParameter: false };
}
