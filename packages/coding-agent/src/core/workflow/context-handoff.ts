/** Shared wire-size limit for Direct Workflow task briefs, not the History archive. */
export const MAX_HANDOFF_BYTES = 4000;
export const TARGET_HANDOFF_BYTES = 3000;
export const CORRECTION_HANDOFF_BYTES = 2400;

export function validateContextHandoff(handoff: string) {
	const actualBytes = Buffer.byteLength(handoff, "utf8");
	if (handoff.trim() && actualBytes <= MAX_HANDOFF_BYTES) return undefined;
	return {
		code: actualBytes > MAX_HANDOFF_BYTES ? "handoff_too_large" : "handoff_empty",
		actualBytes,
		maxBytes: MAX_HANDOFF_BYTES,
		targetBytes: CORRECTION_HANDOFF_BYTES,
		retryable: true,
		message: `task description must contain 1-${MAX_HANDOFF_BYTES} UTF-8 bytes (received ${actualBytes} bytes, not characters). This update was rejected before changing the task. Rewrite from scratch targeting at most ${CORRECTION_HANDOFF_BYTES} UTF-8 bytes, leaving ${MAX_HANDOFF_BYTES - CORRECTION_HANDOFF_BYTES} bytes of safety margin. Do not merely delete a few characters or aim just below ${MAX_HANDOFF_BYTES}. Preserve unresolved control state in compact clauses and leave detailed evidence in History.`,
	};
}
