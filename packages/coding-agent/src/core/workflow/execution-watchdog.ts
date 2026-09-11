import { createHash } from "node:crypto";
import type { BudgetLimit } from "./types.ts";

export interface ExecutionWatchdogPolicy {
	readonly inactivityMs: number;
	readonly repeatedResults: number;
}

export const LONG_TASK_WATCHDOG: ExecutionWatchdogPolicy = {
	inactivityMs: 30 * 60_000,
	repeatedResults: 12,
};

/** Explicit host policy: measure cost, elapsed time and turns without capping them. */
export function watchdogBudget(budget: BudgetLimit): BudgetLimit {
	const { maxCost: _cost, maxDurationMs: _duration, maxTurns: _turns, ...retained } = budget;
	return retained;
}

function fingerprint(value: unknown): string {
	return createHash("sha256")
		.update(
			JSON.stringify(value, (_key, item: unknown) => {
				if (item && typeof item === "object" && !Array.isArray(item)) {
					return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)));
				}
				return item;
			}) ?? "undefined",
		)
		.digest("hex");
}

export interface WatchdogStop {
	readonly kind: "inactivity" | "repeated_results";
	readonly idleMs: number;
	readonly repeatedResults: number;
	readonly lastFingerprint?: string;
	readonly recentFingerprints: readonly string[];
}

/** Observes responses, not wall-clock task duration or the presence of code edits. */
export class ExecutionWatchdog {
	readonly #policy: ExecutionWatchdogPolicy;
	readonly #onStop: (evidence: WatchdogStop) => void;
	readonly #pending = new Map<string, { tool: unknown; args: unknown }>();
	readonly #seen = new Set<string>();
	readonly #recent: string[] = [];
	readonly #timer: ReturnType<typeof setInterval>;
	#lastResponse = Date.now();
	#repeated = 0;
	#lastFingerprint?: string;
	#disposed = false;
	#toolsThisTurn = false;

	constructor(policy: ExecutionWatchdogPolicy, onStop: (evidence: WatchdogStop) => void) {
		if (
			!Number.isSafeInteger(policy.inactivityMs) ||
			policy.inactivityMs < 1 ||
			!Number.isSafeInteger(policy.repeatedResults) ||
			policy.repeatedResults < 2
		) {
			throw new Error("Invalid execution watchdog policy");
		}
		this.#policy = policy;
		this.#onStop = onStop;
		this.#timer = setInterval(
			() => {
				if (Date.now() - this.#lastResponse >= this.#policy.inactivityMs) this.#stop("inactivity");
			},
			Math.min(1_000, policy.inactivityMs),
		);
	}

	observe(value: unknown): void {
		if (this.#disposed || !value || typeof value !== "object") return;
		const event = value as Record<string, unknown>;
		if (
			[
				"message_update",
				"message_end",
				"tool_execution_start",
				"tool_execution_update",
				"tool_execution_end",
				"turn_end",
			].includes(String(event.type))
		) {
			this.#lastResponse = Date.now();
		}
		if (event.type === "tool_execution_start" && typeof event.toolCallId === "string") {
			this.#toolsThisTurn = true;
			this.#pending.set(event.toolCallId, { tool: event.toolName, args: event.args });
		} else if (event.type === "tool_execution_end" && typeof event.toolCallId === "string") {
			const input = this.#pending.get(event.toolCallId);
			this.#pending.delete(event.toolCallId);
			if (input) this.#record({ ...input, result: event.result, isError: event.isError === true });
		} else if (event.type === "turn_end") {
			const message = event.message as { content?: unknown } | undefined;
			if (!this.#toolsThisTurn && message?.content) this.#record(message.content);
			this.#toolsThisTurn = false;
			if (this.#repeated >= this.#policy.repeatedResults && this.#repeatingCycle()) this.#stop("repeated_results");
		}
	}

	dispose(): void {
		this.#disposed = true;
		clearInterval(this.#timer);
		this.#pending.clear();
		this.#seen.clear();
		this.#recent.length = 0;
	}

	#record(result: unknown): void {
		const key = fingerprint(result);
		this.#recent.push(key);
		if (this.#recent.length > this.#policy.repeatedResults + 4) this.#recent.shift();
		this.#lastFingerprint = key;
		if (this.#seen.has(key)) {
			this.#repeated++;
		} else {
			this.#repeated = 0;
			this.#seen.add(key);
			if (this.#seen.size > 256) this.#seen.delete(this.#seen.values().next().value!);
		}
	}

	#repeatingCycle(): boolean {
		// Require a repeated short sequence, not merely revisiting many previously read files.
		for (let width = 1; width <= 4; width++) {
			const start = this.#recent.length - this.#policy.repeatedResults;
			if (start < width) continue;
			if (this.#recent.slice(start).every((key, offset) => key === this.#recent[start + offset - width]))
				return true;
		}
		return false;
	}

	#stop(kind: WatchdogStop["kind"]): void {
		if (this.#disposed) return;
		const evidence = {
			kind,
			idleMs: Date.now() - this.#lastResponse,
			repeatedResults: this.#repeated,
			lastFingerprint: this.#lastFingerprint,
			recentFingerprints: [...this.#recent],
		};
		this.dispose();
		this.#onStop(evidence);
	}
}
