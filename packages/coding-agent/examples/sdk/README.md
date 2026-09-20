# SDK Examples

Programmatic usage of pi-coding-agent via `createAgentSession()` and `createAgentSessionRuntime()`.

The runtime example shows how to build a recreate function that closes over process-global fixed inputs and recreates cwd-bound services and sessions as the active session cwd changes.

## Examples

| File | Description |
|------|-------------|
| `01-minimal.ts` | Simplest usage with all defaults |
| `02-custom-model.ts` | Select model and thinking level |
| `03-custom-prompt.ts` | Replace or modify system prompt |
| `04-skills.ts` | Discover, filter, or replace skills |
| `05-tools.ts` | Built-in tool allowlists |
| `06-extensions.ts` | Logging, blocking, result modification |
| `07-context-files.ts` | AGENTS.md context files |
| `08-slash-commands.ts` | File-based slash commands |
| `09-api-keys-and-oauth.ts` | API key resolution, OAuth config |
| `10-settings.ts` | Override compaction, retry, terminal settings |
| `11-sessions.ts` | In-memory, persistent, continue, list sessions |
| `12-full-control.ts` | Replace everything, no discovery |
| `13-session-runtime.ts` | Manage runtime-backed session replacement |
| `14-direct-workflow-demo.ts` | Offline scripted model with real file edits, failing/passing Node tests, a context cut and History recovery |
| `22-cli-agent-showcase.ts` | Fixed Plan approval, simulated Jobs and repair, completion gate, recovery and cancellation |
| `23-autonomous-workflow-showcase.ts` | Automatic scheduling, verification and repair with simulated execution |
| `25-config-workflow-demo.ts` | `--automatic`: a large local fixture triggers a real threshold cut, then implementation continues; without the flag: the original History recovery and repair demo |
| `26-planner-executor-demo.ts` | Offline Planner approval and real RPC Executor; `--interactive` uses the existing CLI commands and UI, while `--record` paces the SDK text example |

## Running

Initialize a fresh source checkout from the repository root (requires network access for dependencies and public model catalog metadata, not model weights):

```bash
npm install --ignore-scripts
npm run hydrate:model-data
```

Run the README showcase from the repository root (omit `--interactive` for fast assertions and text output):

```bash
npx tsx packages/coding-agent/examples/sdk/25-config-workflow-demo.ts --automatic --interactive
npx tsx packages/coding-agent/examples/sdk/26-planner-executor-demo.ts --interactive
```

```bash
cd packages/coding-agent
npx tsx examples/sdk/01-minimal.ts
```

Run the no-network Direct Workflow demo from the repository root:

```bash
npm run demo:direct-workflow
npm run demo:direct-workflow -- --interactive
```

The optional `--interactive` flag runs the same scripted task through the existing CLI UI with live Workflow status. It pauses between model steps for readability, displays the final report, then exits automatically.

This demo creates and cleans a temporary workspace. Its first Node test failure is intentional; success ends with `[demo] PASS`. Model replies are scripted, so this demonstrates tool execution and context continuity rather than model quality. See the [demo walkthrough](../../../../docs/cli-agent-showcase.md) for expected output and the supplementary Plan demos.

## Quick Reference

```typescript
import { getModel } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

const modelRuntime = await ModelRuntime.create();

// Minimal
const { session } = await createAgentSession({ modelRuntime });

// Custom model
const model = getModel("anthropic", "claude-opus-4-5");
const { session } = await createAgentSession({ model, thinkingLevel: "high", modelRuntime });

// Modify prompt
const loader = new DefaultResourceLoader({
  systemPromptOverride: (base) => `${base}\n\nBe concise.`,
});
await loader.reload();
const { session } = await createAgentSession({ resourceLoader: loader, modelRuntime });

// Read-only
const { session } = await createAgentSession({ tools: ["read", "grep", "find", "ls"], modelRuntime });

// In-memory
const { session } = await createAgentSession({
  sessionManager: SessionManager.inMemory(),
  modelRuntime,
});

// Full control
const customRuntime = await ModelRuntime.create({
  authPath: "/my/app/auth.json",
  modelsPath: "/my/app/models.json",
});
customRuntime.setRuntimeApiKey("anthropic", process.env.MY_KEY!);

const resourceLoader = new DefaultResourceLoader({
  systemPromptOverride: () => "You are helpful.",
  extensionFactories: [myExtension],
  skillsOverride: () => ({ skills: [], diagnostics: [] }),
  agentsFilesOverride: () => ({ agentsFiles: [] }),
  promptsOverride: () => ({ prompts: [], diagnostics: [] }),
});
await resourceLoader.reload();

const { session } = await createAgentSession({
  model,
  modelRuntime: customRuntime,
  resourceLoader,
  tools: ["read", "bash", "my_tool"],
  customTools: [myTool],
  sessionManager: SessionManager.inMemory(),
  settingsManager: SettingsManager.inMemory(),
});

// Run prompts
session.subscribe((event) => {
  if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
    process.stdout.write(event.assistantMessageEvent.delta);
  }
});
await session.prompt("Hello");
```

## Options

| Option | Default | Description |
|--------|---------|-------------|
| `modelRuntime` | Runtime using `agentDir/auth.json` and `models.json` | Canonical model and authentication runtime |
| `cwd` | `process.cwd()` | Working directory |
| `agentDir` | `~/.pi/agent` | Config directory |
| `model` | From settings/first available | Model to use |
| `thinkingLevel` | From settings/"off" | off, low, medium, high |
| `tools` | `["read", "bash", "edit", "write"]` built-ins | Allowlist tool names across built-in, extension, and custom tools |
| `customTools` | `[]` | Additional tool definitions |
| `resourceLoader` | DefaultResourceLoader | Resource loader for extensions, skills, prompts, themes, and context files |
| `sessionManager` | `SessionManager.create(cwd)` | Persistence |
| `settingsManager` | `SettingsManager.create(cwd, agentDir)` | Settings overrides |

## Events

```typescript
session.subscribe((event) => {
  switch (event.type) {
    case "message_update":
      if (event.assistantMessageEvent.type === "text_delta") {
        process.stdout.write(event.assistantMessageEvent.delta);
      }
      break;
    case "tool_execution_start":
      console.log(`Tool: ${event.toolName}`);
      break;
    case "tool_execution_end":
      console.log(`Result: ${event.result}`);
      break;
    case "agent_end":
      console.log("Done");
      break;
  }
});
```
