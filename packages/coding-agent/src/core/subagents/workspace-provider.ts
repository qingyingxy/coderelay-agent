import { resolve } from "node:path";
import type {
	AgentBackend,
	AgentWorkspace,
	SpawnSubagentInput,
	SubagentModification,
	WorkspaceArtifact,
} from "./types.ts";

export interface WorkspacePrepareRequest {
	readonly agentId: string;
	readonly backend: AgentBackend;
	readonly write: boolean;
	readonly input: SpawnSubagentInput;
}

export interface WorkspaceProvider {
	prepare(request: WorkspacePrepareRequest): Promise<AgentWorkspace>;
	createArtifact?(
		workspace: AgentWorkspace,
		modifications: readonly SubagentModification[],
	): Promise<WorkspaceArtifact | undefined>;
	integrateArtifact?(artifact: WorkspaceArtifact): Promise<WorkspaceArtifact>;
	release(workspace: AgentWorkspace): Promise<void>;
	recover?(workspaces: readonly AgentWorkspace[]): Promise<void>;
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
}
