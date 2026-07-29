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
		const deliveryFingerprint = port.deliveryFingerprint;
		const rootTask = port.tasks.find(({ id }) => id === workflow.rootTaskId);
		if (!rootTask) {
			throw new Error(`Workflow ${workflow.id} has no root Task`);
		}
		const diff = this.#diffCollector.collect(workflow.request.cwd, port.tasks);
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
		for (const requirement of port.currentPlan.verificationRequirements) {
			if (!DELIVERY_KINDS.has(requirement.kind)) {
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
				const review = await this.#runReview(port, requirement.id, diff, rootTask, deliveryFingerprint);
				risks.push(...review.risks);
				unfinishedItems.push(...review.unfinishedItems);
				continue;
			}
			if (!requirement.command?.trim()) {
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
					timeoutMs: workflow.budget.maxDurationMs,
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
			.map((requirement) => ({ requirement, result: latest.get(requirement.id) }))
			.filter(({ result }) => result?.status === "failed");
		const skipped = port.currentPlan.verificationRequirements
			.filter(({ required }) => required)
			.map((requirement) => ({ requirement, result: latest.get(requirement.id) }))
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
			review = this.#reviewer
				? await this.#reviewer.review({ workflow: port.workflow, rootTask, diff })
				: {
						status: "failed",
						summary: "Readonly Reviewer is not configured",
						evidenceRefs: [],
						risks: [],
						unfinishedItems: ["Readonly Reviewer is not configured"],
					};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			review = {
				status: "failed",
				summary: `Readonly Reviewer failed: ${message}`,
				evidenceRefs: [],
				risks: [],
				unfinishedItems: [message],
			};
		}
		port.recordVerification({
			verificationId: `verification-${randomUUID()}`,
			requirementId,
			deliveryFingerprint,
			actor: { kind: "agent", id: review.handoff?.agentId ?? `reviewer-${requirementId}` },
			status: review.status,
			summary: review.summary,
			evidenceRefs: review.evidenceRefs,
		});
		return review;
	}
}
