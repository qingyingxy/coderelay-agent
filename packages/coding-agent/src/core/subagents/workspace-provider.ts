import { resolve } from "node:path";
import type { AgentBackend, AgentWorkspace, SpawnSubagentInput } from "./types.ts";

export interface WorkspacePrepareRequest {
	readonly agentId: string;
	readonly backend: AgentBackend;
	readonly input: SpawnSubagentInput;
}

export interface WorkspaceProvider {
	prepare(request: WorkspacePrepareRequest): Promise<AgentWorkspace>;
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
		};
	}

	async release(_workspace: AgentWorkspace): Promise<void> {}
}
