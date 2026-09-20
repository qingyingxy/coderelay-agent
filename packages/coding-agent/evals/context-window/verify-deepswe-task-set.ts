/**
 * Validates pinned DeepSWE task assets before any paid or containerized run.
 *
 * The solution directory is deliberately outside the manifest. Official Pier
 * isolation, not this validator, is responsible for hiding held-out assets.
 */

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPT_DIR = dirname(SCRIPT_PATH);
const DEFAULT_TASK_SET_PATH = resolve(SCRIPT_DIR, "deepswe-task-set.json");
const DEFAULT_SOURCE_ROOT = resolve(SCRIPT_DIR, "../../../../.artifacts/deep-swe-source");
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;

interface DeepSweSource {
	readonly repositoryUrl: string;
	readonly revision: string;
}

interface DeepSweTaskAsset {
	readonly path: string;
	readonly bytes: number;
	readonly sha256: string;
}

export interface DeepSweTask {
	readonly id: string;
	readonly title: string;
	readonly taskPath: string;
	readonly language: string;
	readonly category: string;
	readonly upstreamRepositoryUrl: string;
	readonly upstreamBaseCommit: string;
	readonly agentTimeoutSeconds: number;
	readonly verifierTimeoutSeconds: number;
	readonly resources: {
		readonly cpus: number;
		readonly memoryMb: number;
		readonly storageMb: number;
		readonly gpus: number;
	};
	readonly assets: readonly DeepSweTaskAsset[];
}

export interface DeepSweTaskSet {
	readonly schemaVersion: 1;
	readonly id: string;
	readonly source: DeepSweSource;
	readonly tasks: readonly DeepSweTask[];
}

interface DeepSweCliOptions {
	readonly taskSetPath: string;
	readonly sourceRoot: string;
	readonly preflight: boolean;
	readonly verifyTaskSet: boolean;
}

interface DeepSweAssetVerification {
	readonly path: string;
	readonly expectedBytes: number;
	readonly actualBytes?: number;
	readonly expectedSha256: string;
	readonly actualSha256?: string;
	readonly passed: boolean;
	readonly error?: string;
}

export interface DeepSweTaskVerification {
	readonly taskId: string;
	readonly metadataPassed: boolean;
	readonly assetsPassed: boolean;
	readonly assets: readonly DeepSweAssetVerification[];
	readonly passed: boolean;
}

export interface DeepSweTaskSetVerificationReport {
	readonly schemaVersion: 1;
	readonly taskSetId: string;
	readonly sourceRoot: string;
	readonly expectedRevision: string;
	readonly actualRevision?: string;
	readonly revisionPassed?: boolean;
	readonly tasks: readonly DeepSweTaskVerification[];
	readonly passed: boolean;
}

export interface DeepSweRuntimePreflight {
	readonly docker: { readonly available: boolean; readonly detail: string };
	readonly pier: { readonly available: boolean; readonly detail: string };
	readonly passed: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseNonEmptyString(value: unknown, path: string): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error(`${path} must be a non-empty string`);
	}
	return value;
}

function parsePositiveInteger(value: unknown, path: string, allowZero = false): number {
	if (!Number.isSafeInteger(value) || (allowZero ? (value as number) < 0 : (value as number) <= 0)) {
		throw new Error(`${path} must be ${allowZero ? "a non-negative" : "a positive"} integer`);
	}
	return value as number;
}

function parseCommit(value: unknown, path: string): string {
	const commit = parseNonEmptyString(value, path);
	if (!COMMIT_PATTERN.test(commit)) throw new Error(`${path} must be a lowercase 40-character commit hash`);
	return commit;
}

function parseUrl(value: unknown, path: string): string {
	const url = parseNonEmptyString(value, path);
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new Error(`${path} must be an absolute URL`);
	}
	if (parsed.protocol !== "https:") throw new Error(`${path} must use https`);
	return url;
}

function parseRelativePath(value: unknown, path: string): string {
	const candidate = parseNonEmptyString(value, path).replaceAll("\\", "/");
	const resolved = resolve("root", candidate);
	const relativePath = relative(resolve("root"), resolved).replaceAll("\\", "/");
	if (isAbsolute(candidate) || relativePath !== candidate || candidate.startsWith("../")) {
		throw new Error(`${path} must be a normalized relative path`);
	}
	return candidate;
}

function parseAsset(value: unknown, path: string): DeepSweTaskAsset {
	if (!isRecord(value)) throw new Error(`${path} must be an object`);
	const sha256 = parseNonEmptyString(value.sha256, `${path}.sha256`);
	if (!SHA256_PATTERN.test(sha256)) throw new Error(`${path}.sha256 must be a lowercase SHA-256 digest`);
	return {
		path: parseRelativePath(value.path, `${path}.path`),
		bytes: parsePositiveInteger(value.bytes, `${path}.bytes`),
		sha256,
	};
}

export function parseDeepSweTaskSet(value: unknown): DeepSweTaskSet {
	if (!isRecord(value)) throw new Error("task set must be an object");
	if (value.schemaVersion !== 1) throw new Error("task set schemaVersion must be 1");
	if (!isRecord(value.source)) throw new Error("task set source must be an object");
	if (!Array.isArray(value.tasks) || value.tasks.length === 0) {
		throw new Error("task set tasks must be a non-empty array");
	}

	const tasks = value.tasks.map((candidate, taskIndex): DeepSweTask => {
		const path = `tasks[${taskIndex}]`;
		if (!isRecord(candidate)) throw new Error(`${path} must be an object`);
		if (!isRecord(candidate.resources)) throw new Error(`${path}.resources must be an object`);
		if (!Array.isArray(candidate.assets) || candidate.assets.length === 0) {
			throw new Error(`${path}.assets must be a non-empty array`);
		}
		const assets = candidate.assets.map((asset, assetIndex) => parseAsset(asset, `${path}.assets[${assetIndex}]`));
		if (new Set(assets.map((asset) => asset.path)).size !== assets.length) {
			throw new Error(`${path}.assets contains duplicate paths`);
		}
		if (assets.some((asset) => asset.path === "solution" || asset.path.startsWith("solution/"))) {
			throw new Error(`${path}.assets must not include held-out solution files`);
		}
		return {
			id: parseNonEmptyString(candidate.id, `${path}.id`),
			title: parseNonEmptyString(candidate.title, `${path}.title`),
			taskPath: parseRelativePath(candidate.taskPath, `${path}.taskPath`),
			language: parseNonEmptyString(candidate.language, `${path}.language`),
			category: parseNonEmptyString(candidate.category, `${path}.category`),
			upstreamRepositoryUrl: parseUrl(candidate.upstreamRepositoryUrl, `${path}.upstreamRepositoryUrl`),
			upstreamBaseCommit: parseCommit(candidate.upstreamBaseCommit, `${path}.upstreamBaseCommit`),
			agentTimeoutSeconds: parsePositiveInteger(candidate.agentTimeoutSeconds, `${path}.agentTimeoutSeconds`),
			verifierTimeoutSeconds: parsePositiveInteger(
				candidate.verifierTimeoutSeconds,
				`${path}.verifierTimeoutSeconds`,
			),
			resources: {
				cpus: parsePositiveInteger(candidate.resources.cpus, `${path}.resources.cpus`),
				memoryMb: parsePositiveInteger(candidate.resources.memoryMb, `${path}.resources.memoryMb`),
				storageMb: parsePositiveInteger(candidate.resources.storageMb, `${path}.resources.storageMb`),
				gpus: parsePositiveInteger(candidate.resources.gpus, `${path}.resources.gpus`, true),
			},
			assets,
		};
	});
	if (new Set(tasks.map((task) => task.id)).size !== tasks.length) {
		throw new Error("task set contains duplicate task ids");
	}

	return {
		schemaVersion: 1,
		id: parseNonEmptyString(value.id, "task set id"),
		source: {
			repositoryUrl: parseUrl(value.source.repositoryUrl, "source.repositoryUrl"),
			revision: parseCommit(value.source.revision, "source.revision"),
		},
		tasks,
	};
}

function sha256(content: Buffer): string {
	return createHash("sha256").update(content).digest("hex");
}

function verifyAsset(taskRoot: string, asset: DeepSweTaskAsset): DeepSweAssetVerification {
	const path = resolve(taskRoot, asset.path);
	if (!existsSync(path)) {
		return {
			path: asset.path,
			expectedBytes: asset.bytes,
			expectedSha256: asset.sha256,
			passed: false,
			error: "missing",
		};
	}
	if (!statSync(path).isFile()) {
		return {
			path: asset.path,
			expectedBytes: asset.bytes,
			expectedSha256: asset.sha256,
			passed: false,
			error: "not a file",
		};
	}
	const content = readFileSync(path);
	const actualSha256 = sha256(content);
	return {
		path: asset.path,
		expectedBytes: asset.bytes,
		actualBytes: content.byteLength,
		expectedSha256: asset.sha256,
		actualSha256,
		passed: content.byteLength === asset.bytes && actualSha256 === asset.sha256,
	};
}

function readGitRevision(sourceRoot: string): string | undefined {
	if (!existsSync(resolve(sourceRoot, ".git"))) return undefined;
	const result = spawnSync(
		"git",
		["-c", `safe.directory=${sourceRoot.replaceAll("\\", "/")}`, "-C", sourceRoot, "rev-parse", "HEAD"],
		{ encoding: "utf8", shell: false },
	);
	if (result.status !== 0) return undefined;
	const revision = result.stdout.trim();
	return COMMIT_PATTERN.test(revision) ? revision : undefined;
}

export function verifyDeepSweTaskSet(
	taskSet: DeepSweTaskSet,
	sourceRoot: string,
): DeepSweTaskSetVerificationReport {
	const resolvedSourceRoot = resolve(sourceRoot);
	const actualRevision = readGitRevision(resolvedSourceRoot);
	const tasks = taskSet.tasks.map((task): DeepSweTaskVerification => {
		const taskRoot = resolve(resolvedSourceRoot, task.taskPath);
		const assets = task.assets.map((asset) => verifyAsset(taskRoot, asset));
		let metadataPassed = false;
		const taskConfigPath = resolve(taskRoot, "task.toml");
		if (existsSync(taskConfigPath)) {
			const taskConfig = readFileSync(taskConfigPath, "utf8");
			metadataPassed =
				taskConfig.includes(`task_id = "${task.id}"`) &&
				taskConfig.includes(`repository_url = "${task.upstreamRepositoryUrl}"`) &&
				taskConfig.includes(`base_commit_hash = "${task.upstreamBaseCommit}"`) &&
				taskConfig.includes(`timeout_sec = ${task.agentTimeoutSeconds}.0`) &&
				taskConfig.includes(`timeout_sec = ${task.verifierTimeoutSeconds}.0`);
		}
		const assetsPassed = assets.every((asset) => asset.passed);
		return { taskId: task.id, metadataPassed, assetsPassed, assets, passed: metadataPassed && assetsPassed };
	});
	const revisionPassed = actualRevision === undefined ? undefined : actualRevision === taskSet.source.revision;
	return {
		schemaVersion: 1,
		taskSetId: taskSet.id,
		sourceRoot: resolvedSourceRoot,
		expectedRevision: taskSet.source.revision,
		...(actualRevision ? { actualRevision, revisionPassed } : {}),
		tasks,
		passed: tasks.every((task) => task.passed) && revisionPassed !== false,
	};
}

function commandVersion(command: string, args: readonly string[]): { available: boolean; detail: string } {
	const result = spawnSync(command, [...args], { encoding: "utf8", shell: false });
	if (result.error) return { available: false, detail: result.error.message };
	const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
	return {
		available: result.status === 0,
		detail: output || `exit code ${result.status ?? "unknown"}`,
	};
}

export function preflightDeepSweRuntime(): DeepSweRuntimePreflight {
	const docker = commandVersion("docker", ["--version"]);
	const pier = commandVersion("pier", ["--version"]);
	return { docker, pier, passed: docker.available && pier.available };
}

export function parseDeepSweCliOptions(args: readonly string[]): DeepSweCliOptions {
	let taskSetPath = DEFAULT_TASK_SET_PATH;
	let sourceRoot = DEFAULT_SOURCE_ROOT;
	let preflight = false;
	let verifyTaskSet = false;
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--task-set" || arg === "--source-root") {
			const value = args[++index];
			if (!value || value.startsWith("-")) throw new Error(`${arg} requires a path`);
			if (arg === "--task-set") taskSetPath = resolve(value);
			else sourceRoot = resolve(value);
		} else if (arg === "--verify-task-set") {
			verifyTaskSet = true;
		} else if (arg === "--preflight") {
			preflight = true;
		} else {
			throw new Error(`Unknown argument: ${arg}`);
		}
	}
	if (!verifyTaskSet && !preflight) throw new Error("Pass --verify-task-set and/or --preflight");
	return { taskSetPath, sourceRoot, preflight, verifyTaskSet };
}

const isMain = process.argv[1] ? resolve(process.argv[1]) === resolve(SCRIPT_PATH) : false;
if (isMain) {
	const options = parseDeepSweCliOptions(process.argv.slice(2));
	const output: Record<string, unknown> = {};
	let passed = true;
	if (options.verifyTaskSet) {
		const taskSet = parseDeepSweTaskSet(JSON.parse(readFileSync(options.taskSetPath, "utf8")));
		const verification = verifyDeepSweTaskSet(taskSet, options.sourceRoot);
		output.taskSet = verification;
		passed = passed && verification.passed;
	}
	if (options.preflight) {
		const preflight = preflightDeepSweRuntime();
		output.runtime = preflight;
		passed = passed && preflight.passed;
	}
	console.log(JSON.stringify(output, null, 2));
	if (!passed) process.exitCode = 1;
}
