import { defineTool } from "../extensions/types.ts";
import type { BashOperations } from "../tools/bash.ts";
import { createBashToolDefinition } from "../tools/bash.ts";

export const EVALUATION_SHELL_POLICY_VERSION = "workspace-search-v1";
export const EVALUATION_SHELL_TIMEOUT_SECONDS = 60;

const ROOT_PATH_ARGUMENT = /(?:^|\s)(?:-(?:path|literalpath)\s+)?["']?(?:\/|[a-z]:[\\/])["']?(?=\s|$)/i;

function rootSearchCommand(command: string): string | undefined {
	for (const segment of command.split(/&&|\|\||[;\n|]/)) {
		if (!ROOT_PATH_ARGUMENT.test(segment)) continue;
		if (/\bfind(?:\.exe)?\b/i.test(segment)) return "find";
		if (/\b(?:rg|fd)\b/i.test(segment)) return segment.match(/\b(?:rg|fd)\b/i)?.[0];
		if (/\bgrep\b/i.test(segment) && /\s-[a-z]*r[a-z]*(?:\s|$)/i.test(segment)) return "grep";
		if (/\bls\b/i.test(segment) && /\s-[a-z]*R[a-z]*(?:\s|$)/.test(segment)) return "ls";
		if (/\b(?:get-childitem|gci)\b/i.test(segment) && /\s-recurse(?=\s|["']|$)/i.test(segment)) {
			return "Get-ChildItem";
		}
		if (/\bdir\b/i.test(segment) && /\s\/s(?=\s|["']|$)/i.test(segment)) return "dir";
	}
	return undefined;
}

export function evaluationShellPolicyViolation(command: string): string | undefined {
	const searchCommand = rootSearchCommand(command);
	return searchCommand
		? `${searchCommand} cannot recursively search from a filesystem root during evaluation`
		: undefined;
}

export function createEvaluationBashToolDefinition(
	cwd: string,
	options: {
		readonly exposeSessionEnvironment?: boolean;
		readonly operations?: BashOperations;
		readonly timeoutSeconds?: number;
	} = {},
) {
	const timeoutSeconds = options.timeoutSeconds ?? EVALUATION_SHELL_TIMEOUT_SECONDS;
	const tool = createBashToolDefinition(cwd, {
		operations: options.operations,
		defaultTimeout: timeoutSeconds,
		exposeSessionEnvironment: options.exposeSessionEnvironment,
		maximumTimeout: timeoutSeconds,
		spawnHook: (context) => {
			const violation = evaluationShellPolicyViolation(context.command);
			if (violation) {
				throw new Error(
					`Evaluation shell policy rejected this command: ${violation}. Search inside ${cwd} or use PI_EVALUATION_NODE_MODULES for injected dependencies.`,
				);
			}
			return context;
		},
	});
	return defineTool({
		...tool,
		promptGuidelines: [
			...(tool.promptGuidelines ?? []),
			"Search only inside the current repository; filesystem-root recursive searches are rejected.",
			"Use PI_EVALUATION_NODE and PI_EVALUATION_NODE_MODULES instead of searching the machine for injected runtime dependencies.",
			"After making the required change, run the required verification before further optional investigation.",
		],
	});
}
