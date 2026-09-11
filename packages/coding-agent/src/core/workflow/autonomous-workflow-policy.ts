import type { WorkflowAutomationPolicy } from "./autonomous-workflow-types.ts";
import type { ExecutionMode, UserRequest } from "./types.ts";

const FORCE_PLAN_PATTERNS = [
	/\b(delete|remove|drop|truncate|migrat(?:e|ion)|release|deploy|publish|permission|credential|secret|production)\b/i,
	/(删除|移除|清空|迁移|发布|部署|上线|权限|凭据|密钥|生产环境)/,
] as const;

export function requiresPlanMode(request: Pick<UserRequest, "text">): boolean {
	// A CLI declaration names commands to implement; it does not invoke those commands.
	// Only suppress destructive verb prefixes in that declaration, retaining other risk terms.
	const text = request.text.replace(
		/^(\s*(?:-\s*)?Add commands:\s*)([^\r\n]*)/gim,
		(_line, prefix: string, names: string) =>
			prefix + names.replace(/\b(?:delete|remove|drop|truncate)(?=-[a-z][a-z0-9-]*)/gi, "command"),
	);
	return FORCE_PLAN_PATTERNS.some((pattern) => pattern.test(text));
}

export function createWorkflowAutomationPolicy(
	mode: ExecutionMode,
	overrides: Partial<Omit<WorkflowAutomationPolicy, "mode">> = {},
): WorkflowAutomationPolicy {
	const maxConcurrency = overrides.maxConcurrency ?? 4;
	if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) {
		throw new Error("Workflow automation maxConcurrency must be a positive integer");
	}
	return {
		enabled: overrides.enabled ?? true,
		mode,
		autoSchedule: overrides.autoSchedule ?? true,
		autoVerify: overrides.autoVerify ?? true,
		autoRepair: overrides.autoRepair ?? true,
		maxConcurrency,
	};
}
