import { resolve } from "node:path";
import type {
	AgentBackend,
	AgentWorkspace,
	SpawnSubagentInput,
	SubagentModification,
	WorkspaceArtifact,
	WorkspaceRecoveryVerification,
} from "./types.ts";

export interface WorkspaceProviderCapabilities {
	readonly isolatedWriters: boolean;
	readonly conflictAnalysis: boolean;
	readonly reversibleIntegration: boolean;
}

export type ArtifactConflictReason =
	| "dependency_missing"
	| "path_overlap"
	| "lockfile_overlap"
	| "generated_file_overlap"
	| "patch_rejected"
	| "baseline_unavailable";

export interface ArtifactConflict {
	readonly reason: ArtifactConflictReason;
	readonly path?: string;
	readonly conflictingArtifactIds: readonly string[];
	readonly summary: string;
}

export interface ArtifactConflictAnalysis {
	readonly artifactId: string;
	readonly targetFingerprint: string;
	readonly baselineMatched: boolean;
	readonly changedSinceBaseline: readonly string[];
	readonly conflicts: readonly ArtifactConflict[];
}

export interface ArtifactApplyReceipt {
	readonly artifactId: string;
	readonly targetFingerprintBefore: string;
	readonly targetFingerprintAfter: string;
	readonly appliedAt: string;
}

export interface WorkspacePrepareRequest {
	readonly agentId: string;
	readonly backend: AgentBackend;
	readonly write: boolean;
	readonly input: SpawnSubagentInput;
}

export interface WorkspaceProvider {
	readonly capabilities?: WorkspaceProviderCapabilities;
	prepare(request: WorkspacePrepareRequest): Promise<AgentWorkspace>;
	createArtifact?(
		workspace: AgentWorkspace,
		modifications: readonly SubagentModification[],
	): Promise<WorkspaceArtifact | undefined>;
	restoreArtifact?(workspace: AgentWorkspace, artifact: WorkspaceArtifact): Promise<void>;
	integrateArtifact?(artifact: WorkspaceArtifact): Promise<WorkspaceArtifact>;
	analyzeArtifact?(
		artifact: WorkspaceArtifact,
		integratedArtifacts: readonly WorkspaceArtifact[],
	): Promise<ArtifactConflictAnalysis>;
	applyArtifact?(artifact: WorkspaceArtifact): Promise<ArtifactApplyReceipt>;
	rollbackArtifact?(artifact: WorkspaceArtifact, receipt: ArtifactApplyReceipt): Promise<void>;
	release(workspace: AgentWorkspace): Promise<void>;
	recover?(workspaces: readonly AgentWorkspace[]): Promise<void>;
	validateRecovery?(workspace: AgentWorkspace, artifact?: WorkspaceArtifact): Promise<WorkspaceRecoveryVerification>;
	cleanupOrphans?(ownedWorkspaceIds: ReadonlySet<string>): Promise<readonly string[]>;
}

/**
 * Default provider for the caller's current workspace.
 *
 * It owns no external resources, so release is intentionally a no-op. Worktree
 * implementations can use the same contract without changing Runtime semantics.
 */
export class CurrentWorkspaceProvider implements WorkspaceProvider {
	async prepare(request: WorkspacePrepareRequest): Promise<AgentWorkspace> {
		const path = resolve(request.input.cwd);
		return {
			id: `current:${path}`,
			path,
			kind: "current",
			repositoryIdentity: `current:${path.toLowerCase()}`,
			repositoryRoot: path,
			assurance: "shared",
		};
	}

	async release(_workspace: AgentWorkspace): Promise<void> {}

	async validateRecovery(): Promise<WorkspaceRecoveryVerification> {
		return {
			status: "available",
			checkedAt: new Date().toISOString(),
			details: ["Current Workspace remains available but is shared with the parent process"],
		};
	}
}
