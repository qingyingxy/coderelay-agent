import type { StreamFn } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, createAssistantMessageEventStream } from "@earendil-works/pi-ai";

export interface PierRunConfig {
	provider: string;
	model: string;
	group: "A" | "C";
	maxCostUsd: number;
	maxRequests: number;
	maxOutputTokens: number;
	contextWindow: number;
	timeoutSeconds: number;
	pricing: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

export function parsePierRunConfig(value: unknown): PierRunConfig {
	if (!value || typeof value !== "object") throw new Error("Configuration must be an object");
	const data = value as Record<string, unknown>;
	const allowed = new Set(["provider", "model", "group", "maxCostUsd", "maxRequests", "maxOutputTokens", "contextWindow", "timeoutSeconds", "pricing"]);
	if (Object.keys(data).some((key) => !allowed.has(key))) throw new Error("Unknown configuration field; credentials must stay in Pi auth storage");
	for (const name of ["provider", "model"]) {
		if (typeof data[name] !== "string" || !data[name].trim()) throw new Error(`Missing ${name}`);
	}
	if (data.group !== "A" && data.group !== "C") throw new Error("group must be A or C");
	for (const name of ["maxCostUsd", "maxRequests", "maxOutputTokens", "contextWindow", "timeoutSeconds"]) {
		if (typeof data[name] !== "number" || !Number.isFinite(data[name]) || data[name] <= 0) throw new Error(`Invalid ${name}`);
		if (name !== "maxCostUsd" && !Number.isSafeInteger(data[name])) throw new Error(`Invalid integer ${name}`);
	}
	const price = data.pricing;
	if (!price || typeof price !== "object") throw new Error("Explicit pricing per million tokens required");
	for (const name of ["input", "output", "cacheRead", "cacheWrite"]) {
		const rate = (price as Record<string, unknown>)[name];
		if (typeof rate !== "number" || !Number.isFinite(rate) || rate < 0) throw new Error(`Invalid pricing.${name}`);
	}
	const config = data as unknown as PierRunConfig;
	if (config.pricing.input <= 0 || config.pricing.output <= 0) throw new Error("Input/output prices must be positive");
	if (config.contextWindow > 272000 || config.contextWindow < 40000 || config.maxOutputTokens > 16000 || config.timeoutSeconds > 10800) {
		throw new Error("Unsupported context/output/time budget");
	}
	return config;
}

export interface BudgetReceipt {
	request: number;
	status: "reserved" | "completed" | "unknown" | "blocked";
	reservedUsd: number;
	accountedUsd: number;
	inputTokens?: number;
	outputTokens?: number;
	stopReason?: string;
	reason?: string;
}

/** Evaluation-only spending guard; never changes the agent's context, tools or execution phase. */
export class PierBudget {
	readonly receipts: BudgetReceipt[] = [];
	accountedUsd = 0;
	requests = 0;
	stopped: string | undefined;
	private active = false;
	readonly config: PierRunConfig;
	private readonly record: (receipt: BudgetReceipt) => void;

	constructor(config: PierRunConfig, record: (receipt: BudgetReceipt) => void) {
		this.config = config;
		this.record = record;
	}

	get requestReservationUsd(): number {
		const price = this.config.pricing;
		return (this.config.contextWindow * Math.max(price.input, price.cacheRead, price.cacheWrite)
			+ this.config.maxOutputTokens * price.output) / 1e6;
	}

	wrap(dispatch: StreamFn): StreamFn {
		return (model, context, options) => {
			const stream = createAssistantMessageEventStream();
			const fail = (reason: string) => {
				const message: AssistantMessage = {
					role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
					stopReason: "error", errorMessage: reason, timestamp: Date.now(),
				};
				stream.push({ type: "error", reason: "error", error: message });
				stream.end(message);
			};
			const price = this.config.pricing;
			const reserve = this.requestReservationUsd;
			const reason = this.stopped ?? (this.active ? "Concurrent model request rejected" :
				this.requests >= this.config.maxRequests ? "Request limit reached" :
				this.accountedUsd + reserve > this.config.maxCostUsd ? "Insufficient budget for next request reservation" : undefined);
			if (reason) {
				this.stopped = reason;
				const receipt: BudgetReceipt = { request: this.requests, status: "blocked", reservedUsd: 0, accountedUsd: this.accountedUsd, reason };
				this.receipts.push(receipt); this.record(receipt); fail(reason);
				return stream;
			}
			this.active = true;
			this.requests++;
			this.accountedUsd += reserve;
			const receipt: BudgetReceipt = { request: this.requests, status: "reserved", reservedUsd: reserve, accountedUsd: this.accountedUsd };
			this.receipts.push(receipt); this.record({ ...receipt });
			void (async () => {
				try {
					const source = await dispatch({ ...model, contextWindow: this.config.contextWindow, maxTokens: this.config.maxOutputTokens }, context,
						{ ...options, maxTokens: Math.min(options?.maxTokens ?? this.config.maxOutputTokens, this.config.maxOutputTokens), maxRetries: 0 });
					for await (const event of source) {
						if (event.type === "done" || event.type === "error") {
							const message = event.type === "done" ? event.message : event.error;
							const usage = message.usage;
							const counts = [usage.input, usage.output, usage.cacheRead, usage.cacheWrite];
							const known = event.type === "done" && counts.every((count) => Number.isFinite(count) && count >= 0) && counts.some((count) => count > 0);
							if (known) {
								const cost = (usage.input * price.input + usage.output * price.output + usage.cacheRead * price.cacheRead + usage.cacheWrite * price.cacheWrite) / 1e6;
								this.accountedUsd += cost - reserve;
								receipt.status = "completed";
								if (cost > reserve) this.stopped = "Usage exceeded reservation; pricing/context assumptions need review";
							} else {
								receipt.status = "unknown";
								this.stopped = "Provider failed or omitted usage; reservation retained";
							}
							Object.assign(receipt, { accountedUsd: this.accountedUsd, inputTokens: usage.input + usage.cacheRead + usage.cacheWrite, outputTokens: usage.output, stopReason: message.stopReason });
							this.active = false;
							this.record({ ...receipt });
						}
						stream.push(event);
					}
					if (receipt.status === "reserved") throw new Error("Stream ended without terminal usage");
					stream.end();
				} catch {
					this.stopped = "Model transport failed; reservation retained";
					receipt.status = "unknown"; this.record({ ...receipt }); fail(this.stopped);
				} finally { this.active = false; }
			})();
			return stream;
		};
	}
}
