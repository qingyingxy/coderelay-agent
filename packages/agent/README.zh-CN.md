# @earendil-works/pi-agent-core

带状态的 agent 运行时，支持工具执行与事件流。基于 `@earendil-works/pi-ai` 构建。

> 本文件是 [README.md](./README.md) 的中文副本。代码块、接口名和命令保持原样；如中文说明与英文原文存在细微差异，以英文原文为准。

## Installation

```bash
npm install @earendil-works/pi-agent-core
```

## Quick Start

```typescript
import { Agent } from "@earendil-works/pi-agent-core";
import { getModel } from "@earendil-works/pi-ai";

const agent = new Agent({
  initialState: {
    systemPrompt: "You are a helpful assistant.",
    model: getModel("anthropic", "claude-sonnet-4-20250514"),
  },
});

agent.subscribe((event) => {
  if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
    process.stdout.write(event.assistantMessageEvent.delta);
  }
});

await agent.prompt("Hello!");
```

## Core Concepts

### AgentMessage vs LLM Message

agent 内部处理的是 `AgentMessage`。它比底层 LLM 消息更宽松，可以同时容纳：

- 标准 LLM 消息：`user`、`assistant`、`toolResult`
- 通过 declaration merging 扩展出来的应用自定义消息类型

LLM 本身只理解 `user`、`assistant` 和 `toolResult`。因此 `convertToLlm` 负责在发起模型请求前，把 agent 里的消息筛选并转换成 LLM 可接受的结构。

### Message Flow

```text
AgentMessage[] -> transformContext() -> AgentMessage[] -> convertToLlm() -> Message[] -> LLM
                    (optional)                           (required)
```

1. `transformContext`：在调用模型前对上下文做处理，例如裁剪历史消息、注入外部上下文、压缩旧内容。
2. `convertToLlm`：把 UI 专用或业务专用消息过滤掉，并转换成标准 LLM 消息。

## Event Flow

agent 通过事件驱动 UI 和上层逻辑。理解事件顺序后，才能正确实现流式渲染、工具状态展示和收尾逻辑。

### prompt() Event Sequence

调用 `prompt("Hello")` 时，通常会经历如下顺序：

```text
prompt("Hello")
|- agent_start
|- turn_start
|- message_start   { message: userMessage }
|- message_end     { message: userMessage }
|- message_start   { message: assistantMessage }
|- message_update  { message: partial... }
|- message_update  { message: partial... }
|- message_end     { message: assistantMessage }
|- turn_end        { message, toolResults: [] }
\- agent_end       { messages: [...] }
```

### With Tool Calls

如果 assistant 发起了工具调用，事件流会继续进入工具执行阶段：

```text
prompt("Read config.json")
|- agent_start
|- turn_start
|- message_start/end  { userMessage }
|- message_start      { assistantMessage with toolCall }
|- message_update...
|- message_end        { assistantMessage }
|- tool_execution_start  { toolCallId, toolName, args }
|- tool_execution_update { partialResult }
|- tool_execution_end    { toolCallId, result }
|- message_start/end  { toolResultMessage }
|- turn_end           { message, toolResults: [toolResult] }
|
|- turn_start
|- message_start      { assistantMessage }
|- message_update...
|- message_end
|- turn_end
\- agent_end
```

工具执行模式可配置：

- `parallel`：默认模式。先顺序做 preflight，再并发执行允许并发的工具。
- `sequential`：逐个执行工具，行为与旧实现一致。

补充规则：

- 任何一个工具调用命中了 `executionMode: "sequential"` 的工具时，整批工具都退回到顺序执行。
- `beforeToolCall` 在参数校验后、真正执行前运行，可用于拦截或拒绝调用。
- `afterToolCall` 在工具执行后、事件落地前运行，可用于附加元数据或设置 `terminate: true`。
- 当一批工具的所有最终结果都带有 `terminate: true` 时，agent 会跳过后续自动 LLM 跟进调用。

### continue() Event Sequence

`continue()` 会从当前上下文继续，而不是先插入一条新的用户消息。常用于失败重试。

```typescript
await agent.continue();
```

当前上下文里的最后一条消息必须是 `user` 或 `toolResult`，不能是 `assistant`。

### Event Types

| Event | Description |
|-------|-------------|
| `agent_start` | agent 开始执行 |
| `agent_end` | 本次运行的最终事件；如果订阅者是异步的，仍会等待其完成 |
| `turn_start` | 新的一轮开始（一次 LLM 调用，加上其后的工具执行） |
| `turn_end` | 本轮完成，带上 assistant 消息和工具结果 |
| `message_start` | 任意消息开始写入 |
| `message_update` | 仅 assistant 会触发，包含流式 delta |
| `message_end` | 消息完成 |
| `tool_execution_start` | 工具开始执行 |
| `tool_execution_update` | 工具流式更新 |
| `tool_execution_end` | 工具执行结束 |

`Agent.subscribe()` 的监听器会按注册顺序等待执行。`agent_end` 表示后续不会再有新的 loop 事件，但 `await agent.waitForIdle()` 和 `await agent.prompt(...)` 只有在所有被等待的 `agent_end` 监听器执行完之后才会真正 settle。

## Agent Options

```typescript
const agent = new Agent({
  initialState: {
    systemPrompt: string,
    model: Model<any>,
    thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh",
    tools: AgentTool<any>[],
    messages: AgentMessage[],
  },

  convertToLlm: (messages) => messages.filter(...),
  transformContext: async (messages, signal) => pruneOldMessages(messages),
  steeringMode: "one-at-a-time",
  followUpMode: "one-at-a-time",
  streamFn: streamProxy,
  sessionId: "session-123",
  getApiKey: async (provider) => refreshToken(),
  toolExecution: "parallel",
  beforeToolCall: async ({ toolCall, args, context }) => {
    if (toolCall.name === "bash") {
      return { block: true, reason: "bash is disabled" };
    }
  },
  afterToolCall: async ({ toolCall, result, isError, context }) => {
    if (toolCall.name === "notify_done" && !isError) {
      return { terminate: true };
    }
    if (!isError) {
      return { details: { ...result.details, audited: true } };
    }
  },
  thinkingBudgets: {
    minimal: 128,
    low: 512,
    medium: 1024,
    high: 2048,
  },
});
```

这组配置大体分成几类：

- 初始状态：系统提示词、模型、思考级别、工具、消息历史
- 上下文转换：`transformContext`、`convertToLlm`
- 运行模式：`steeringMode`、`followUpMode`、`toolExecution`
- 扩展点：`streamFn`、`beforeToolCall`、`afterToolCall`
- 会话和预算：`sessionId`、`getApiKey`、`thinkingBudgets`

## Agent State

```typescript
interface AgentState {
  systemPrompt: string;
  model: Model<any>;
  thinkingLevel: ThinkingLevel;
  tools: AgentTool<any>[];
  messages: AgentMessage[];
  readonly isStreaming: boolean;
  readonly streamingMessage?: AgentMessage;
  readonly pendingToolCalls: ReadonlySet<string>;
  readonly errorMessage?: string;
}
```

通过 `agent.state` 访问当前状态。

注意点：

- 给 `agent.state.tools` 或 `agent.state.messages` 重新赋值时，会复制最外层数组。
- 但如果你继续修改返回的数组内容，仍然是在修改当前状态对象。
- 流式生成中，`agent.state.streamingMessage` 会保存当前尚未完成的 assistant 消息。
- `agent.state.isStreaming` 会一直保持为 `true`，直到包含异步 `agent_end` 监听器在内的所有收尾逻辑都完成。

## Methods

### Prompting

```typescript
await agent.prompt("Hello");

await agent.prompt("What's in this image?", [
  { type: "image", data: base64Data, mimeType: "image/jpeg" }
]);

await agent.prompt({ role: "user", content: "Hello", timestamp: Date.now() });

await agent.continue();
```

### State Management

```typescript
agent.state.systemPrompt = "New prompt";
agent.state.model = getModel("openai", "gpt-4o");
agent.state.thinkingLevel = "medium";
agent.state.tools = [myTool];
agent.toolExecution = "sequential";
agent.beforeToolCall = async ({ toolCall }) => undefined;
agent.afterToolCall = async ({ toolCall, result }) => undefined;
agent.state.messages = newMessages;
agent.state.messages.push(message);
agent.reset();
```

### Session and Thinking Budgets

```typescript
agent.sessionId = "session-123";

agent.thinkingBudgets = {
  minimal: 128,
  low: 512,
  medium: 1024,
  high: 2048,
};
```

### Control

```typescript
agent.abort();
await agent.waitForIdle();
```

### Events

```typescript
const unsubscribe = agent.subscribe(async (event, signal) => {
  if (event.type === "agent_end") {
    await flushSessionState(signal);
  }
});
unsubscribe();
```

## Steering and Follow-up

steering 用来在 agent 还在处理中时插队，follow-up 用来在 agent 原本准备停下后继续追加工作。

```typescript
agent.steeringMode = "one-at-a-time";
agent.followUpMode = "one-at-a-time";

agent.steer({
  role: "user",
  content: "Stop! Do this instead.",
  timestamp: Date.now(),
});

agent.followUp({
  role: "user",
  content: "Also summarize the result.",
  timestamp: Date.now(),
});

const steeringMode = agent.steeringMode;
const followUpMode = agent.followUpMode;

agent.clearSteeringQueue();
agent.clearFollowUpQueue();
agent.clearAllQueues();
```

行为规则：

1. 当一轮结束后检测到 steering 消息时，当前 assistant 触发的工具都已经执行完毕。
2. steering 消息会被插入上下文，并在下一轮立即送入模型。
3. follow-up 只有在没有工具调用、也没有 steering 消息时才会处理。

## Custom Message Types

可以通过 declaration merging 扩展 `AgentMessage`：

```typescript
declare module "@earendil-works/pi-agent-core" {
  interface CustomAgentMessages {
    notification: { role: "notification"; text: string; timestamp: number };
  }
}
```

然后在 `convertToLlm` 里决定如何处理：

```typescript
const agent = new Agent({
  convertToLlm: (messages) => messages.flatMap(m => {
    if (m.role === "notification") return [];
    return [m];
  }),
});
```

## Tools

工具用 `AgentTool` 定义：

```typescript
import { Type } from "typebox";

const readFileTool: AgentTool = {
  name: "read_file",
  label: "Read File",
  description: "Read a file's contents",
  parameters: Type.Object({
    path: Type.String({ description: "File path" }),
  }),
  executionMode: "sequential",
  execute: async (toolCallId, params, signal, onUpdate) => {
    const content = await fs.readFile(params.path, "utf-8");

    onUpdate?.({ content: [{ type: "text", text: "Reading..." }], details: {} });

    return {
      content: [{ type: "text", text: content }],
      details: { path: params.path, size: content.length },
    };
  },
};

agent.state.tools = [readFileTool];
```

### Error Handling

工具失败时应该 `throw`，不要把错误文本当正常内容返回：

```typescript
execute: async (toolCallId, params, signal, onUpdate) => {
  if (!fs.existsSync(params.path)) {
    throw new Error(`File not found: ${params.path}`);
  }
  return { content: [{ type: "text", text: "..." }] };
}
```

agent 会捕获异常，并以 `isError: true` 的 `toolResult` 发回给模型。

## Proxy Usage

浏览器或受控前端如果要经由后端代理请求模型，可以自定义 `streamFn`：

```typescript
import { Agent, streamProxy } from "@earendil-works/pi-agent-core";

const agent = new Agent({
  streamFn: (model, context, options) =>
    streamProxy(model, context, {
      ...options,
      authToken: "...",
      proxyUrl: "https://your-server.com",
    }),
});
```

## Low-Level API

如果不想使用 `Agent` 类，而是想自己控制 loop，可直接使用低层 API：

```typescript
import { agentLoop, agentLoopContinue } from "@earendil-works/pi-agent-core";

const context: AgentContext = {
  systemPrompt: "You are helpful.",
  messages: [],
  tools: [],
};

const config: AgentLoopConfig = {
  model: getModel("openai", "gpt-4o"),
  convertToLlm: (msgs) => msgs.filter(m => ["user", "assistant", "toolResult"].includes(m.role)),
  toolExecution: "parallel",
  beforeToolCall: async ({ toolCall, args, context }) => undefined,
  afterToolCall: async ({ toolCall, result, isError, context }) => undefined,
};

const userMessage = { role: "user", content: "Hello", timestamp: Date.now() };

for await (const event of agentLoop([userMessage], context, config)) {
  console.log(event.type);
}

for await (const event of agentLoopContinue(context, config)) {
  console.log(event.type);
}
```

这里的流是“观察型”的：它保证事件顺序，但不会等待你的异步事件处理完成后再进入后续阶段。如果你需要把消息处理当作工具 preflight 的真正 barrier，应优先使用 `Agent` 类。

## License

MIT
