import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WriterLeaseError, WriterLeaseRegistry } from "../../src/core/workflow/index.ts";

describe("Writer Lease", () => {
	it("allows one Writer per workspace and supports renewal and release", () => {
		let now = Date.parse("2026-07-26T00:00:00.000Z");
		let sequence = 0;
		const registry = new WriterLeaseRegistry({
			now: () => now,
			createId: () => `lease-${++sequence}`,
		});
		const first = registry.acquire({
			workspace: "C:\\repo",
			workflowId: "workflow-1",
			taskId: "task-1",
			ttlMs: 1_000,
		});

		expect(() =>
			registry.acquire({
				workspace: "C:/repo",
				workflowId: "workflow-2",
				taskId: "task-2",
				ttlMs: 1_000,
			}),
		).toThrow(WriterLeaseError);
		now += 500;
		expect(Date.parse(registry.renew(first.id, 2_000).expiresAt)).toBe(now + 2_000);
		expect(registry.release(first.id)).toBe(true);
		expect(registry.get("C:/repo")).toBeUndefined();
	});

	it("recovers expired leases and releases every lease owned by a Workflow", () => {
		let now = 1_000;
		let sequence = 0;
		const registry = new WriterLeaseRegistry({
			now: () => now,
			createId: () => `lease-${++sequence}`,
		});
		registry.acquire({
			workspace: "C:/repo-a",
			workflowId: "workflow-1",
			taskId: "task-1",
			ttlMs: 100,
		});
		now += 101;
		const replacement = registry.acquire({
			workspace: "C:/repo-a",
			workflowId: "workflow-2",
			taskId: "task-2",
			ttlMs: 100,
		});
		registry.acquire({
			workspace: "C:/repo-b",
			workflowId: "workflow-2",
			taskId: "task-3",
			ttlMs: 100,
		});

		expect(registry.releaseWorkflow("workflow-2")).toBe(2);
		expect(registry.list()).toEqual([]);
		expect(registry.release(replacement.id)).toBe(false);
	});

	it("coordinates independent Registry instances through an atomic cross-process lease directory", () => {
		const storageDirectory = mkdtempSync(join(tmpdir(), "pi-writer-lease-test-"));
		try {
			const firstRegistry = new WriterLeaseRegistry({
				createId: () => "lease-first",
				storageDirectory,
			});
			const secondRegistry = new WriterLeaseRegistry({
				createId: () => "lease-second",
				storageDirectory,
			});
			const first = firstRegistry.acquire({
				workspace: "C:/shared-repo",
				workflowId: "workflow-1",
				taskId: "task-1",
				ttlMs: 1_000,
			});

			expect(secondRegistry.get("C:\\shared-repo")).toMatchObject({
				id: first.id,
				workflowId: "workflow-1",
			});
			expect(() =>
				secondRegistry.acquire({
					workspace: "C:/shared-repo",
					workflowId: "workflow-2",
					taskId: "task-2",
					ttlMs: 1_000,
				}),
			).toThrow(WriterLeaseError);
			expect(firstRegistry.release(first.id)).toBe(true);
			expect(
				secondRegistry.acquire({
					workspace: "C:/shared-repo",
					workflowId: "workflow-2",
					taskId: "task-2",
					ttlMs: 1_000,
				}),
			).toMatchObject({
				id: "lease-second",
				workflowId: "workflow-2",
			});
			expect(firstRegistry.releaseWorkflow("workflow-2")).toBe(0);
			expect(secondRegistry.releaseWorkflow("workflow-2")).toBe(1);
			expect(firstRegistry.get("C:/shared-repo")).toBeUndefined();
		} finally {
			rmSync(storageDirectory, { recursive: true, force: true });
		}
	});
});
