import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AttemptId, IsoDateTime, TaskId, WorkflowId } from "./types.ts";

export interface WriterLease {
	readonly id: string;
	readonly ownerId: string;
	readonly workspace: string;
	readonly workflowId: WorkflowId;
	readonly taskId: TaskId;
	readonly attemptId?: AttemptId;
	readonly acquiredAt: IsoDateTime;
	readonly renewedAt: IsoDateTime;
	readonly expiresAt: IsoDateTime;
}

export interface AcquireWriterLeaseInput {
	readonly workspace: string;
	readonly workflowId: WorkflowId;
	readonly taskId: TaskId;
	readonly attemptId?: AttemptId;
	readonly ttlMs: number;
}

export interface WriterLeaseRegistryOptions {
	readonly now?: () => number;
	readonly createId?: () => string;
	/** Shared directory enables atomic cross-process coordination. Omit for an isolated in-memory Registry. */
	readonly storageDirectory?: string;
}

export class WriterLeaseError extends Error {
	readonly code: string;
	readonly activeLease?: WriterLease;

	constructor(code: string, message: string, activeLease?: WriterLease) {
		super(message);
		this.name = "WriterLeaseError";
		this.code = code;
		this.activeLease = activeLease ? structuredClone(activeLease) : undefined;
	}
}

function workspaceKey(workspace: string): string {
	return workspace.trim().replaceAll("\\", "/").replace(/\/+/g, "/").replace(/\/$/, "").toLowerCase();
}

export class WriterLeaseRegistry {
	readonly #leases = new Map<string, WriterLease>();
	readonly #now: () => number;
	readonly #createId: () => string;
	readonly #ownerId = randomUUID();
	readonly #storageDirectory?: string;
	readonly #ownedLeaseIds = new Set<string>();

	constructor(options: WriterLeaseRegistryOptions = {}) {
		this.#now = options.now ?? Date.now;
		this.#createId = options.createId ?? randomUUID;
		this.#storageDirectory = options.storageDirectory;
	}

	acquire(input: AcquireWriterLeaseInput): WriterLease {
		if (!input.workspace.trim()) {
			throw new WriterLeaseError("writer_lease.workspace_required", "Writer Lease workspace is required");
		}
		if (!Number.isFinite(input.ttlMs) || input.ttlMs <= 0) {
			throw new WriterLeaseError("writer_lease.invalid_ttl", "Writer Lease TTL must be positive");
		}
		const key = workspaceKey(input.workspace);
		const now = this.#now();
		const current = this.#activeLease(key, now);
		if (current) {
			if (
				this.#ownedLeaseIds.has(current.id) &&
				current.workflowId === input.workflowId &&
				current.taskId === input.taskId
			) {
				return this.renew(current.id, input.ttlMs);
			}
			throw new WriterLeaseError(
				"writer_lease.unavailable",
				`Workspace already has Writer Task ${current.taskId}`,
				current,
			);
		}
		const timestamp = new Date(now).toISOString();
		const lease: WriterLease = {
			id: this.#createId(),
			ownerId: this.#ownerId,
			workspace: key,
			workflowId: input.workflowId,
			taskId: input.taskId,
			attemptId: input.attemptId,
			acquiredAt: timestamp,
			renewedAt: timestamp,
			expiresAt: new Date(now + input.ttlMs).toISOString(),
		};
		if (this.#storageDirectory) {
			this.#persistNewLease(key, lease);
		} else {
			this.#leases.set(key, lease);
		}
		this.#ownedLeaseIds.add(lease.id);
		return structuredClone(lease);
	}

	renew(leaseId: string, ttlMs: number): WriterLease {
		if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
			throw new WriterLeaseError("writer_lease.invalid_ttl", "Writer Lease TTL must be positive");
		}
		if (!this.#ownedLeaseIds.has(leaseId)) {
			throw new WriterLeaseError("writer_lease.not_owner", `Writer Lease ${leaseId} is owned by another process`);
		}
		const lease = this.list().find(({ id }) => id === leaseId);
		if (!lease) {
			throw new WriterLeaseError("writer_lease.missing", `Writer Lease ${leaseId} does not exist`);
		}
		const key = workspaceKey(lease.workspace);
		const now = this.#now();
		if (Date.parse(lease.expiresAt) <= now) {
			this.#deleteLease(key);
			this.#ownedLeaseIds.delete(leaseId);
			throw new WriterLeaseError("writer_lease.expired", `Writer Lease ${leaseId} has expired`);
		}
		const renewed: WriterLease = {
			...lease,
			renewedAt: new Date(now).toISOString(),
			expiresAt: new Date(now + ttlMs).toISOString(),
		};
		if (this.#storageDirectory) {
			writeFileSync(this.#metadataPath(key), JSON.stringify(renewed), "utf8");
		} else {
			this.#leases.set(key, renewed);
		}
		return structuredClone(renewed);
	}

	release(leaseId: string): boolean {
		if (!this.#ownedLeaseIds.has(leaseId)) {
			return false;
		}
		const lease = this.list().find(({ id }) => id === leaseId);
		this.#ownedLeaseIds.delete(leaseId);
		return lease ? this.#deleteLease(workspaceKey(lease.workspace)) : false;
	}

	releaseWorkflow(workflowId: WorkflowId): number {
		let released = 0;
		for (const lease of this.list()) {
			if (lease.workflowId === workflowId && this.release(lease.id)) {
				released++;
			}
		}
		return released;
	}

	get(workspace: string): WriterLease | undefined {
		const lease = this.#activeLease(workspaceKey(workspace), this.#now());
		return lease ? structuredClone(lease) : undefined;
	}

	list(): readonly WriterLease[] {
		const now = this.#now();
		if (this.#storageDirectory) {
			if (!existsSync(this.#storageDirectory)) {
				return [];
			}
			const leases: WriterLease[] = [];
			for (const entry of readdirSync(this.#storageDirectory, { withFileTypes: true })) {
				if (!entry.isDirectory() || entry.name.endsWith(".tmp")) {
					continue;
				}
				const lease = this.#readStoredLease(entry.name);
				if (!lease) {
					continue;
				}
				if (Date.parse(lease.expiresAt) <= now) {
					this.#deleteStoredDirectory(entry.name);
					this.#ownedLeaseIds.delete(lease.id);
					continue;
				}
				leases.push(lease);
			}
			return leases.map((lease) => structuredClone(lease));
		}
		for (const key of this.#leases.keys()) {
			this.#activeLease(key, now);
		}
		return [...this.#leases.values()].map((lease) => structuredClone(lease));
	}

	#activeLease(key: string, now: number): WriterLease | undefined {
		const lease = this.#storageDirectory ? this.#readStoredLease(this.#storageKey(key)) : this.#leases.get(key);
		if (lease && Date.parse(lease.expiresAt) <= now) {
			this.#deleteLease(key);
			this.#ownedLeaseIds.delete(lease.id);
			return undefined;
		}
		return lease;
	}

	#persistNewLease(key: string, lease: WriterLease): void {
		const storageDirectory = this.#storageDirectory;
		if (!storageDirectory) {
			throw new Error("Writer Lease storage directory is not configured");
		}
		mkdirSync(storageDirectory, { recursive: true });
		const storageKey = this.#storageKey(key);
		const targetDirectory = join(storageDirectory, storageKey);
		const temporaryDirectory = join(storageDirectory, `${storageKey}.${process.pid}.${randomUUID()}.tmp`);
		mkdirSync(temporaryDirectory);
		try {
			writeFileSync(join(temporaryDirectory, "lease.json"), JSON.stringify(lease), "utf8");
			renameSync(temporaryDirectory, targetDirectory);
		} catch (error) {
			rmSync(temporaryDirectory, { recursive: true, force: true });
			const activeLease = this.#activeLease(key, this.#now());
			if (activeLease) {
				throw new WriterLeaseError(
					"writer_lease.unavailable",
					`Workspace already has Writer Task ${activeLease.taskId}`,
					activeLease,
				);
			}
			throw error;
		}
	}

	#storageKey(key: string): string {
		return createHash("sha256").update(key).digest("hex");
	}

	#metadataPath(key: string): string {
		const storageDirectory = this.#storageDirectory;
		if (!storageDirectory) {
			throw new Error("Writer Lease storage directory is not configured");
		}
		return join(storageDirectory, this.#storageKey(key), "lease.json");
	}

	#readStoredLease(storageKey: string): WriterLease | undefined {
		const storageDirectory = this.#storageDirectory;
		if (!storageDirectory) {
			return undefined;
		}
		const path = join(storageDirectory, storageKey, "lease.json");
		if (!existsSync(path)) {
			return undefined;
		}
		try {
			const value: unknown = JSON.parse(readFileSync(path, "utf8"));
			if (
				typeof value !== "object" ||
				value === null ||
				typeof (value as WriterLease).id !== "string" ||
				typeof (value as WriterLease).ownerId !== "string" ||
				typeof (value as WriterLease).workspace !== "string" ||
				typeof (value as WriterLease).workflowId !== "string" ||
				typeof (value as WriterLease).taskId !== "string" ||
				typeof (value as WriterLease).expiresAt !== "string"
			) {
				return undefined;
			}
			return value as WriterLease;
		} catch {
			return undefined;
		}
	}

	#deleteLease(key: string): boolean {
		if (this.#storageDirectory) {
			const storageKey = this.#storageKey(key);
			const path = join(this.#storageDirectory, storageKey);
			if (!existsSync(path)) {
				return false;
			}
			this.#deleteStoredDirectory(storageKey);
			return true;
		}
		return this.#leases.delete(key);
	}

	#deleteStoredDirectory(storageKey: string): void {
		const storageDirectory = this.#storageDirectory;
		if (storageDirectory) {
			rmSync(join(storageDirectory, storageKey), { recursive: true, force: true });
		}
	}
}

export const DEFAULT_WRITER_LEASE_REGISTRY = new WriterLeaseRegistry({
	storageDirectory: join(tmpdir(), "pi-cli-agent-writer-leases"),
});
