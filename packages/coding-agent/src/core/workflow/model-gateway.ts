import type { Api, Model } from "@earendil-works/pi-ai";
import type { AgentProfileRole } from "./agent-profile.ts";
import type { BudgetLimit, ResourceUsage, RiskLevel } from "./types.ts";

export const MODEL_TIERS = ["fast", "balanced", "strong"] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];

export type ModelEscalationReason = "retry" | "no_progress" | "repeated_failure" | "verification_failure";

export type ModelRouteRole = AgentProfileRole | "main" | "repair";

export interface ModelRoutingOptions {
	/** Routing is enabled when true; tier model names are still optional fallbacks. */
	readonly enabled?: boolean;
	/** Fully-qualified model names such as `deepseek/deepseek-v4-flash`. */
	readonly fastModel?: string;
	readonly balancedModel?: string;
	readonly strongModel?: string;
	/** Keep an explicitly selected model instead of applying automatic routing. */
	readonly respectExplicitModel?: boolean;
}

export interface ModelRouteRequest {
	readonly role: ModelRouteRole;
	readonly currentModel?: Model<Api>;
	readonly currentModelName?: string;
	readonly explicitModel?: boolean;
	readonly riskLevel?: RiskLevel;
	readonly escalationReason?: ModelEscalationReason;
	readonly budget?: BudgetLimit;
	readonly usage?: ResourceUsage;
}

export interface ModelRouteRecord {
	readonly role: ModelRouteRole;
	readonly tier: ModelTier;
	readonly modelName: string;
	readonly previousModelName?: string;
	readonly source: "configured" | "current" | "explicit" | "fallback";
	readonly reasonCode: string;
	readonly reason: string;
	readonly createdAt: string;
}

export interface ModelRouteDecision {
	readonly model?: Model<Api>;
	readonly record: ModelRouteRecord;
}

export interface ModelTierSelection {
	readonly tier: ModelTier;
	readonly reasonCode: string;
	readonly reason: string;
}

export interface ModelGatewayRuntime {
	getModel(providerId: string, modelId: string): Model<Api> | undefined;
	hasConfiguredAuth(providerId: string): boolean;
}

const TIER_ENVIRONMENT_KEYS: Readonly<Record<ModelTier, keyof NodeJS.ProcessEnv>> = {
	fast: "PI_MODEL_FAST",
	balanced: "PI_MODEL_BALANCED",
	strong: "PI_MODEL_STRONG",
};

function normalizeModelName(modelName: string | undefined): string | undefined {
	const value = modelName?.trim();
	return value ? value : undefined;
}

function modelNameOf(model: Model<Api> | undefined): string | undefined {
	return model ? `${model.provider}/${model.id}` : undefined;
}

function parseQualifiedModelName(modelName: string): { provider: string; modelId: string } | undefined {
	const separator = modelName.indexOf("/");
	if (separator <= 0 || separator === modelName.length - 1) {
		return undefined;
	}
	return {
		provider: modelName.slice(0, separator),
		modelId: modelName.slice(separator + 1),
	};
}

function configuredModelName(options: ModelRoutingOptions, tier: ModelTier): string | undefined {
	return normalizeModelName(options[`${tier}Model`]);
}

function tierModelName(options: ModelRoutingOptions, tier: ModelTier): string | undefined {
	return configuredModelName(options, tier);
}

function routeFromRole(role: ModelRouteRole, riskLevel: RiskLevel | undefined): ModelTierSelection {
	if (role === "mode_advisor" || role === "explorer") {
		return {
			tier: "fast",
			reasonCode: `model.${role}.fast`,
			reason: `${role} is read-only and short-lived, so it uses the fast tier`,
		};
	}
	if (role === "planner") {
		return {
			tier: "strong",
			reasonCode: "model.planner.strong",
			reason: "Planning determines the task graph and verification gates, so it uses the strong tier",
		};
	}
	if (role === "planner_lite") {
		return {
			tier: "balanced",
			reasonCode: "model.planner_lite.balanced",
			reason: "A bounded Direct execution contract uses the balanced tier",
		};
	}
	if (role === "main") {
		if (riskLevel === "high") {
			return {
				tier: "strong",
				reasonCode: "model.main.high_risk_strong",
				reason: "High-risk direct work uses the strong tier",
			};
		}
		return {
			tier: "fast",
			reasonCode: riskLevel === "medium" ? "model.main.medium_risk_fast" : "model.main.low_risk_fast",
			reason: `${riskLevel === "medium" ? "Medium" : "Low"}-risk direct work uses the fast tier`,
		};
	}
	if (role === "worker") {
		return {
			tier: "balanced",
			reasonCode: "model.worker.balanced",
			reason: "Implementation work uses the balanced tier after strong planning",
		};
	}
	if (role === "repair") {
		return {
			tier: "strong",
			reasonCode: "model.repair.strong",
			reason: "Repair follows a failed verification, so it uses the strong tier",
		};
	}
	if (role === "reviewer") {
		return riskLevel === "high"
			? {
					tier: "strong",
					reasonCode: "model.reviewer.high_risk_strong",
					reason: "High-risk review uses the strong tier",
				}
			: {
					tier: "balanced",
					reasonCode: "model.reviewer.balanced",
					reason: "Review work uses the balanced tier",
				};
	}
	return {
		tier: "balanced",
		reasonCode: "model.default.balanced",
		reason: "The role has no more specific routing policy",
	};
}

function applyBudgetPressure(
	selection: ModelTierSelection,
	budget: BudgetLimit | undefined,
	usage: ResourceUsage | undefined,
): ModelTierSelection {
	if (budget?.maxCost === undefined || budget.maxCost <= 0 || usage === undefined) {
		return selection;
	}
	const remainingCost = budget.maxCost - usage.cost;
	if (remainingCost <= 0 || remainingCost / budget.maxCost >= 0.25 || selection.tier === "fast") {
		return selection;
	}
	const downgradedTier: ModelTier = selection.tier === "strong" ? "balanced" : "fast";
	return {
		tier: downgradedTier,
		reasonCode: "model.budget_pressure_downgrade",
		reason: `${selection.reason}; remaining cost budget is below 25%, so the route was downgraded to ${downgradedTier}`,
	};
}

export function selectModelTier(
	input: Pick<ModelRouteRequest, "role" | "riskLevel" | "escalationReason" | "budget" | "usage">,
): ModelTierSelection {
	if (input.escalationReason === "no_progress" || input.escalationReason === "repeated_failure") {
		return {
			tier: "strong",
			reasonCode:
				input.escalationReason === "no_progress"
					? "model.no_progress_escalated_strong"
					: "model.repeated_failure_escalated_strong",
			reason:
				input.escalationReason === "no_progress"
					? "The previous Agent produced no code, so the retry is forced to the strong tier"
					: "A retried Agent failed again, so the next repair is forced to the strong tier",
		};
	}
	if (input.escalationReason === "verification_failure") {
		return {
			tier: "strong",
			reasonCode: "model.verification_failure_escalated_strong",
			reason: "Verification failed, so repair is forced to the strong tier",
		};
	}
	const roleSelection = routeFromRole(input.role, input.riskLevel);
	const selection =
		input.escalationReason === "retry"
			? {
					...roleSelection,
					reasonCode: "model.retry_role_tier",
					reason: `A previous Agent attempt failed, so the retry remains on the role's ${roleSelection.tier} tier`,
				}
			: roleSelection;
	return applyBudgetPressure(selection, input.budget, input.usage);
}

export function createModelRoutingOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): ModelRoutingOptions {
	const fastModel = normalizeModelName(env[TIER_ENVIRONMENT_KEYS.fast]);
	const balancedModel = normalizeModelName(env[TIER_ENVIRONMENT_KEYS.balanced]);
	const strongModel = normalizeModelName(env[TIER_ENVIRONMENT_KEYS.strong]);
	const requestedMode = env.PI_MODEL_ROUTING?.trim().toLowerCase();
	return {
		enabled:
			requestedMode === "off" ? false : requestedMode === "auto" || !!(fastModel || balancedModel || strongModel),
		fastModel,
		balancedModel,
		strongModel,
		respectExplicitModel: env.PI_MODEL_ROUTING_RESPECT_EXPLICIT !== "0",
	};
}

function mergeOptions(base: ModelRoutingOptions, override: ModelRoutingOptions | undefined): ModelRoutingOptions {
	return {
		...base,
		...(override ?? {}),
	};
}

function withRecord(
	role: ModelRouteRole,
	selection: ModelTierSelection,
	modelName: string,
	previousModelName: string | undefined,
	source: ModelRouteRecord["source"],
): ModelRouteRecord {
	return {
		role,
		tier: selection.tier,
		modelName,
		...(previousModelName && previousModelName !== modelName ? { previousModelName } : {}),
		source,
		reasonCode: selection.reasonCode,
		reason: selection.reason,
		createdAt: new Date().toISOString(),
	};
}

export class ModelGateway {
	readonly #runtime: ModelGatewayRuntime;
	readonly #options: ModelRoutingOptions;

	constructor(runtime: ModelGatewayRuntime, options?: ModelRoutingOptions) {
		this.#runtime = runtime;
		const merged = mergeOptions(createModelRoutingOptionsFromEnv(), options);
		const optionsConfigureTier = !!(options?.fastModel || options?.balancedModel || options?.strongModel);
		this.#options = {
			...merged,
			enabled: options?.enabled ?? (optionsConfigureTier ? true : merged.enabled),
		};
	}

	get options(): ModelRoutingOptions {
		return { ...this.#options };
	}

	route(input: ModelRouteRequest): ModelRouteDecision {
		const currentModelName = input.currentModelName ?? modelNameOf(input.currentModel);
		const selection = selectModelTier(input);
		const roleSelection: ModelRouteRecord = {
			...withRecord(input.role, selection, currentModelName ?? "(unselected)", currentModelName, "current"),
		};

		if (input.explicitModel && !input.escalationReason && this.#options.respectExplicitModel !== false) {
			return {
				model: input.currentModel,
				record: {
					...roleSelection,
					source: "explicit",
					reasonCode: "model.explicit_preserved",
					reason: "An explicitly selected model is preserved",
				},
			};
		}
		if (this.#options.enabled !== true) {
			return {
				model: input.currentModel,
				record: {
					...roleSelection,
					source: "fallback",
					reasonCode: "model.routing_disabled",
					reason: "Model routing is disabled or no tier models are configured",
				},
			};
		}

		const configuredName = tierModelName(this.#options, selection.tier);
		if (!configuredName) {
			return {
				model: input.currentModel,
				record: {
					...roleSelection,
					source: "fallback",
					reasonCode: "model.tier_unconfigured",
					reason: `${selection.reason}; no ${selection.tier} tier model is configured, so the current model is retained`,
				},
			};
		}

		const parsed = parseQualifiedModelName(configuredName);
		const target = parsed ? this.#runtime.getModel(parsed.provider, parsed.modelId) : undefined;
		if (!target || !this.#runtime.hasConfiguredAuth(target.provider)) {
			return {
				model: input.currentModel,
				record: {
					...roleSelection,
					source: "fallback",
					reasonCode: "model.target_unavailable",
					reason: `${selection.reason}; configured ${configuredName} is unavailable or unauthenticated, so the current model is retained`,
				},
			};
		}
		return {
			model: target,
			record: {
				...roleSelection,
				modelName: configuredName,
				previousModelName: currentModelName,
				source: "configured",
			},
		};
	}
}

export function isModelRouteRecord(value: unknown): value is ModelRouteRecord {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const record = value as Partial<ModelRouteRecord>;
	return (
		typeof record.role === "string" &&
		record.role.length > 0 &&
		(record.tier === "fast" || record.tier === "balanced" || record.tier === "strong") &&
		typeof record.modelName === "string" &&
		typeof record.source === "string" &&
		typeof record.reasonCode === "string" &&
		typeof record.reason === "string" &&
		typeof record.createdAt === "string"
	);
}
