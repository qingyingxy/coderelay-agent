import type { ConflictResolutionAttempt, IntegrationAttempt } from "./multi-writer-integration.ts";

export function formatIntegrationAttempts(
	attempts: readonly IntegrationAttempt[],
	writerCapacity: number,
): readonly string[] {
	if (attempts.length === 0) {
		return [`Integration attempts: (none) | Writer capacity: ${writerCapacity}`];
	}
	return [
		`Integration attempts: ${attempts.length} | Writer capacity: ${writerCapacity}`,
		...attempts.map(
			(attempt) =>
				`${attempt.id} | ${attempt.status} | artifact ${attempt.artifact.id} | task ${attempt.artifact.taskId ?? "(unknown)"}${attempt.conflictAttemptId ? ` | conflict ${attempt.conflictAttemptId}` : ""}${attempt.error ? ` | ${attempt.error}` : ""}`,
		),
	];
}

export function formatConflictAttempts(conflicts: readonly ConflictResolutionAttempt[]): readonly string[] {
	if (conflicts.length === 0) {
		return ["Conflict Resolution Attempts: (none)"];
	}
	return [
		`Conflict Resolution Attempts: ${conflicts.length}`,
		...conflicts.map(
			(conflict) =>
				`${conflict.id} | ${conflict.status} | artifact ${conflict.sourceArtifact.id} | baseline ${conflict.commonBaseline.slice(0, 12)} | ${conflict.analysis.conflicts.map(({ reason, path }) => `${reason}${path ? `:${path}` : ""}`).join(", ")}`,
		),
	];
}
