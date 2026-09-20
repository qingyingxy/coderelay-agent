import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	type DeepSweTaskSet,
	parseDeepSweCliOptions,
	parseDeepSweTaskSet,
	verifyDeepSweTaskSet,
} from "../evals/context-window/verify-deepswe-task-set.ts";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const TASK_SET_PATH = resolve(TEST_DIR, "../evals/context-window/deepswe-task-set.json");

function sha256(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}

function loadTaskSet(): DeepSweTaskSet {
	return parseDeepSweTaskSet(JSON.parse(readFileSync(TASK_SET_PATH, "utf8")));
}

function testTaskSet(taskConfig: string): DeepSweTaskSet {
	return {
		schemaVersion: 1,
		id: "test-deepswe",
		source: {
			repositoryUrl: "https://github.com/example/deep-swe.git",
			revision: "1111111111111111111111111111111111111111",
		},
		tasks: [
			{
				id: "safe-import",
				title: "Safe import",
				taskPath: "tasks/safe-import",
				language: "python",
				category: "feature_request",
				upstreamRepositoryUrl: "https://github.com/example/sqlite-utils",
				upstreamBaseCommit: "2222222222222222222222222222222222222222",
				agentTimeoutSeconds: 10800,
				verifierTimeoutSeconds: 1800,
				resources: { cpus: 2, memoryMb: 8192, storageMb: 20480, gpus: 0 },
				assets: [{ path: "task.toml", bytes: Buffer.byteLength(taskConfig), sha256: sha256(taskConfig) }],
			},
		],
	};
}

describe("DeepSWE context-window task integration", () => {
	it("pins the sqlite-utils task and excludes the held-out solution", () => {
		const taskSet = loadTaskSet();
		expect(taskSet.source.revision).toBe("0b9fabbb63b9104d678fe965e1632f2dd9eaa2ea");
		expect(taskSet.tasks).toHaveLength(1);
		expect(taskSet.tasks[0]).toMatchObject({
			id: "sqlite-utils-safe-import-checkpoints",
			upstreamBaseCommit: "8d74ffc93292c604d5827e2b44fffedca0c28c19",
			agentTimeoutSeconds: 10800,
			verifierTimeoutSeconds: 1800,
			resources: { cpus: 2, memoryMb: 8192, storageMb: 20480, gpus: 0 },
		});
		expect(taskSet.tasks[0]?.assets).toHaveLength(8);
		expect(taskSet.tasks[0]?.assets.some(({ path }) => path.startsWith("solution/"))).toBe(false);
	});

	it("rejects unsafe paths, duplicate assets, and solution leakage", () => {
		const taskSet = loadTaskSet();
		const task = taskSet.tasks[0];
		if (!task) throw new Error("Missing DeepSWE task");
		expect(() =>
			parseDeepSweTaskSet({
				...taskSet,
				tasks: [{ ...task, taskPath: "../outside" }],
			}),
		).toThrow("normalized relative path");
		expect(() =>
			parseDeepSweTaskSet({
				...taskSet,
				tasks: [{ ...task, assets: [task.assets[0], task.assets[0]] }],
			}),
		).toThrow("duplicate paths");
		expect(() =>
			parseDeepSweTaskSet({
				...taskSet,
				tasks: [
					{
						...task,
						assets: [{ path: "solution/solution.patch", bytes: 1, sha256: "0".repeat(64) }],
					},
				],
			}),
		).toThrow("must not include held-out solution files");
	});

	it("verifies exact task assets and detects tampering", () => {
		const taskConfig = [
			'task_id = "safe-import"',
			'repository_url = "https://github.com/example/sqlite-utils"',
			'base_commit_hash = "2222222222222222222222222222222222222222"',
			"timeout_sec = 1800.0",
			"timeout_sec = 10800.0",
			"",
		].join("\n");
		const taskSet = testTaskSet(taskConfig);
		const root = mkdtempSync(join(tmpdir(), "pi-deepswe-task-"));
		const taskRoot = join(root, "tasks", "safe-import");
		try {
			mkdirSync(taskRoot, { recursive: true });
			writeFileSync(join(taskRoot, "task.toml"), taskConfig, "utf8");
			const passed = verifyDeepSweTaskSet(taskSet, root);
			expect(passed.passed).toBe(true);
			expect(passed.tasks[0]).toMatchObject({ metadataPassed: true, assetsPassed: true, passed: true });

			writeFileSync(join(taskRoot, "task.toml"), taskConfig.replaceAll("\n", "\r\n"), "utf8");
			expect(verifyDeepSweTaskSet(taskSet, root).tasks[0]).toMatchObject({
				metadataPassed: true,
				assetsPassed: false,
				passed: false,
			});

			writeFileSync(join(taskRoot, "task.toml"), `${taskConfig}# changed\n`, "utf8");
			const failed = verifyDeepSweTaskSet(taskSet, root);
			expect(failed.passed).toBe(false);
			expect(failed.tasks[0]).toMatchObject({ metadataPassed: true, assetsPassed: false, passed: false });
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("parses explicit verification and preflight paths", () => {
		expect(
			parseDeepSweCliOptions([
				"--verify-task-set",
				"--preflight",
				"--task-set",
				"task-set.json",
				"--source-root",
				"deep-swe",
			]),
		).toMatchObject({ verifyTaskSet: true, preflight: true });
		expect(() => parseDeepSweCliOptions([])).toThrow("--verify-task-set and/or --preflight");
		expect(() => parseDeepSweCliOptions(["--source-root"])).toThrow("requires a path");
	});
});
