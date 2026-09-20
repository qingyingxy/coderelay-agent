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
		message: `handoff must contain 1-${MAX_HANDOFF_BYTES} UTF-8 bytes (received ${actualBytes} bytes, not characters). This request was rejected before changing the task brief or requesting a cut. Rewrite from scratch targeting at most ${CORRECTION_HANDOFF_BYTES} UTF-8 bytes, leaving ${MAX_HANDOFF_BYTES - CORRECTION_HANDOFF_BYTES} bytes of safety margin. Do not merely delete a few characters or aim just below ${MAX_HANDOFF_BYTES}. Preserve unresolved work, hard constraints and next action in compact clauses; leave detailed evidence in History. Then call new_context again. Do not drop unresolved requirements or report completion for this rejected request.`,
	};
}
