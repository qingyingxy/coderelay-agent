import type { AssistantMessage, ImageContent } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkflowView } from "../src/core/workflow/view.ts";
import type { SessionShutdownEvent } from "../src/index.ts";
import { runPrintMode } from "../src/modes/print-mode.ts";
import { ZERO_USAGE } from "./workflow/fixtures.ts";

type EmitEvent = SessionShutdownEvent;

type FakeExtensionRunner = {
	hasHandlers: (eventType: string) => boolean;
	emit: ReturnType<typeof vi.fn<(event: EmitEvent) => Promise<void>>>;
};

type FakeSession = {
	sessionManager: { getHeader: () => object | undefined };
	agent: { waitForIdle: () => Promise<void> };
	state: { messages: AssistantMessage[] };
	extensionRunner: FakeExtensionRunner;
	bindExtensions: ReturnType<typeof vi.fn>;
	subscribe: ReturnType<typeof vi.fn>;
	prompt: ReturnType<typeof vi.fn>;
	reload: ReturnType<typeof vi.fn>;
	getWorkflowView: ReturnType<typeof vi.fn>;
	waitForWorkflowAutomation: ReturnType<typeof vi.fn>;
	workflowClarificationPending: boolean;
};

type FakeRuntimeHost = {
	session: FakeSession;
	newSession: ReturnType<typeof vi.fn>;
	fork: ReturnType<typeof vi.fn>;
	switchSession: ReturnType<typeof vi.fn>;
	dispose: ReturnType<typeof vi.fn>;
	setRebindSession: ReturnType<typeof vi.fn>;
};

function createAssistantMessage(options?: {
	text?: string;
	stopReason?: AssistantMessage["stopReason"];
	errorMessage?: string;
}): AssistantMessage {
	return {
		role: "assistant",
		content: options?.text ? [{ type: "text", text: options.text }] : [],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-4o-mini",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: options?.stopReason ?? "stop",
		errorMessage: options?.errorMessage,
		timestamp: Date.now(),
	};
}

function createWorkflowView(): WorkflowView {
	const task: WorkflowView["tasks"][number] = {
		schemaVersion: 1,
		revision: 1,
		createdAt: "2026-07-27T00:00:00.000Z",
		updatedAt: "2026-07-27T00:00:01.000Z",
		id: "task-print",
		workflowId: "workflow-print",
		kind: "agent",
		accessMode: "writer",
		title: "Print Workflow",
		description: "Print Workflow",
		status: "succeeded",
		dependencyIds: [],
		budget: {},
		usage: ZERO_USAGE,
		attemptIds: [],
		verificationRequirements: [],
		modifications: [],
	};
	return {
		schemaVersion: 1,
		workflow: {
			schemaVersion: 1,
			revision: 2,
			createdAt: "2026-07-27T00:00:00.000Z",
			updatedAt: "2026-07-27T00:00:01.000Z",
			id: "workflow-print",
			status: "completed",
			rootTaskId: task.id,
			request: { text: "Print Workflow", cwd: "C:/repo", attachments: [] },
			budget: {},
			usage: ZERO_USAGE,
			result: {
				status: "completed",
				summary: "Print Workflow completed",
				completedTaskIds: [task.id],
				failedTaskIds: [],
				changedFiles: [],
				verificationIds: [],
				risks: [],
				unfinishedItems: [],
				usage: ZERO_USAGE,
				durationMs: 1,
			},
		},
		rootTask: task,
		tasks: [task],
		attempts: [],
		verifications: [],
		agents: [],
		jobs: [],
		statusLine: "direct | completed | root: task-print",
		reportLines: ["direct | completed | root: task-print", "Summary: Print Workflow completed"],
		decisions: [],
		budgetStatus: "Budget: within limits",
		availableActions: ["resume"],
	};
}

function createRuntimeHost(assistantMessage: AssistantMessage, workflow?: WorkflowView): FakeRuntimeHost {
	const extensionRunner: FakeExtensionRunner = {
		hasHandlers: (eventType: string) => eventType === "session_shutdown",
		emit: vi.fn(async () => {}),
	};

	const state = { messages: [assistantMessage] };

	const session: FakeSession = {
		sessionManager: { getHeader: () => undefined },
		agent: { waitForIdle: async () => {} },
		state,
		extensionRunner,
		bindExtensions: vi.fn(async () => {}),
		subscribe: vi.fn(() => () => {}),
		prompt: vi.fn(async () => {}),
		reload: vi.fn(async () => {}),
		getWorkflowView: vi.fn(() => workflow),
		waitForWorkflowAutomation: vi.fn(async () => undefined),
		workflowClarificationPending: false,
	};

	return {
		session,
		newSession: vi.fn(async () => undefined),
		fork: vi.fn(async () => ({ selectedText: "" })),
		switchSession: vi.fn(async () => undefined),
		dispose: vi.fn(async () => {
			await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		}),
		setRebindSession: vi.fn(),
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("runPrintMode", () => {
	it("emits session_shutdown in text mode", async () => {
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "done" }));
		const { session } = runtimeHost;
		const images: ImageContent[] = [{ type: "image", mimeType: "image/png", data: "abc" }];

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
			initialMessage: "Say done",
			initialImages: images,
		});

		expect(exitCode).toBe(0);
		expect(session.prompt).toHaveBeenCalledWith("Say done", { images });
		expect(session.extensionRunner.emit).toHaveBeenCalledTimes(1);
		expect(session.extensionRunner.emit).toHaveBeenCalledWith({ type: "session_shutdown", reason: "quit" });
	});

	it("emits session_shutdown in json mode", async () => {
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "done" }));
		const { session } = runtimeHost;

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "json",
			messages: ["hello"],
		});

		expect(exitCode).toBe(0);
		expect(session.prompt).toHaveBeenCalledWith("hello");
		expect(session.extensionRunner.emit).toHaveBeenCalledTimes(1);
		expect(session.extensionRunner.emit).toHaveBeenCalledWith({ type: "session_shutdown", reason: "quit" });
	});

	it("emits session_shutdown and returns non-zero on assistant error", async () => {
		const runtimeHost = createRuntimeHost(
			createAssistantMessage({ stopReason: "error", errorMessage: "provider failure" }),
		);
		const { session } = runtimeHost;
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
		});

		expect(exitCode).toBe(1);
		expect(errorSpy).toHaveBeenCalledWith("provider failure");
		expect(session.extensionRunner.emit).toHaveBeenCalledTimes(1);
		expect(session.extensionRunner.emit).toHaveBeenCalledWith({ type: "session_shutdown", reason: "quit" });
	});

	it("prints the authoritative Workflow report when requested", async () => {
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "done" }), createWorkflowView());
		const chunks: string[] = [];
		vi.spyOn(process.stdout, "write").mockImplementation(((chunk, encodingOrCallback, callback) => {
			chunks.push(String(chunk));
			const done = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
			done?.();
			return true;
		}) as typeof process.stdout.write);

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
			includeWorkflowReport: true,
		});

		expect(exitCode).toBe(0);
		expect(chunks.join("")).toContain("[workflow]\ndirect | completed | root: task-print");
	});

	it("emits a structured workflow_result in JSON mode", async () => {
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "done" }), createWorkflowView());
		const chunks: string[] = [];
		vi.spyOn(process.stdout, "write").mockImplementation(((chunk, encodingOrCallback, callback) => {
			chunks.push(String(chunk));
			const done = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
			done?.();
			return true;
		}) as typeof process.stdout.write);

		await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "json",
		});

		expect(chunks.join("")).toContain('"type":"workflow_result"');
		expect(chunks.join("")).toContain('"id":"workflow-print"');
	});
});
