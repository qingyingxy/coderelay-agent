const MAX_TEXT = 6000;

export function boundedText(text: string, limit = MAX_TEXT): string {
	if (text.length <= limit) return text;
	const half = Math.floor((limit - 100) / 2);
	return `${text.slice(0, half)}\n[Truncated; full log retained by host, omitted ${text.length - half * 2} characters]\n${text.slice(-half)}`;
}

function record(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
}

/** Keep command evidence once, excluding nested stdout and large diagnostic snapshots. */
export function compactVerification(result: unknown, backendLog: string, processLog: string): string {
	const root = record(result);
	const detail = record(root.detail);
	const cases = Array.isArray(detail.browser) ? detail.browser : [];
	return JSON.stringify({
		passed: root.passed,
		infrastructureComplete: root.infrastructureComplete,
		error: root.error === undefined ? undefined : boundedText(String(root.error), 1000),
		backend: { exitCode: record(detail.backend).exitCode, log: boundedText(backendLog) },
		regression: { exitCode: record(detail.regression).exitCode },
		browser: cases.slice(0, 5).map(value => {
			const entry = record(value);
			return { name: entry.name, passed: entry.passed, evidence: entry.evidence,
				error: entry.error === undefined ? undefined : boundedText(String(entry.error), 1500) };
		}),
		process: boundedText(processLog, 1000),
	});
}
