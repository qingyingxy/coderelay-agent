import { sep } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import type { ReadonlyFooterDataProvider } from "../src/core/footer-data-provider.ts";
import { FooterComponent, formatCwdForFooter } from "../src/modes/interactive/components/footer.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

type AssistantUsage = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: { total: number };
};

function createSession(options: {
	sessionName: string;
	modelId?: string;
	provider?: string;
	reasoning?: boolean;
	thinkingLevel?: string;
	usage?: AssistantUsage;
	branchUsage?: AssistantUsage;
	compactionUsage?: AssistantUsage;
	toolUsage?: AssistantUsage;
	workflowStatus?: string;
	budgetStatus?: string;
	contextPercent?: number | null;
}): AgentSession {
	const usage = options.usage;
	const entries: Array<Record<string, unknown>> = [];

	if (usage !== undefined) {
		entries.push({
			type: "message",
			message: {
				role: "assistant",
				usage,
			},
		});
	}

	if (options.branchUsage !== undefined) {
		entries.push({
			type: "branch_summary",
			usage: options.branchUsage,
		});
	}

	if (options.compactionUsage !== undefined) {
		entries.push({
			type: "compaction",
			usage: options.compactionUsage,
		});
	}

	if (options.toolUsage !== undefined) {
		entries.push({
			type: "message",
			message: {
				role: "toolResult",
				usage: options.toolUsage,
			},
		});
	}

	const session = {
		state: {
			model: {
				id: options.modelId ?? "test-model",
				provider: options.provider ?? "test",
				contextWindow: 200_000,
				reasoning: options.reasoning ?? false,
			},
			thinkingLevel: options.thinkingLevel ?? "off",
		},
		sessionManager: {
			getEntries: () => entries,
			getSessionName: () => options.sessionName,
			getCwd: () => "/tmp/project",
		},
		getContextUsage: () => ({
			contextWindow: 200_000,
			percent: options.contextPercent === undefined ? 12.3 : options.contextPercent,
		}),
		getWorkflowStatusLine: () => options.workflowStatus,
		getWorkflowView: () =>
			options.workflowStatus || options.budgetStatus
				? { budgetStatus: options.budgetStatus ?? "Budget: within limits" }
				: undefined,
		modelRuntime: {
			isUsingOAuth: () => false,
		},
	};

	return session as unknown as AgentSession;
}

function createFooterData(providerCount: number): ReadonlyFooterDataProvider {
	const provider = {
		getGitBranch: () => "main",
		getExtensionStatuses: () => new Map<string, string>(),
		getAvailableProviderCount: () => providerCount,
		onBranchChange: (callback: () => void) => {
			void callback;
			return () => {};
		},
	};

	return provider;
}

describe("formatCwdForFooter", () => {
	it("does not abbreviate sibling paths that share the home prefix", () => {
		expect(formatCwdForFooter("/home/user2", "/home/user")).toBe("/home/user2");
	});

	it("abbreviates the home directory and descendants", () => {
		expect(formatCwdForFooter("/home/user", "/home/user")).toBe("~");
		expect(formatCwdForFooter("/home/user/project", "/home/user")).toBe(`~${sep}project`);
	});
});

describe("FooterComponent width handling", () => {
	beforeAll(() => {
		initTheme(undefined, false);
	});

	it("keeps all lines within width for wide session names", () => {
		const width = 93;
		const session = createSession({ sessionName: "한글".repeat(30) });
		const footer = new FooterComponent(session, createFooterData(1));

		const lines = footer.render(width);
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	it("keeps stats line within width for wide model and provider names", () => {
		const width = 60;
		const session = createSession({
			sessionName: "",
			modelId: "模".repeat(30),
			provider: "공급자",
			reasoning: true,
			thinkingLevel: "high",
			usage: {
				input: 12_345,
				output: 6_789,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 1.234 },
			},
		});
		const footer = new FooterComponent(session, createFooterData(2));

		const lines = footer.render(width);
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	it("includes summary and tool result usage in the total cost", () => {
		const session = createSession({
			sessionName: "",
			usage: {
				input: 100,
				output: 10,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 0.5 },
			},
			branchUsage: {
				input: 20,
				output: 5,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 0.25 },
			},
			compactionUsage: {
				input: 5,
				output: 2,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 0.125 },
			},
			toolUsage: {
				input: 15,
				output: 3,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 0.375 },
			},
		});
		const footer = new FooterComponent(session, createFooterData(1));

		const statsLine = stripAnsi(footer.render(120).join("\n"));
		expect(statsLine).toContain("$1.250");
		expect(statsLine).toContain("累计用量：输入 140 · 输出 20 Token");
	});

	it("includes cache tokens in input volume while keeping cache details out of the footer", () => {
		const session = createSession({
			sessionName: "",
			usage: {
				input: 100,
				output: 10,
				cacheRead: 50,
				cacheWrite: 50,
				cost: { total: 0.001 },
			},
		});
		const footer = new FooterComponent(session, createFooterData(1));

		const statsLine = stripAnsi(footer.render(120)[1]);
		expect(statsLine).toContain("累计用量：输入 200 · 输出 10 Token");
		expect(statsLine).not.toContain("CH");
	});

	it("marks Kimi Coding costs as subscription estimates", () => {
		const session = createSession({
			sessionName: "",
			provider: "kimi-coding",
			usage: {
				input: 100,
				output: 10,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 1.234 },
			},
		});
		const footer = new FooterComponent(session, createFooterData(1));

		expect(stripAnsi(footer.render(120).join("\n"))).toContain("估算费用：$1.234（订阅折算）");
	});

	it("hides healthy budgets without duplicating the Workflow stage", () => {
		const width = 48;
		const session = createSession({
			sessionName: "",
			workflowStatus: "direct | executing | task: running | attempt: 1",
		});
		const footer = new FooterComponent(session, createFooterData(1));

		const lines = footer.render(width);
		expect(lines.join("\n")).not.toContain("Budget");
		expect(lines.join("\n")).not.toContain("executing");
		expect(visibleWidth(lines[2])).toBeLessThanOrEqual(width);
	});

	it.each(["Budget warning: tokens 90/100", "Budget exceeded: tokens 110/100"])(
		"keeps abnormal budgets visible: %s",
		(budgetStatus) => {
			const footer = new FooterComponent(createSession({ sessionName: "", budgetStatus }), createFooterData(1));
			const lines = footer.render(30);
			expect(stripAnsi(lines.join(""))).toContain(
				budgetStatus.includes("exceeded") ? "执行预算已超限" : "执行预算接近上限",
			);
			for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(30);
		},
	);

	it("distinguishes unknown context occupancy from zero and labels the offline demo", () => {
		const footer = new FooterComponent(
			createSession({ sessionName: "", provider: "faux", contextPercent: null }),
			createFooterData(1),
		);
		const text = stripAnsi(footer.render(100).join("\n"));
		expect(text).toContain("离线演示 · 无实际扣费");
		expect(text).toContain("上下文占用：待统计 / 容量 200k");
		expect(footer.render(0)).toEqual([]);
	});

	it("does not round a small positive cost down to zero", () => {
		const footer = new FooterComponent(
			createSession({
				sessionName: "",
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					cost: { total: 0.00001 },
				},
			}),
			createFooterData(1),
		);
		expect(stripAnsi(footer.render(100).join("\n"))).toContain("估算费用：<$0.001");
	});
});
