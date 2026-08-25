# @earendil-works/pi-ai

统一的 LLM API，提供 provider 集合、自动鉴权解析、token 与成本统计、上下文持久化，以及会话中途切换到其他模型的能力。

**Note**：这个库只收录支持 tool calling（function calling）的模型，因为这是 agent 工作流的基础。

> 本文件是 [README.md](./README.md) 的中文副本。代码块、接口名、命令和大部分表格保持原样；如中文说明与英文原文存在细微差异，以英文原文为准。

## Table of Contents

- [Supported Providers](#supported-providers)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Providers and Models](#providers-and-models)
  - [Provider Factories](#provider-factories)
  - [All Built-in Providers](#all-built-in-providers)
  - [Querying Models](#querying-models)
  - [Static Catalog Reads](#static-catalog-reads)
  - [Dynamic Providers](#dynamic-providers)
- [Auth](#auth)
  - [How Auth Resolves](#how-auth-resolves)
  - [Credential Store](#credential-store)
  - [Environment Variables](#environment-variables)
- [Tools](#tools)
  - [Defining Tools](#defining-tools)
  - [Handling Tool Calls](#handling-tool-calls)
  - [Streaming Tool Calls with Partial JSON](#streaming-tool-calls-with-partial-json)
  - [Validating Tool Arguments](#validating-tool-arguments)
  - [Complete Event Reference](#complete-event-reference)
- [Image Input](#image-input)
- [Image Generation](#image-generation)
- [Thinking/Reasoning](#thinkingreasoning)
  - [Unified Interface](#unified-interface-streamsimplecompletesimple)
  - [Provider-Specific Options](#provider-specific-options-streamcomplete)
  - [Streaming Thinking Content](#streaming-thinking-content)
- [Stop Reasons](#stop-reasons)
- [Error Handling](#error-handling)
  - [Aborting Requests](#aborting-requests)
  - [Continuing After Abort](#continuing-after-abort)
  - [Debugging Provider Payloads](#debugging-provider-payloads)
- [Custom Providers](#custom-providers)
  - [createProvider()](#createprovider)
  - [Calling API Implementations Directly](#calling-api-implementations-directly)
  - [OpenAI Compatibility Settings](#openai-compatibility-settings)
- [Faux Provider for Tests](#faux-provider-for-tests)
- [Cross-Provider Handoffs](#cross-provider-handoffs)
- [Context Serialization](#context-serialization)
- [Browser Usage](#browser-usage)
- [Bundling and Tree Shaking](#bundling-and-tree-shaking)
- [OAuth Providers](#oauth-providers)
  - [Vertex AI](#vertex-ai)
  - [CLI Login](#cli-login)
  - [Programmatic OAuth](#programmatic-oauth)
- [Migrating from the Old Global API](#migrating-from-the-old-global-api)
- [Development](#development)
- [License](#license)

## Supported Providers

内置支持以下 provider：

- **OpenAI**
- **Ant Ling**
- **Azure OpenAI (Responses)**
- **OpenAI Codex**（需要 ChatGPT Plus/Pro 订阅和 OAuth）
- **DeepSeek**
- **NVIDIA NIM**
- **Anthropic**
- **Google**
- **Vertex AI**（通过 Vertex AI 调用 Gemini）
- **Mistral**
- **Groq**
- **Cerebras**
- **Cloudflare AI Gateway**
- **Cloudflare Workers AI**
- **xAI**
- **OpenRouter**
- **Vercel AI Gateway**
- **ZAI Coding Plan (Global)**
- **MiniMax**
- **Together AI**
- **Hugging Face**
- **Moonshot AI**
- **GitHub Copilot**（需要 OAuth）
- **Amazon Bedrock**
- **OpenCode Zen**
- **OpenCode Go**
- **Fireworks**
- **Kimi For Coding**
- **Xiaomi MiMo**
- **Any OpenAI-compatible API**：例如 Ollama、vLLM、LM Studio

## Installation

```bash
npm install @earendil-works/pi-ai
```

`TypeBox` 导出的 `Type`、`Static` 和 `TSchema` 也会从 `@earendil-works/pi-ai` 重新导出。

## Quick Start

核心思路是先构造一个 `Models` provider 集合，再在其上发起流式或非流式调用。最简单的方式是注册所有内置 provider；如果你关心 bundle 体积，则只注册需要的 provider。

```typescript
import { Type, type Context, type Tool } from '@earendil-works/pi-ai';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';

const models = builtinModels();
const model = models.getModel('openai', 'gpt-4o-mini')!;

const tools: Tool[] = [{
  name: 'get_time',
  description: 'Get the current time',
  parameters: Type.Object({
    timezone: Type.Optional(Type.String({ description: 'Optional timezone (e.g., America/New_York)' }))
  })
}];

const context: Context = {
  systemPrompt: 'You are a helpful assistant.',
  messages: [{ role: 'user', content: 'What time is it?', timestamp: Date.now() }],
  tools
};

const s = models.stream(model, context);

for await (const event of s) {
  switch (event.type) {
    case 'start':
      console.log(`Starting with ${event.partial.model}`);
      break;
    case 'text_start':
      console.log('\n[Text started]');
      break;
    case 'text_delta':
      process.stdout.write(event.delta);
      break;
    case 'text_end':
      console.log('\n[Text ended]');
      break;
    case 'thinking_start':
      console.log('[Model is thinking...]');
      break;
    case 'thinking_delta':
      process.stdout.write(event.delta);
      break;
    case 'thinking_end':
      console.log('[Thinking complete]');
      break;
    case 'toolcall_start':
      console.log(`\n[Tool call started: index ${event.contentIndex}]`);
      break;
    case 'toolcall_delta':
      const partialCall = event.partial.content[event.contentIndex];
      if (partialCall.type === 'toolCall') {
        console.log(`[Streaming args for ${partialCall.name}]`);
      }
      break;
    case 'toolcall_end':
      console.log(`\nTool called: ${event.toolCall.name}`);
      console.log(`Arguments: ${JSON.stringify(event.toolCall.arguments)}`);
      break;
    case 'done':
      console.log(`\nFinished: ${event.reason}`);
      break;
    case 'error':
      console.error(`Error: ${event.error.errorMessage}`);
      break;
  }
}

const finalMessage = await s.result();
context.messages.push(finalMessage);

const toolCalls = finalMessage.content.filter(b => b.type === 'toolCall');
for (const call of toolCalls) {
  const result = call.name === 'get_time'
    ? new Date().toLocaleString('en-US', {
        timeZone: call.arguments.timezone || 'UTC',
        dateStyle: 'full',
        timeStyle: 'long'
      })
    : 'Unknown tool';

  context.messages.push({
    role: 'toolResult',
    toolCallId: call.id,
    toolName: call.name,
    content: [{ type: 'text', text: result }],
    isError: false,
    timestamp: Date.now()
  });
}

if (toolCalls.length > 0) {
  const continuation = await models.complete(model, context);
  context.messages.push(continuation);
  console.log('After tool execution:', continuation.content);
}

console.log(`Total tokens: ${finalMessage.usage.input} in, ${finalMessage.usage.output} out`);
console.log(`Cost: $${finalMessage.usage.cost.total.toFixed(4)}`);

const response = await models.complete(model, context);

for (const block of response.content) {
  if (block.type === 'text') {
    console.log(block.text);
  } else if (block.type === 'toolCall') {
    console.log(`Tool: ${block.name}(${JSON.stringify(block.arguments)})`);
  }
}
```

后续示例默认都基于类似的 `models` 集合。

## Providers and Models

### Provider Factories

在 `pi-ai` 中，**provider** 是运行时基本单元。它拥有自己的：

- 模型目录
- 鉴权逻辑
- 流式行为
- 关联 API 实现

`Models` 集合负责持有 provider，并把每次请求路由到对应模型所属的 provider。

如果应用只需要一小部分 provider，可以按 provider 单独引入：

```typescript
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { openrouterProvider } from '@earendil-works/pi-ai/providers/openrouter';
import { amazonBedrockProvider } from '@earendil-works/pi-ai/providers/amazon-bedrock';

const models = createModels();
models.setProvider(anthropicProvider());
models.setProvider(openrouterProvider());
```

这些 provider factory 只会引入自身的模型目录和 lazy API wrapper，不会把其他 provider 一起打进来。对于支持 code splitting 的 bundler，实际 SDK 会在第一次请求该 API 时再懒加载。

### All Built-in Providers

如果你需要全量内置 provider，可直接使用：

```typescript
import { builtinModels } from '@earendil-works/pi-ai/providers/all';

const models = builtinModels();
```

`builtinModels()` 会注册所有内置 provider。它适合 CLI、工具型应用或不在意 bundle 体积的环境。参数与 `createModels()` 一致，例如 `credentials`、`authContext`。如果你只想拿 provider 数组，也可以用 `builtinProviders()`。

### Querying Models

模型和 provider 的读取都是同步的，返回的是当前已知列表：

```typescript
const providers = models.getProviders();
const provider = models.getProvider('anthropic');

const all = models.getModels();
const anthropicModels = models.getModels('anthropic');
const model = models.getModel('anthropic', 'claude-sonnet-4-5');

for (const m of anthropicModels) {
  console.log(`${m.id}: ${m.name}`);
  console.log(`  API: ${m.api}`);
  console.log(`  Context: ${m.contextWindow} tokens`);
  console.log(`  Vision: ${m.input.includes('image')}`);
  console.log(`  Reasoning: ${m.reasoning}`);
}
```

动态列出的模型类型是 `Model<Api>`。如果需要获得某个 API 的完整选项类型，可通过 `hasApi()` 缩窄类型：

```typescript
import { hasApi } from '@earendil-works/pi-ai';

const m = models.getModel('anthropic', 'claude-sonnet-4-5');
if (m && hasApi(m, 'anthropic-messages')) {
  models.stream(m, context, { thinkingEnabled: true, thinkingBudgetTokens: 2048 });
}
```

### Static Catalog Reads

如果你只想读取生成好的内置目录、并希望 provider/model ID 具有字面量类型补全，可以直接读静态目录：

```typescript
import { getBuiltinModel, getBuiltinModels, getBuiltinProviders } from '@earendil-works/pi-ai/providers/all';

const model = getBuiltinModel('openai', 'gpt-4o-mini');
const providers = getBuiltinProviders();
const anthropic = getBuiltinModels('anthropic');
```

### Dynamic Providers

有些 provider 的模型列表是动态的，例如本地推理服务或 OpenRouter 实时列表。此时：

- `getModels()` 仍然是同步读取
- 实际刷新要显式调用 `refresh()`

```typescript
await models.refresh('llamacpp');
await models.refresh();
const fresh = models.getModel('llamacpp', 'qwen3-30b');
```

静态内置 provider 对 `refresh()` 是 no-op。要自己实现动态 provider，可参考后面的 `createProvider()`。

## Auth

每个 provider 都拥有自己的鉴权逻辑，包括：

- API key 如何解析
- 是否支持持久化 credential
- 是否支持 OAuth 登录/刷新
- 是否依赖环境凭据，例如 AWS profile 或 gcloud ADC

### How Auth Resolves

发起请求时，`Models` 集合会通过模型所属 provider 解析 auth，并合并进请求。显式传入的 per-request 参数优先级最高。

```typescript
await models.complete(model, context);
await models.complete(model, context, { apiKey: 'sk-explicit' });
```

也可以不发请求，单独查询当前模型的 auth 解析结果：

```typescript
const auth = await models.getAuth(model);
if (auth) {
  console.log(`configured via ${auth.source}`);
} else {
  console.log('not configured');
}
```

`getAuth()` 的返回语义：

- 未配置：返回 `undefined`
- 真正的故障：抛出 `ModelsError`
- OAuth 刷新失败或 credential store 读写失败：也按错误处理

### Credential Store

交互输入的 API key、OAuth token 等都保存在 `CredentialStore` 中。`pi-ai` 默认只提供内存版实现；如果你需要持久化，应该自己注入 store。

```typescript
import { createModels, type CredentialStore } from '@earendil-works/pi-ai';

const models = createModels({ credentials: myFileBackedStore });
```

`CredentialStore` 的职责很小：

- `read(providerId)`
- `modify(providerId, fn)`：唯一写入口，内部用串行化的 read-modify-write
- `delete(providerId)`

这样设计的原因是 OAuth token 刷新需要在锁内完成，避免并发请求重复刷新同一 token。

API key credential 也可以携带 provider 级环境参数：

```typescript
const credential = {
  type: 'api_key',
  key: '...',
  env: {
    CLOUDFLARE_ACCOUNT_ID: 'account-id',
    CLOUDFLARE_GATEWAY_ID: 'gateway-id'
  }
} as const;
```

### Environment Variables

内置 provider 默认会解析以下环境变量：

| Provider | Environment Variable(s) |
|----------|------------------------|
| OpenAI | `OPENAI_API_KEY` |
| Ant Ling | `ANT_LING_API_KEY` |
| Azure OpenAI | `AZURE_OPENAI_API_KEY` + `AZURE_OPENAI_BASE_URL` or `AZURE_OPENAI_RESOURCE_NAME` |
| Anthropic | `ANTHROPIC_API_KEY` or `ANTHROPIC_OAUTH_TOKEN` |
| DeepSeek | `DEEPSEEK_API_KEY` |
| NVIDIA NIM | `NVIDIA_API_KEY` |
| Google | `GEMINI_API_KEY` |
| Vertex AI | `GOOGLE_CLOUD_API_KEY` or `GOOGLE_CLOUD_PROJECT` + `GOOGLE_CLOUD_LOCATION` + ADC |
| Mistral | `MISTRAL_API_KEY` |
| Groq | `GROQ_API_KEY` |
| Cerebras | `CEREBRAS_API_KEY` |
| Cloudflare AI Gateway | `CLOUDFLARE_API_KEY` + `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_GATEWAY_ID` |
| Cloudflare Workers AI | `CLOUDFLARE_API_KEY` + `CLOUDFLARE_ACCOUNT_ID` |
| xAI | `XAI_API_KEY` |
| Fireworks | `FIREWORKS_API_KEY` |
| Together AI | `TOGETHER_API_KEY` |
| OpenRouter | `OPENROUTER_API_KEY` |
| Vercel AI Gateway | `AI_GATEWAY_API_KEY` |
| ZAI Coding Plan (Global) | `ZAI_API_KEY` |
| ZAI Coding Plan (China) | `ZAI_CODING_CN_API_KEY` |
| MiniMax (Global) | `MINIMAX_API_KEY` |
| MiniMax (China) | `MINIMAX_CN_API_KEY` |
| Moonshot AI / Moonshot AI (China) | `MOONSHOT_API_KEY` |
| Hugging Face | `HF_TOKEN` |
| OpenCode Zen / OpenCode Go | `OPENCODE_API_KEY` |
| Kimi For Coding | `KIMI_API_KEY` |
| Xiaomi MiMo (API billing) | `XIAOMI_API_KEY` |
| Xiaomi MiMo Token Plan (China) | `XIAOMI_TOKEN_PLAN_CN_API_KEY` |
| Xiaomi MiMo Token Plan (Amsterdam) | `XIAOMI_TOKEN_PLAN_AMS_API_KEY` |
| Xiaomi MiMo Token Plan (Singapore) | `XIAOMI_TOKEN_PLAN_SGP_API_KEY` |
| GitHub Copilot | `COPILOT_GITHUB_TOKEN` |

补充：

- Amazon Bedrock 使用 AWS 环境凭据解析
- Vertex AI 可用显式 key，也可用 Application Default Credentials

## Tools

这个库把工具定义、工具参数校验、工具调用事件流都统一到了同一套结构里。参数 schema 使用 TypeBox，因此兼顾静态类型与运行时验证。

### Defining Tools

```typescript
import { Type, type Tool, StringEnum } from '@earendil-works/pi-ai';

const weatherTool: Tool = {
  name: 'get_weather',
  description: 'Get current weather for a location',
  parameters: Type.Object({
    location: Type.String({ description: 'City name or coordinates' }),
    units: StringEnum(['celsius', 'fahrenheit'], { default: 'celsius' })
  })
};

const bookMeetingTool: Tool = {
  name: 'book_meeting',
  description: 'Schedule a meeting',
  parameters: Type.Object({
    title: Type.String({ minLength: 1 }),
    startTime: Type.String({ format: 'date-time' }),
    endTime: Type.String({ format: 'date-time' }),
    attendees: Type.Array(Type.String({ format: 'email' }), { minItems: 1 })
  })
};
```

注意：为了兼容 Google 的 API，请优先用 `StringEnum` 而不是 `Type.Enum`。

### Handling Tool Calls

模型返回的工具结果通过内容块表达，既可以是文本，也可以是图片。

```typescript
import { readFileSync } from 'fs';

const context: Context = {
  messages: [{ role: 'user', content: 'What is the weather in London?', timestamp: Date.now() }],
  tools: [weatherTool]
};

const response = await models.complete(model, context);

for (const block of response.content) {
  if (block.type === 'toolCall') {
    const result = await executeWeatherApi(block.arguments);

    context.messages.push({
      role: 'toolResult',
      toolCallId: block.id,
      toolName: block.name,
      content: [{ type: 'text', text: JSON.stringify(result) }],
      isError: false,
      timestamp: Date.now()
    });
  }
}

const imageBuffer = readFileSync('chart.png');
context.messages.push({
  role: 'toolResult',
  toolCallId: 'tool_xyz',
  toolName: 'generate_chart',
  content: [
    { type: 'text', text: 'Generated chart showing temperature trends' },
    { type: 'image', data: imageBuffer.toString('base64'), mimeType: 'image/png' }
  ],
  isError: false,
  timestamp: Date.now()
});
```

### Streaming Tool Calls with Partial JSON

工具参数在流式过程中是“边到边解析”的，因此你可以在完整 JSON 尚未结束前就拿到部分参数，用于 UI 预览。

```typescript
const s = models.stream(model, context);

for await (const event of s) {
  if (event.type === 'toolcall_delta') {
    const toolCall = event.partial.content[event.contentIndex];

    if (toolCall.type === 'toolCall' && toolCall.arguments) {
      if (toolCall.name === 'write_file' && toolCall.arguments.path) {
        console.log(`Writing to: ${toolCall.arguments.path}`);

        if (toolCall.arguments.content) {
          console.log(`Content preview: ${toolCall.arguments.content.substring(0, 100)}...`);
        }
      }
    }
  }

  if (event.type === 'toolcall_end') {
    const toolCall = event.toolCall;
    console.log(`Tool completed: ${toolCall.name}`, toolCall.arguments);
  }
}
```

处理部分参数时要非常保守：

- 字段可能缺失
- 字符串可能截断在半个单词
- 数组可能不完整
- 嵌套对象可能只填了一部分
- 至少会得到 `{}`，不会得到 `undefined`
- Google provider 不支持函数调用流式拆块，而是一次性给出完整参数

### Validating Tool Arguments

如果你要自己写工具执行循环，建议在调用工具前先用 `validateToolCall()` 校验参数。

```typescript
import { validateToolCall, type Tool } from '@earendil-works/pi-ai';

const tools: Tool[] = [weatherTool, calculatorTool];
const s = models.stream(model, { messages, tools });

for await (const event of s) {
  if (event.type === 'toolcall_end') {
    const toolCall = event.toolCall;

    try {
      const validatedArgs = validateToolCall(tools, toolCall);
      const result = await executeMyTool(toolCall.name, validatedArgs);
    } catch (error) {
      context.messages.push({
        role: 'toolResult',
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: [{ type: 'text', text: error.message }],
        isError: true,
        timestamp: Date.now()
      });
    }
  }
}
```

### Complete Event Reference

| Event Type | Description | Key Properties |
|------------|-------------|----------------|
| `start` | 流开始 | `partial` |
| `text_start` | 文本块开始 | `contentIndex` |
| `text_delta` | 文本增量 | `delta`, `contentIndex` |
| `text_end` | 文本块结束 | `content`, `contentIndex` |
| `thinking_start` | 思考块开始 | `contentIndex` |
| `thinking_delta` | 思考增量 | `delta`, `contentIndex` |
| `thinking_end` | 思考块结束 | `content`, `contentIndex` |
| `toolcall_start` | 工具调用开始 | `contentIndex` |
| `toolcall_delta` | 工具参数流式增量 | `delta`, `partial.content[contentIndex].arguments` |
| `toolcall_end` | 工具调用完成 | `toolCall` |
| `done` | 整个流完成 | `reason`, `message` |
| `error` | 出错 | `reason`, `error` |

不同内容块的流式事件可能会交错到达，因此消费方必须使用 `contentIndex` 关联事件，不能假设同一块的 `*_start -> *_delta -> *_end` 一定连续出现。

## Image Input

支持视觉输入的模型可以处理图片。判断方式是检查 `model.input` 是否包含 `'image'`。如果把图片传给不支持视觉的模型，图片会被静默忽略。

```typescript
import { readFileSync } from 'fs';

const model = models.getModel('openai', 'gpt-4o-mini')!;

if (model.input.includes('image')) {
  console.log('Model supports vision');
}

const imageBuffer = readFileSync('image.png');
const base64Image = imageBuffer.toString('base64');

const response = await models.complete(model, {
  messages: [{
    role: 'user',
    content: [
      { type: 'text', text: 'What is in this image?' },
      { type: 'image', data: base64Image, mimeType: 'image/png' }
    ],
    timestamp: Date.now()
  }]
});
```

## Image Generation

图片生成与聊天生成是两套独立 API。聊天侧用 `Models`，图片侧用 `ImagesModels`。图片生成是 one-shot 调用，入口是 `generateImages()`，不要用聊天侧的 `stream()` / `complete()` 来做图片生成。

### Basic Image Generation

```typescript
import { builtinImagesModels } from '@earendil-works/pi-ai/providers/all';

const imagesModels = builtinImagesModels();
const model = imagesModels.getModel('openrouter', 'google/gemini-2.5-flash-image')!;

const result = await imagesModels.generateImages(model, {
  input: [{ type: 'text', text: 'Generate a red circle on a plain white background.' }]
});
```

补充要点：

- 聊天模型与图片模型分属不同集合
- 图片生成不参与 tool calling
- 输出保存在 `AssistantImages.output`
- 有些模型只输出图片，有些模型会返回图片加文本
- 有些模型支持图片输入，有些模型只支持 text-to-image
- 当前内置图片生成 provider 只有 OpenRouter

## Thinking/Reasoning

许多模型支持 reasoning/thinking。你可以通过 `model.reasoning` 判断是否支持；把 reasoning 选项传给不支持的模型时，会被静默忽略。

### Unified Interface (streamSimple/completeSimple)

```typescript
const model = models.getModel('anthropic', 'claude-sonnet-4-5')!;

if (model.reasoning) {
  console.log('Model supports reasoning/thinking');
}

const response = await models.completeSimple(model, {
  messages: [{ role: 'user', content: 'Solve: 2x + 5 = 13', timestamp: Date.now() }]
}, {
  reasoning: 'medium'
});
```

统一简化接口适合跨 provider 使用，reasoning 等级为：

- `minimal`
- `low`
- `medium`
- `high`
- `xhigh`

### Provider-Specific Options (stream/complete)

如果需要 provider 特有选项，可直接使用 `stream()` / `complete()`，再通过 `hasApi()` 缩窄模型类型。

```typescript
import { hasApi } from '@earendil-works/pi-ai';

const openaiModel = models.getModel('openai', 'gpt-5-mini')!;
if (hasApi(openaiModel, 'openai-responses')) {
  await models.complete(openaiModel, context, {
    reasoningEffort: 'medium',
    reasoningSummary: 'detailed'
  });
}

const anthropicModel = models.getModel('anthropic', 'claude-sonnet-4-5')!;
if (hasApi(anthropicModel, 'anthropic-messages')) {
  await models.complete(anthropicModel, context, {
    thinkingEnabled: true,
    thinkingBudgetTokens: 8192
  });
}
```

### Streaming Thinking Content

思考内容有独立的流式事件：

```typescript
const s = models.streamSimple(model, context, { reasoning: 'high' });

for await (const event of s) {
  switch (event.type) {
    case 'thinking_start':
      console.log('[Model started thinking]');
      break;
    case 'thinking_delta':
      process.stdout.write(event.delta);
      break;
    case 'thinking_end':
      console.log('\n[Thinking complete]');
      break;
  }
}
```

## Stop Reasons

每个 `AssistantMessage` 都有 `stopReason`，表示生成结束原因：

- `"stop"`：正常完成
- `"length"`：命中输出 token 上限
- `"toolUse"`：模型正在请求工具
- `"error"`：生成过程出错
- `"aborted"`：被 abort signal 取消

部分 provider 还会附带 `responseId`。

## Error Handling

请求失败不会从 stream API 直接抛出，而是以 `error` 事件和最终消息上的错误字段呈现。

```typescript
for await (const event of s) {
  if (event.type === 'error') {
    console.error(`Error (${event.reason}):`, event.error.errorMessage);
    console.log('Partial content:', event.error.content);
  }
}

const message = await s.result();
if (message.stopReason === 'error' || message.stopReason === 'aborted') {
  console.error('Request failed:', message.errorMessage);
}
```

auth 失败、OAuth 刷新失败、未知 provider 等，也都会通过同样的错误通道暴露出来。

### Aborting Requests

```typescript
const controller = new AbortController();
setTimeout(() => controller.abort(), 2000);

const s = models.stream(model, {
  messages: [{ role: 'user', content: 'Write a long story', timestamp: Date.now() }]
}, {
  signal: controller.signal
});
```

被取消后的结果会携带 `stopReason === 'aborted'`，同时保留已收到的部分内容和部分 usage 统计。

### Continuing After Abort

被中断的 assistant 消息也可以继续加入上下文，并在后续请求中延续：

```typescript
const partial = await models.complete(model, context, { signal: controller1.signal });
context.messages.push(partial);
context.messages.push({ role: 'user', content: 'Please continue', timestamp: Date.now() });
const continuation = await models.complete(model, context);
```

### Debugging Provider Payloads

可以通过 `onPayload` 回调查看真正发给 provider 的请求体：

```typescript
const response = await models.complete(model, context, {
  onPayload: (payload) => {
    console.log('Provider payload:', JSON.stringify(payload, null, 2));
  }
});
```

## Custom Providers

### createProvider()

`createProvider()` 允许你从零组装 provider，适合本地推理服务、代理服务，或其他兼容 OpenAI / Anthropic 的接口。

```typescript
import { createModels, createProvider, envApiKeyAuth, type Model } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';

const ollamaModel: Model<'openai-completions'> = {
  id: 'llama-3.1-8b',
  name: 'Llama 3.1 8B (Ollama)',
  api: 'openai-completions',
  provider: 'ollama',
  baseUrl: 'http://localhost:11434/v1',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 32000
};

const ollama = createProvider({
  id: 'ollama',
  name: 'Ollama',
  baseUrl: 'http://localhost:11434/v1',
  auth: { apiKey: { name: 'Ollama', resolve: async () => ({ auth: {} }) } },
  models: [ollamaModel],
  api: openAICompletionsApi(),
});
```

如果 provider 需要真实 API key，可直接用 `envApiKeyAuth()`：

```typescript
const proxy = createProvider({
  id: 'my-proxy',
  auth: { apiKey: envApiKeyAuth('My proxy API key', ['MY_PROXY_API_KEY']) },
  models: [/* ... */],
  api: openAICompletionsApi(),
});
```

如果一个 provider 同时承载多种 API，可按 `model.api` 建映射。

### Calling API Implementations Directly

也可以直接导入底层 API 实现模块并调用。此时不会走 provider auth，需要你自己传 `apiKey`。

```typescript
import { stream } from '@earendil-works/pi-ai/api/anthropic-messages';

const s = stream(claudeModel, context, {
  apiKey: process.env.ANTHROPIC_API_KEY,
  thinkingEnabled: true,
  thinkingBudgetTokens: 2048,
});
```

内置 API 实现包括：

- `anthropic-messages`
- `openai-completions`
- `openai-responses`
- `openai-codex-responses`
- `azure-openai-responses`
- `google-generative-ai`
- `google-vertex`
- `mistral-conversations`
- `bedrock-converse-stream`

### OpenAI Compatibility Settings

很多兼容 OpenAI 的服务只是在字段支持上有小差异。库会根据 `baseUrl` 自动识别一部分已知服务；如果是自定义代理或未知端点，可以通过 `compat` 覆盖。

主要兼容开关包括：

- `supportsStore`
- `supportsDeveloperRole`
- `supportsReasoningEffort`
- `supportsUsageInStreaming`
- `supportsStrictMode`
- `sendSessionAffinityHeaders`
- `maxTokensField`
- `requiresToolResultName`
- `requiresAssistantAfterToolResult`
- `requiresThinkingAsText`
- `requiresReasoningContentOnAssistantMessages`
- `thinkingFormat`
- `chatTemplateKwargs`
- `cacheControlFormat`
- `openRouterRouting`
- `vercelGatewayRouting`

适用场景：

- LiteLLM 代理
- 自定义推理网关
- 自托管 OpenAI-compatible 服务

## Faux Provider for Tests

`fauxProvider()` 可构建一个脚本化的内存 provider，用于测试和 demo：

```typescript
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxThinking,
  fauxToolCall,
} from '@earendil-works/pi-ai';

const faux = fauxProvider({
  tokensPerSecond: 50
});
```

特点：

- 响应按队列消费
- 队列空了会返回一个带错误信息的 assistant message
- 可替换剩余队列，也可追加新响应
- 支持多 faux 模型，方便测试模型切换
- 工具参数也会按 `toolcall_delta` 逐步流式发出

## Cross-Provider Handoffs

这个库支持在同一段会话中跨 provider 切换模型。不同 provider 之间转移上下文时，会自动做兼容变换。

规则概括：

- `user` 和 `toolResult` 原样透传
- 同一 provider / API 的 assistant 消息原样保留
- 不同 provider 的 assistant thinking 会被转换成带 `<thinking>` 标签的文本
- 普通文本和 tool call 保持不变

```typescript
import { createModels, type Context } from '@earendil-works/pi-ai';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { googleProvider } from '@earendil-works/pi-ai/providers/google';

const models = createModels();
models.setProvider(anthropicProvider());
models.setProvider(openaiProvider());
models.setProvider(googleProvider());
```

这让你可以在一个会话里：

- 先用快模型起草
- 再切到强模型深度推理
- 甚至在 provider 故障时保持上下文连续

## Context Serialization

`Context` 是普通 JSON 可序列化对象，适合持久化会话、做聊天历史存储，或者跨服务传递。

```typescript
const serialized = JSON.stringify(context);
const restored: Context = JSON.parse(localStorage.getItem('conversation')!);
```

如果上下文中包含 base64 图片，也会一起被序列化。

## Browser Usage

这个库支持浏览器环境。核心入口和 provider factory 都是 side-effect free 的，便于打包。浏览器里没有环境变量，因此应显式传 `apiKey`，或者提供一个浏览器可持久化的 `CredentialStore`。

```typescript
import { createModels } from '@earendil-works/pi-ai';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';

const models = createModels();
models.setProvider(anthropicProvider());
```

安全提醒：

- 不要在生产前端直接暴露 API key
- Bedrock 不支持浏览器运行
- OAuth 登录流程是 Node-only

## Bundling and Tree Shaking

如果你关心 bundle 体积，应按 provider 精细引入：

```typescript
import { createModels } from '@earendil-works/pi-ai';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';

const models = createModels();
models.setProvider(openaiProvider());
```

规则：

- 根入口不引入内置目录与 SDK
- `providers/<provider>` 只引入单个 provider 的目录与 lazy wrapper
- `providers/all` 会把所有内置 provider 都带上
- code splitting 场景下，SDK 会留在 lazy chunk 里

如果是单文件 Node ESM bundle，可能需要加 `require` shim：

```bash
esbuild app.js --bundle --platform=node --format=esm \
  --banner:js='import { createRequire } from "module";const require = createRequire(import.meta.url);' \
  --outfile=app.bundle.js
```

### Provider-Scoped Environment Overrides

请求级别还可以通过 `env` 覆盖 provider 所需环境配置：

```typescript
const response = await models.complete(model, context, {
  env: {
    CLOUDFLARE_API_KEY: '...',
    CLOUDFLARE_ACCOUNT_ID: 'account-id',
    CLOUDFLARE_GATEWAY_ID: 'gateway-id'
  }
});
```

适合一个进程里对不同请求使用不同 provider 设置。

## OAuth Providers

以下 provider 支持 OAuth：

- **Anthropic**
- **OpenAI Codex**
- **GitHub Copilot**

它们都会在 `provider.auth.oauth` 下暴露：

- `login(callbacks)`
- `refresh(credential)`
- `toAuth(credential)`

```typescript
import { createModels } from '@earendil-works/pi-ai';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';

const models = createModels({ credentials: myStore });
models.setProvider(anthropicProvider());
```

核心行为是：登录后把 credential 存入 `CredentialStore`，后续请求自动解析和刷新 token。

### Vertex AI

Vertex AI 支持两种鉴权方式：

- API key
- Application Default Credentials（ADC）

本地开发：

```bash
gcloud auth application-default login
export GOOGLE_CLOUD_PROJECT="my-project"
export GOOGLE_CLOUD_LOCATION="us-central1"
```

### CLI Login

```bash
npx @earendil-works/pi-ai login
npx @earendil-works/pi-ai login anthropic
npx @earendil-works/pi-ai list
```

credential 默认写入当前目录的 `auth.json`。

### Programmatic OAuth

旧的 `@earendil-works/pi-ai/oauth` 入口仍然可用，例如：

- `loginAnthropic`
- `loginOpenAICodex`
- `loginGitHubCopilot`
- `refreshOAuthToken`
- `getOAuthApiKey`

但新代码更推荐直接使用 provider 持有的 `OAuthAuth`。

Provider 备注：

- **OpenAI Codex**：要求 ChatGPT Plus/Pro，支持 GPT-5.x Codex 模型与 session 级 prompt cache
- **Azure OpenAI (Responses)**：只支持 Responses API
- **GitHub Copilot**：如果模型不可用，通常需要先在 VS Code 的 Copilot Chat 里手动启用

## Migrating from the Old Global API

旧版本提供的是全局 API：`stream()`、`complete()`、`getModel()` 等由全局注册表驱动。现在这套行为仍可通过 compat 入口继续使用：

```typescript
import { getModel, complete } from '@earendil-works/pi-ai/compat';
```

但更推荐迁移到：

- `createModels()`
- provider factories
- `models.getModel()`
- `models.stream()` / `models.complete()`

常见映射：

| Old | New |
|-----|-----|
| `getModel('openai', 'gpt-4o-mini')` | `models.getModel('openai', 'gpt-4o-mini')` |
| `getModels('anthropic')` | `models.getModels('anthropic')` |
| `stream(model, ctx, opts)` | `models.stream(model, ctx, opts)` |
| `getEnvApiKey('openai')` | `await models.getAuth(model)` |

## Development

### Adding a New Provider

新增 provider 时，通常要同时修改几层：

1. **核心类型**：在 `src/types.ts` 注册 `KnownApi`、`KnownProvider`、`ApiOptionsMap`
2. **API 实现**：在 `src/api/<api-id>.ts` 实现 `stream` 和 `streamSimple`
3. **模型生成**：更新 `scripts/generate-models.ts` 或 `scripts/generate-image-models.ts`
4. **Provider Factory**：在 `src/providers/<id>.ts` 里接好 auth、catalog 和 lazy API
5. **测试**：覆盖 streaming、tokens、abort、context overflow、handoff 等
6. **Coding Agent 集成**：更新 `../coding-agent/` 里的默认模型和 CLI 帮助
7. **文档**：补 README、环境变量、provider 说明
8. **Changelog**：写入 `packages/ai/CHANGELOG.md`

新增 provider 时，重点不是单个文件，而是保证：

- 类型系统知道它
- provider factory 能创建它
- 模型目录可生成
- 测试能覆盖
- 上层 `coding-agent` 能选到它

## License

MIT
