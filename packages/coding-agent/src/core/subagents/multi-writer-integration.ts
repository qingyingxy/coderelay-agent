import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IsoDateTime, VerificationResult } from "../workflow/types.ts";
import { type WriterLease, WriterLeaseError, WriterLeaseRegistry } from "../workflow/writer-lease.ts";
import { WorkspaceIntegrationQueue } from "./integration-queue.ts";
import type { Handoff, WorkspaceArtifact } from "./types.ts";
import type { ArtifactApplyReceipt, ArtifactConflictAnalysis, WorkspaceProvider } from "./workspace-provider.ts";

export type IntegrationAttemptStatus =
	| "queued"
	| "analyzing"
	| "applying"
	| "verifying"
	| "integrated"
	| "conflicted"
	| "rolled_back"
	| "failed";

export interface PostIntegrationVerification {
	readonly reviewPassed: boolean;
	readonly affectedTestsPassed: boolean;
	readonly globalVerificationPassed: boolean;
	readonly results: readonly VerificationResult[];
	readonly summary: string;
}

export interface PostIntegrationVerifier {
	verify(input: {
		readonly artifact: WorkspaceArtifact;
		readonly handoff: Handoff;
		readonly receipt: ArtifactApplyReceipt;
	}): Promise<PostIntegrationVerification>;
}

export interface IntegrationAttempt {
	readonly id: string;
	readonly repositoryIdentity: string;
	readonly artifact: WorkspaceArtifact;
	readonly handoff: Handoff;
	readonly status: IntegrationAttemptStatus;
	readonly analysis?: ArtifactConflictAnalysis;
	readonly receipt?: ArtifactApplyReceipt;
	readonly verification?: PostIntegrationVerification;
	readonly conflictAttemptId?: string;
	readonly error?: string;
	readonly revision: number;
	readonly createdAt: IsoDateTime;
	readonly updatedAt: IsoDateTime;
}

export interface ConflictResolutionAttempt {
	readonly id: string;
	readonly integrationAttemptId: string;
	readonly repositoryIdentity: string;
	readonly sourceArtifact: WorkspaceArtifact;
	readonly sourceHandoff: Handoff;
	readonly conflictingArtifacts: readonly WorkspaceArtifact[];
	readonly conflictingHandoffs: readonly Handoff[];
	readonly commonBaseline: string;
	readonly targetFingerprint: string;
	readonly analysis: ArtifactConflictAnalysis;
	readonly status: "pending" | "resolved" | "rejected";
	readonly resolutionArtifactId?: string;
	readonly resolutionSummary?: string;
	readonly createdAt: IsoDateTime;
	readonly updatedAt: IsoDateTime;
}

export type IntegrationPersistenceRecord =
	| { readonly kind: "attempt"; readonly attempt: IntegrationAttempt }
	| { readonly kind: "conflict"; readonly conflict: ConflictResolutionAttempt };

export interface MultiWriterIntegrationPersistence {
	load(): readonly IntegrationPersistenceRecord[];
	append(record: IntegrationPersistenceRecord): void;
}

export interface MultiWriterIntegrationRuntimeOptions {
	readonly workspaceProvider: WorkspaceProvider;
	readonly verifier: PostIntegrationVerifier;
	readonly queue?: WorkspaceIntegrationQueue;
	readonly integrationLeaseRegistry?: WriterLeaseRegistry;
	readonly integrationLeaseTtlMs?: number;
	readonly integrationLeaseWaitMs?: number;
	readonly persistence?: MultiWriterIntegrationPersistence;
	readonly createId?: (kind: "integration" | "conflict") => string;
	readonly now?: () => IsoDateTime;
}

export interface IntegrateWorkspaceArtifactInput {
	readonly artifact: WorkspaceArtifact;
	readonly handoff: Handoff;
}

export class MultiWriterIntegrationError extends Error {
	readonly code: string;
	readonly artifact: WorkspaceArtifact;
	readonly conflict?: ConflictResolutionAttempt;

	constructor(code: string, message: string, artifact: WorkspaceArtifact, conflict?: ConflictResolutionAttempt) {
		super(message);
		this.name = "MultiWriterIntegrationError";
		this.code = code;
		this.artifact = structuredClone(artifact);
		this.conflict = conflict ? structuredClone(conflict) : undefined;
	}
}

export class MultiWriterIntegrationRuntime {
	readonly #provider: WorkspaceProvider;
	readonly #verifier: PostIntegrationVerifier;
	readonly #queue: WorkspaceIntegrationQueue;
	readonly #leaseRegistry: WriterLeaseRegistry;
	readonly #leaseTtlMs: number;
	readonly #leaseWaitMs: number;
	readonly #persistence: MultiWriterIntegrationPersistence | undefined;
	readonly #createId: (kind: "integration" | "conflict") => string;
	readonly #now: () => IsoDateTime;
	readonly #attempts = new Map<string, IntegrationAttempt>();
	readonly #conflicts = new Map<string, ConflictResolutionAttempt>();
	readonly #integratedArtifacts = new Map<string, WorkspaceArtifact[]>();
	readonly #handoffsByArtifact = new Map<string, Handoff>();

	constructor(options: MultiWriterIntegrationRuntimeOptions) {
		if (
			!options.workspaceProvider.capabilities?.isolatedWriters ||
			!options.workspaceProvider.capabilities.conflictAnalysis ||
			!options.workspaceProvider.capabilities.reversibleIntegration ||
			!options.workspaceProvider.analyzeArtifact ||
			!options.workspaceProvider.applyArtifact ||
			!options.workspaceProvider.rollbackArtifact
		) {
			throw new MultiWriterIntegrationError(
				"integration.provider_capability_missing",
				"Multi-Writer integration requires isolated Writers, conflict analysis, and reversible apply",
				{
					id: "unavailable",
					workspaceId: "unavailable",
					repositoryIdentity: "unavailable",
					baselineCommit: "unavailable",
					resultCommit: "unavailable",
					patchPath: "unavailable",
					changedFiles: [],
					status: "failed",
					createdAt: new Date().toISOString(),
				},
			);
		}
		this.#provider = options.workspaceProvider;
		this.#verifier = options.verifier;
		this.#queue = options.queue ?? new WorkspaceIntegrationQueue();
		this.#leaseRegistry =
			options.integrationLeaseRegistry ??
			new WriterLeaseRegistry({
				storageDirectory: join(tmpdir(), "pi-cli-agent-integration-leases"),
			});
		this.#leaseTtlMs = options.integrationLeaseTtlMs ?? 300_000;
		this.#leaseWaitMs = options.integrationLeaseWaitMs ?? 30_000;
		if (!Number.isFinite(this.#leaseTtlMs) || this.#leaseTtlMs <= 0) {
			throw new Error("Repository Integration Lease TTL must be positive");
		}
		if (!Number.isFinite(this.#leaseWaitMs) || this.#leaseWaitMs < 0) {
			throw new Error("Repository Integration Lease wait must be non-negative");
		}
		this.#persistence = options.persistence;
		this.#createId = options.createId ?? ((kind) => `${kind}-${randomUUID()}`);
		this.#now = options.now ?? (() => new Date().toISOString());
		for (const record of options.persistence?.load() ?? []) {
			if (record.kind === "attempt") {
				this.#attempts.set(record.attempt.id, structuredClone(record.attempt));
				if (record.attempt.status === "integrated") {
					const artifacts = this.#integratedArtifacts.get(record.attempt.repositoryIdentity) ?? [];
					artifacts.push(structuredClone(record.attempt.artifact));
					this.#integratedArtifacts.set(record.attempt.repositoryIdentity, artifacts);
					this.#handoffsByArtifact.set(record.attempt.artifact.id, structuredClone(record.attempt.handoff));
				}
			} else {
				this.#conflicts.set(record.conflict.id, structuredClone(record.conflict));
			}
		}
	}

	async integrate(input: IntegrateWorkspaceArtifactInput): Promise<WorkspaceArtifact> {
		this.#assertOwnership(input);
		const createdAt = this.#now();
		let attempt: IntegrationAttempt = {
			id: this.#createId("integration"),
			repositoryIdentity: input.artifact.repositoryIdentity,
			artifact: { ...structuredClone(input.artifact), status: "queued" },
			handoff: structuredClone(input.handoff),
			status: "queued",
			revision: 0,
			createdAt,
			updatedAt: createdAt,
		};
		this.#recordAttempt(attempt);
		return this.#queue.run(input.artifact.repositoryIdentity, async () => {
			let lease: WriterLease | undefined;
			let receipt: ArtifactApplyReceipt | undefined;
			try {
				lease = await this.#acquireIntegrationLease(input.artifact);
				attempt = this.#updateAttempt(attempt, {
					status: "analyzing",
					artifact: { ...attempt.artifact, status: "integrating", integrationAttemptId: attempt.id },
				});
				const integrated = this.#integratedArtifacts.get(input.artifact.repositoryIdentity) ?? [];
				const analysis = await this.#provider.analyzeArtifact!(input.artifact, integrated);
				attempt = this.#updateAttempt(attempt, { analysis });
				if (analysis.conflicts.length > 0) {
					const conflictingIds = new Set(
						analysis.conflicts.flatMap(({ conflictingArtifactIds }) => conflictingArtifactIds),
					);
					const conflictingArtifacts = integrated.filter(({ id }) => conflictingIds.has(id));
					const conflict = this.#createConflict(attempt, analysis, conflictingArtifacts);
					const artifact: WorkspaceArtifact = {
						...input.artifact,
						status: "conflicted",
						integrationAttemptId: attempt.id,
						conflictAttemptId: conflict.id,
						error: analysis.conflicts.map(({ summary }) => summary).join("; "),
					};
					attempt = this.#updateAttempt(attempt, {
						status: "conflicted",
						artifact,
						conflictAttemptId: conflict.id,
						error: artifact.error,
					});
					throw new MultiWriterIntegrationError(
						"integration.conflict",
						`Artifact ${artifact.id} requires Conflict Resolution Attempt ${conflict.id}`,
						artifact,
						conflict,
					);
				}
				attempt = this.#updateAttempt(attempt, { status: "applying" });
				receipt = await this.#provider.applyArtifact!(input.artifact);
				attempt = this.#updateAttempt(attempt, { status: "verifying", receipt });
				const verification = await this.#verifier.verify({
					artifact: input.artifact,
					handoff: input.handoff,
					receipt,
				});
				if (
					!verification.reviewPassed ||
					!verification.affectedTestsPassed ||
					!verification.globalVerificationPassed
				) {
					await this.#provider.rollbackArtifact!(input.artifact, receipt);
					const artifact: WorkspaceArtifact = {
						...input.artifact,
						status: "rolled_back",
						integrationAttemptId: attempt.id,
						rolledBackAt: this.#now(),
						error: verification.summary,
					};
					attempt = this.#updateAttempt(attempt, {
						status: "rolled_back",
						artifact,
						verification,
						error: verification.summary,
					});
					throw new MultiWriterIntegrationError("integration.verification_failed", verification.summary, artifact);
				}
				const artifact: WorkspaceArtifact = {
					...input.artifact,
					status: "integrated",
					integrationAttemptId: attempt.id,
					integratedAt: this.#now(),
				};
				attempt = this.#updateAttempt(attempt, {
					status: "integrated",
					artifact,
					verification,
				});
				this.#integratedArtifacts.set(input.artifact.repositoryIdentity, [...integrated, artifact]);
				this.#handoffsByArtifact.set(artifact.id, structuredClone(input.handoff));
				return structuredClone(artifact);
			} catch (error) {
				if (error instanceof MultiWriterIntegrationError) {
					throw error;
				}
				if (receipt) {
					try {
						await this.#provider.rollbackArtifact!(input.artifact, receipt);
						const artifact: WorkspaceArtifact = {
							...input.artifact,
							status: "rolled_back",
							integrationAttemptId: attempt.id,
							rolledBackAt: this.#now(),
							error: error instanceof Error ? error.message : String(error),
						};
						attempt = this.#updateAttempt(attempt, {
							status: "rolled_back",
							artifact,
							error: artifact.error,
						});
						throw new MultiWriterIntegrationError(
							"integration.apply_or_verify_failed",
							artifact.error ?? "Integration failed and was rolled back",
							artifact,
						);
					} catch (rollbackError) {
						if (rollbackError instanceof MultiWriterIntegrationError) {
							throw rollbackError;
						}
						const message = `Integration failed and rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`;
						const artifact: WorkspaceArtifact = {
							...input.artifact,
							status: "failed",
							integrationAttemptId: attempt.id,
							error: message,
						};
						this.#updateAttempt(attempt, { status: "failed", artifact, error: message });
						throw new MultiWriterIntegrationError("integration.rollback_failed", message, artifact);
					}
				}
				const message = error instanceof Error ? error.message : String(error);
				const artifact: WorkspaceArtifact = {
					...input.artifact,
					status: "failed",
					integrationAttemptId: attempt.id,
					error: message,
				};
				this.#updateAttempt(attempt, { status: "failed", artifact, error: message });
				throw new MultiWriterIntegrationError("integration.failed", message, artifact);
			} finally {
				if (lease) {
					this.#leaseRegistry.release(lease.id);
				}
			}
		});
	}

	attempts(repositoryIdentity?: string): readonly IntegrationAttempt[] {
		return [...this.#attempts.values()]
			.filter((attempt) => repositoryIdentity === undefined || attempt.repositoryIdentity === repositoryIdentity)
			.map((attempt) => structuredClone(attempt));
	}

	conflicts(repositoryIdentity?: string): readonly ConflictResolutionAttempt[] {
		return [...this.#conflicts.values()]
			.filter((conflict) => repositoryIdentity === undefined || conflict.repositoryIdentity === repositoryIdentity)
			.map((conflict) => structuredClone(conflict));
	}

	resolveConflict(
		conflictAttemptId: string,
		input: {
			readonly action: "resolved" | "rejected";
			readonly summary: string;
			readonly resolutionArtifactId?: string;
		},
	): ConflictResolutionAttempt {
		const current = this.#conflicts.get(conflictAttemptId);
		if (!current) {
			throw new Error(`Conflict Resolution Attempt ${conflictAttemptId} does not exist`);
		}
		if (current.status !== "pending") {
			throw new Error(`Conflict Resolution Attempt ${conflictAttemptId} is already ${current.status}`);
		}
		const summary = input.summary.trim();
		if (!summary) {
			throw new Error("Conflict resolution summary is required");
		}
		const updated: ConflictResolutionAttempt = {
			...current,
			status: input.action,
			resolutionSummary: summary,
			resolutionArtifactId: input.resolutionArtifactId,
			updatedAt: this.#now(),
		};
		this.#conflicts.set(updated.id, structuredClone(updated));
		this.#persistence?.append({ kind: "conflict", conflict: updated });
		return structuredClone(updated);
	}

	#createConflict(
		attempt: IntegrationAttempt,
		analysis: ArtifactConflictAnalysis,
		conflictingArtifacts: readonly WorkspaceArtifact[],
	): ConflictResolutionAttempt {
		const timestamp = this.#now();
		const conflict: ConflictResolutionAttempt = {
			id: this.#createId("conflict"),
			integrationAttemptId: attempt.id,
			repositoryIdentity: attempt.repositoryIdentity,
			sourceArtifact: structuredClone(attempt.artifact),
			sourceHandoff: structuredClone(attempt.handoff),
			conflictingArtifacts: conflictingArtifacts.map((artifact) => structuredClone(artifact)),
			conflictingHandoffs: conflictingArtifacts.flatMap((artifact) => {
				const handoff = this.#handoffsByArtifact.get(artifact.id);
				return handoff ? [structuredClone(handoff)] : [];
			}),
			commonBaseline: attempt.artifact.baselineCommit,
			targetFingerprint: analysis.targetFingerprint,
			analysis: structuredClone(analysis),
			status: "pending",
			createdAt: timestamp,
			updatedAt: timestamp,
		};
		this.#conflicts.set(conflict.id, structuredClone(conflict));
		this.#persistence?.append({ kind: "conflict", conflict });
		return conflict;
	}

	#updateAttempt(
		current: IntegrationAttempt,
		change: Partial<Omit<IntegrationAttempt, "id" | "repositoryIdentity" | "handoff" | "createdAt">>,
	): IntegrationAttempt {
		const updated: IntegrationAttempt = {
			...current,
			...structuredClone(change),
			revision: current.revision + 1,
			updatedAt: this.#now(),
		};
		this.#recordAttempt(updated);
		return updated;
	}

	#recordAttempt(attempt: IntegrationAttempt): void {
		this.#attempts.set(attempt.id, structuredClone(attempt));
		this.#persistence?.append({ kind: "attempt", attempt });
	}

	#assertOwnership(input: IntegrateWorkspaceArtifactInput): void {
		const { artifact, handoff } = input;
		if (
			!artifact.workflowId ||
			!artifact.taskId ||
			!artifact.attemptId ||
			!artifact.agentId ||
			artifact.workflowId !== handoff.workflowId ||
			artifact.taskId !== handoff.taskId ||
			artifact.attemptId !== handoff.attemptId ||
			artifact.agentId !== handoff.agentId
		) {
			throw new MultiWriterIntegrationError(
				"integration.ownership_mismatch",
				`Artifact ${artifact.id} and Handoff ownership do not match`,
				artifact,
			);
		}
	}

	async #acquireIntegrationLease(artifact: WorkspaceArtifact): Promise<WriterLease> {
		const deadline = Date.now() + this.#leaseWaitMs;
		for (;;) {
			try {
				return this.#leaseRegistry.acquire({
					workspace: `integration:${artifact.repositoryIdentity}`,
					workflowId: artifact.workflowId!,
					taskId: artifact.taskId!,
					attemptId: artifact.attemptId,
					ttlMs: this.#leaseTtlMs,
				});
			} catch (error) {
				if (
					!(error instanceof WriterLeaseError) ||
					error.code !== "writer_lease.unavailable" ||
					Date.now() >= deadline
				) {
					throw error;
				}
				await new Promise<void>((resolve) => setTimeout(resolve, 50));
			}
		}
	}
}
