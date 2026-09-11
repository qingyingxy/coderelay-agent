import { randomUUID } from "node:crypto";
import type { JobRuntime } from "../jobs/job-runtime.ts";
import { sumResourceUsage } from "../workflow/runtime-policy.ts";
import type { ResourceUsage, VerificationRequirement, VerificationResult } from "../workflow/types.ts";
import { DEFAULT_WRITER_LEASE_REGISTRY, type WriterLeaseRegistry } from "../workflow/writer-lease.ts";
import { DiffCollector } from "./diff-collector.ts";
import type {
	DeliveryRunOptions,
	DeliveryRunResult,
	DeliveryWorkflowPort,
	ReadonlyReviewer,
	ReviewResult,
} from "./types.ts";

const DELIVERY_KINDS = new Set<VerificationRequirement["kind"]>(["diff", "review", "test", "build"]);

export interface DeliveryRuntimeOptions {
	readonly jobRuntime: JobRuntime;
	readonly reviewer?: ReadonlyReviewer;
	readonly diffCollector?: DiffCollector;
	readonly writerLeaseRegistry?: WriterLeaseRegistry;
}

function zeroUsage(): ResourceUsage {
	return {
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		cost: 0,
		turns: 0,
		durationMs: 0,
	};
}

export class DeliveryRuntime {
	readonly #jobRuntime: JobRuntime;
	readonly #reviewer?: ReadonlyReviewer;
	readonly #diffCollector: DiffCollector;
	readonly #writerLeaseRegistry: WriterLeaseRegistry;

	constructor(options: DeliveryRuntimeOptions) {
		this.#jobRuntime = options.jobRuntime;
		this.#reviewer = options.reviewer;
		this.#diffCollector = options.diffCollector ?? new DiffCollector();
		this.#writerLeaseRegistry = options.writerLeaseRegistry ?? DEFAULT_WRITER_LEASE_REGISTRY;
	}

	async run(port: DeliveryWorkflowPort, options: DeliveryRunOptions = {}): Promise<DeliveryRunResult> {
		port.beginVerification();
		const workflow = port.workflow;
		const workflowDeadlineAtMs =
			workflow.budget.maxDurationMs === undefined
				? undefined
				: Date.parse(workflow.createdAt) + workflow.budget.maxDurationMs;
		const deliveryFingerprint = port.deliveryFingerprint;
		const rootTask = port.tasks.find(({ id }) => id === workflow.rootTaskId);
		if (!rootTask) {
			throw new Error(`Workflow ${workflow.id} has no root Task`);
		}
		const diff = this.#diffCollector.collect(workflow.request.cwd, port.tasks, port.deliveryBaseline);
		const unavailable = diff.files.filter((file) => file.unavailableReason);
		if (unavailable.length > 0) {
			const reason = `Delivery diff unavailable: ${unavailable.map((file) => `${file.path}: ${file.unavailableReason}`).join("; ")}`;
			port.failDelivery(reason);
			return {
				status: "failed",
				diff,
				verifications: port.verifications,
				risks: [],
				unfinishedItems: [reason],
				usage: zeroUsage(),
			};
		}
		const risks: string[] = [];
		const unfinishedItems: string[] = [];
		const jobUsage: ResourceUsage[] = [];
		const completedByRequirement = new Map(
			port.verifications
				.filter(
					(verification) =>
						deliveryFingerprint === undefined || verification.deliveryFingerprint === deliveryFingerprint,
				)
				.map((verification) => [verification.requirementId, verification]),
		);
		const hasRepairTask = port.tasks.some(({ kind }) => kind === "repair");
		// Reviews consume completed command evidence regardless of the Planner's requirement order.
		const requirements = [...port.currentPlan.verificationRequirements].sort(
			(left, right) => Number(left.kind === "review") - Number(right.kind === "review"),
		);
		for (const requirement of requirements) {
			const owningAgentTask = port.tasks.find(
				(task) =>
					task.kind === "agent" &&
					task.status === "succeeded" &&
					task.verificationRequirements.some(({ id }) => id === requirement.id),
			);
			if (!DELIVERY_KINDS.has(requirement.kind) && !(requirement.kind === "manual" && owningAgentTask)) {
				continue;
			}
			if (completedByRequirement.has(requirement.id)) {
				continue;
			}
			if (requirement.kind === "diff") {
				port.recordVerification({
					verificationId: `verification-${randomUUID()}`,
					requirementId: requirement.id,
					deliveryFingerprint,
					status: "passed",
					summary: diff.summary,
					evidenceRefs: diff.evidenceRefs,
				});
				continue;
			}
			if (requirement.kind === "review") {
				const existingReviewerVerification =
					!hasRepairTask &&
					port.verifications.some((verification) => {
						if (
							verification.requirementId !== requirement.id ||
							verification.status !== "passed" ||
							!verification.taskId
						) {
							return false;
						}
						const task = port.tasks.find(({ id }) => id === verification.taskId);
						return task?.kind === "agent" && task.recommendedAgentRole === "reviewer";
					});
				if (existingReviewerVerification) {
					continue;
				}
				const review = await this.#runReview(port, requirement.id, diff, rootTask, deliveryFingerprint);
				risks.push(...review.risks);
				unfinishedItems.push(...review.unfinishedItems);
				if (review.failureKind === "infrastructure" || review.failureKind === "confirmation") {
					port.failDelivery(review.summary);
					return {
						status: "failed",
						diff,
						verifications: port.verifications,
						risks,
						unfinishedItems,
						usage: sumResourceUsage(jobUsage),
					};
				}
				continue;
			}
			if (!requirement.command?.trim()) {
				const existingTaskVerification =
					!hasRepairTask &&
					port.verifications.some((verification) => {
						if (
							verification.requirementId !== requirement.id ||
							verification.status !== "passed" ||
							!verification.taskId
						) {
							return false;
						}
						return port.tasks.find(({ id }) => id === verification.taskId)?.status === "succeeded";
					});
				if (existingTaskVerification) {
					continue;
				}
				const sourceVerification =
					!hasRepairTask && owningAgentTask
						? port.verifications.find(
								(verification) =>
									verification.taskId === owningAgentTask.id && verification.status === "passed",
							)
						: undefined;
				if (sourceVerification) {
					port.recordVerification({
						verificationId: `verification-${randomUUID()}`,
						requirementId: requirement.id,
						deliveryFingerprint,
						status: "passed",
						summary: `Reused successful Agent Task evidence: ${sourceVerification.summary}`,
						evidenceRefs: sourceVerification.evidenceRefs,
					});
					continue;
				}
				port.recordVerification({
					verificationId: `verification-${randomUUID()}`,
					requirementId: requirement.id,
					deliveryFingerprint,
					status: "skipped",
					summary: `${requirement.kind} command is not configured`,
					skipReason: "Verification command is not configured",
				});
				continue;
			}
			const attemptId = `delivery-${randomUUID()}`;
			const remainingDurationMs =
				workflowDeadlineAtMs === undefined ? undefined : Math.floor(workflowDeadlineAtMs - Date.now());
			if (remainingDurationMs !== undefined && remainingDurationMs < 1) {
				throw new Error(`Workflow duration budget exhausted before verification command: ${requirement.command}`);
			}
			const lease = this.#writerLeaseRegistry.acquire({
				workspace: workflow.request.cwd,
				workflowId: workflow.id,
				taskId: rootTask.id,
				attemptId,
				ttlMs: workflow.budget.maxDurationMs ?? 10 * 60_000,
			});
			try {
				const job = this.#jobRuntime.queue({
					workflowId: workflow.id,
					taskId: rootTask.id,
					attemptId,
					command: requirement.command,
					cwd: workflow.request.cwd,
					timeoutMs: remainingDurationMs,
				});
				const result = await this.#jobRuntime.start(job.id);
				const durationMs =
					result.startedAt && result.endedAt
						? Math.max(0, Date.parse(result.endedAt) - Date.parse(result.startedAt))
						: 0;
				jobUsage.push({ ...zeroUsage(), durationMs });
				port.recordVerification({
					verificationId: `verification-${randomUUID()}`,
					requirementId: requirement.id,
					deliveryFingerprint,
					actor: { kind: "job", id: result.id },
					status: result.status === "succeeded" ? "passed" : "failed",
					summary:
						result.status === "succeeded"
							? `${requirement.kind} command passed`
							: (result.reason ?? `${requirement.kind} command ${result.status}`),
					evidenceRefs: [result.stdoutRef, result.stderrRef],
					command: result.command,
					exitCode: result.exitCode,
				});
			} finally {
				this.#writerLeaseRegistry.release(lease.id);
			}
		}
		const verifications = port.verifications.filter(
			(verification) =>
				deliveryFingerprint === undefined ||
				verification.deliveryFingerprint === deliveryFingerprint ||
				verification.taskId !== undefined,
		);
		const latest = new Map<string, VerificationResult>();
		for (const verification of verifications) {
			latest.set(verification.requirementId, verification);
		}
		const failed = port.currentPlan.verificationRequirements
			.filter(({ required }) => required)
			.map((requirement) => ({
				requirement,
				result: latest.get(requirement.id),
			}))
			.filter(({ result }) => result?.status === "failed");
		const skipped = port.currentPlan.verificationRequirements
			.filter(({ required }) => required)
			.map((requirement) => ({
				requirement,
				result: latest.get(requirement.id),
			}))
			.filter(({ result }) => result?.status === "skipped" || result === undefined);
		if (failed.length > 0) {
			const failedVerification = failed[0]?.result;
			if (!failedVerification) {
				throw new Error("Failed Verification result is missing");
			}
			const matchingFailures = port.verifications.filter(
				(verification) =>
					verification.status === "failed" &&
					verification.requirementId === failedVerification.requirementId &&
					verification.summary === failedVerification.summary &&
					verification.exitCode === failedVerification.exitCode,
			);
			const latestRepair = port.tasks.filter(({ kind }) => kind === "repair").at(-1);
			const repairChangedFiles = latestRepair
				? new Set([
						...(latestRepair.result?.changedFiles ?? []),
						...latestRepair.modifications.map(({ path }) => path),
					])
				: undefined;
			const stopReason =
				options.allowRepair === false
					? "Automatic Repair is disabled"
					: latestRepair?.status === "succeeded" && repairChangedFiles?.size === 0
						? `Repair Task ${latestRepair.id} produced no file changes`
						: matchingFailures.length > 1
							? `Verification ${failedVerification.requirementId} repeated the same failure`
							: undefined;
			if (stopReason) {
				const reasonCode =
					options.allowRepair === false
						? "repair.disabled"
						: latestRepair?.status === "succeeded" && repairChangedFiles?.size === 0
							? "repair.no_changes"
							: "repair.repeated_failure";
				port.failDelivery(stopReason);
				return {
					status: "failed",
					reasonCode,
					diff,
					verifications: port.verifications,
					risks,
					unfinishedItems: [...unfinishedItems, stopReason],
					usage: sumResourceUsage(jobUsage),
				};
			}
			try {
				const repairTask = port.createRepair(failedVerification.id);
				return {
					status: "repair_created",
					reasonCode: "repair.verification_failed",
					diff,
					verifications: port.verifications,
					repairTask,
					risks,
					unfinishedItems,
					usage: sumResourceUsage(jobUsage),
				};
			} catch (error) {
				const reason = error instanceof Error ? error.message : String(error);
				const errorCode =
					typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
						? error.code
						: undefined;
				port.failDelivery(reason);
				return {
					status: "failed",
					reasonCode:
						errorCode === "controller.repair_budget_exhausted"
							? "repair.budget_exhausted"
							: "repair.repeated_failure",
					diff,
					verifications: port.verifications,
					risks,
					unfinishedItems: [...unfinishedItems, reason],
					usage: sumResourceUsage(jobUsage),
				};
			}
		}
		if (skipped.length > 0) {
			const reason = `Required Verification unavailable: ${skipped.map(({ requirement }) => requirement.id).join(", ")}`;
			port.failDelivery(reason);
			return {
				status: "failed",
				diff,
				verifications: port.verifications,
				risks,
				unfinishedItems: [...unfinishedItems, reason],
				usage: sumResourceUsage(jobUsage),
			};
		}
		port.completeDelivery({
			summary: `Delivery completed: ${diff.summary}`,
			risks,
			unfinishedItems,
			deliveryFingerprint,
		});
		return {
			status: "completed",
			diff,
			verifications: port.verifications,
			risks,
			unfinishedItems,
			usage: sumResourceUsage(jobUsage),
		};
	}

	async #runReview(
		port: DeliveryWorkflowPort,
		requirementId: string,
		diff: ReturnType<DiffCollector["collect"]>,
		rootTask: DeliveryWorkflowPort["tasks"][number],
		deliveryFingerprint: string | undefined,
	): Promise<ReviewResult> {
		let review: ReviewResult;
		try {
			const commandRequirements = new Set(
				port.currentPlan.verificationRequirements
					.filter((requirement) => requirement.kind === "test" || requirement.kind === "build")
					.map((requirement) => requirement.id),
			);
			const latest = new Map(
				port.verifications
					.filter(
						(result) =>
							!result.taskId &&
							commandRequirements.has(result.requirementId) &&
							result.deliveryFingerprint === deliveryFingerprint,
					)
					.map((result) => [result.requirementId, result]),
			);
			const verificationEvidence = [...latest.values()].map((result) => {
				const job = this.#jobRuntime
					.jobs(port.workflow.id)
					.find(
						(candidate) =>
							candidate.command === result.command && result.evidenceRefs.includes(candidate.stdoutRef),
					);
				const logs = job ? this.#jobRuntime.logs(job.id) : undefined;
				const text = logs?.chunks.map((chunk) => `[${chunk.stream}] ${chunk.text}`).join("");
				return {
					result: structuredClone(result),
					logExcerpt: text?.slice(-4000),
					logsTruncated: logs ? logs.truncated || (text?.length ?? 0) > 4000 : undefined,
				};
			});
			review = this.#reviewer
				? await this.#reviewer.review({
						workflow: port.workflow,
						rootTask,
						diff,
						acceptanceRequirements: structuredClone(port.currentPlan.verificationRequirements),
						verificationEvidence,
					})
				: {
						status: "failed",
						summary: "Readonly Reviewer is not configured",
						evidenceRefs: [],
						risks: [],
						unfinishedItems: ["Readonly Reviewer is not configured"],
						failureKind: "infrastructure",
					};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			review = {
				status: "failed",
				summary: `Readonly Reviewer failed: ${message}`,
				evidenceRefs: [],
				risks: [],
				unfinishedItems: [message],
				failureKind: "infrastructure",
			};
		}
		port.recordVerification({
			verificationId: `verification-${randomUUID()}`,
			requirementId,
			deliveryFingerprint,
			actor: {
				kind: "agent",
				id: review.handoff?.agentId ?? `reviewer-${requirementId}`,
			},
			status: review.status,
			summary: review.summary,
			evidenceRefs: review.evidenceRefs,
		});
		return review;
	}
}
