import { APP_NAME } from "../config.ts";
import type { SourceInfo } from "./source-info.ts";

export type SlashCommandSource = "extension" | "prompt" | "skill";

export interface SlashCommandInfo {
	name: string;
	description?: string;
	source: SlashCommandSource;
	sourceInfo: SourceInfo;
}

export interface BuiltinSlashCommand {
	name: string;
	description: string;
	argumentHint?: string;
}

export const BUILTIN_SLASH_COMMANDS: ReadonlyArray<BuiltinSlashCommand> = [
	{ name: "settings", description: "Open settings menu" },
	{ name: "model", description: "Select model (opens selector UI)", argumentHint: "<provider/model>" },
	{ name: "scoped-models", description: "Enable/disable models for Ctrl+P cycling" },
	{ name: "export", description: "Export session (HTML default, or specify path: .html/.jsonl)" },
	{ name: "import", description: "Import and resume a session from a JSONL file" },
	{ name: "share", description: "Share session as a secret GitHub gist" },
	{ name: "copy", description: "Copy last agent message to clipboard" },
	{ name: "name", description: "Set session display name" },
	{ name: "session", description: "Show session info and stats" },
	{ name: "workflow", description: "Show the current or latest Workflow status" },
	{ name: "cancel", description: "Cancel the active Workflow", argumentHint: "[reason]" },
	{ name: "workflow-cancel", description: "Cancel the active Workflow" },
	{
		name: "workflow-resume",
		description: "List, continue, retry, or cancel persisted Workflows",
		argumentHint: "<list|continue|retry|cancel> [id]",
	},
	{ name: "plan", description: "Show the current Plan or use Plan mode for the next request" },
	{ name: "approve", description: "Approve the current Plan", argumentHint: "[comment]" },
	{ name: "reject", description: "Reject the current Plan", argumentHint: "[reason]" },
	{ name: "replan", description: "Create a revised Plan version", argumentHint: "[instructions]" },
	{ name: "tasks", description: "Show the current Plan Task tree and dispatchable Tasks" },
	{
		name: "task",
		description: "Inspect, retry, or cancel a Task",
		argumentHint: "show <id> | retry <id> | cancel <id> [reason]",
	},
	{
		name: "agents",
		description: "List Subagents or dispatch ready Tasks",
		argumentHint: "[dispatch [max-concurrency]]",
	},
	{
		name: "agent",
		description: "Spawn, inspect, steer, wait for, interrupt, or retry a Subagent",
		argumentHint: "<spawn|show|send|wait|interrupt|retry> <id> [details]",
	},
	{
		name: "jobs",
		description: "List background Jobs or dispatch ready Command Tasks",
		argumentHint: "[dispatch [max-concurrency]]",
	},
	{
		name: "job",
		description: "Run, inspect, stream, wait for, or kill a background Job",
		argumentHint: "<run|show|logs|wait|kill> <id> [details]",
	},
	{ name: "verify", description: "Run Diff, Review, Test, Build, Repair, and Completion Gate" },
	{ name: "changelog", description: "Show changelog entries" },
	{ name: "hotkeys", description: "Show all keyboard shortcuts" },
	{ name: "fork", description: "Create a new fork from a previous user message" },
	{ name: "clone", description: "Duplicate the current session at the current position" },
	{ name: "tree", description: "Navigate session tree (switch branches)" },
	{ name: "trust", description: "Save project trust decision for future sessions" },
	{ name: "provider", description: "Switch active provider", argumentHint: "<provider>" },
	{ name: "auth", description: "Manage provider credentials and active provider" },
	{ name: "login", description: "Configure provider authentication", argumentHint: "<provider>" },
	{ name: "logout", description: "Remove provider authentication" },
	{ name: "new", description: "Start a new session" },
	{ name: "compact", description: "Manually compact the session context" },
	{ name: "resume", description: "Resume a different session" },
	{ name: "reload", description: "Reload keybindings, extensions, skills, prompts, themes, and context files" },
	{ name: "quit", description: `Quit ${APP_NAME}` },
];
