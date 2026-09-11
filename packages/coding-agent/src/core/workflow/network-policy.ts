import type { RetrySettings } from "../settings-manager.ts";

/** A request retry is independent of the Workflow's business repair allowance. */
export const WORKFLOW_NETWORK_RETRY = {
	enabled: true,
	maxRetries: 2,
	baseDelayMs: 2_000,
	provider: { maxRetries: 0 },
} satisfies RetrySettings;
