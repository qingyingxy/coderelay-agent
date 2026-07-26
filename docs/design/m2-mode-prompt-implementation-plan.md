# M2 模式选择与 Prompt Pipeline 实施计划

## 1. 目标

M2 在 Direct MVP 之上补齐执行模式选择和统一 Prompt Pipeline。

本阶段支持三种输入模式：

- `auto`：由系统解析为 `direct` 或 `plan`。
- `direct`：直接进入执行工作流。
- `plan`：先规划并等待批准，再进入执行工作流。

## 2. 模式边界

模式分为“选择值”和“执行值”两层：

| 层级 | 可用值 | 含义 |
|---|---|---|
| 选择层 `ExecutionMode` | `auto`、`direct`、`plan` | CLI、配置或调用方表达的模式偏好 |
| 执行层 `ResolvedExecutionMode` | `direct`、`plan` | WorkflowController 最终采用并持久化的模式 |

`auto` 不是最终执行模式，不能写入 `ModeDecision.mode`。它必须先经过模式解析，得到 `direct` 或 `plan`。

领域模型中的 `UserRequest.requestedMode` 只记录用户明确指定的 `direct` 或 `plan`。未指定模式或选择 `auto` 都表示没有显式覆盖，后续由模式解析器处理。

## 3. R4.1 范围

R4.1 只固定模式词汇和类型边界：

- 定义 `EXECUTION_MODES`、`ExecutionMode`。
- 定义 `RESOLVED_EXECUTION_MODES`、`ResolvedExecutionMode`。
- 默认选择模式为 `auto`。
- 提供运行时类型守卫，供后续 CLI 参数和配置解析复用。
- 通过类型测试保证 `auto` 不会进入已解析模式。

R4.1 不实现模式优先级、自动判断规则或 WorkflowController 分流。

## 4. 后续顺序

1. R4.2：实现模式选择顺序和强制 Plan 安全门禁。
2. R4.3：定义和持久化 `ModeDecision`。
3. R4.4-R4.5：实现需求澄清门禁和自动模式建议。
4. R4.6-R4.10：实现 Agent Profile 与统一 Prompt Pipeline。
5. R4.11-R4.12：接入 Direct 升级 Plan，并补齐模式和 Prompt 测试。

## 5. 当前状态

- R4.1：`DONE`
- R4.2：`DONE`
- R4.3：`DONE`
- R4.4：`DONE`
- R4.5：`DONE`
- R4.6：`DONE`
- R4.7：`DONE`
- R4.8：`DONE`
- R4.9：`DONE`
- R4.10：`DONE`
- 下一项：R4.11

## 6. R4.2 模式选择顺序

模式选择器是无状态纯函数，不调用 LLM，也不持久化 `ModeDecision`。选择顺序为：

1. 用户明确选择 `plan` 时保持 `plan`，任何来源都不能将其降级为 `direct`。
2. 强制 Plan 安全策略可以否决用户或 Agent 的 `direct`。
3. 没有强制 Plan 时，遵循用户明确选择的 `direct`。
4. 用户未指定时采用 Agent 的结构化建议。
5. 没有 Agent 建议时使用产品默认规则，当前默认解析为 `direct`。

选择器只返回 `mode` 和 `source`。R4.3 再负责补充 `reason`、`riskLevel`、`decidedAt` 并形成可持久化的 `ModeDecision`。

## 7. R4.3 ModeDecision

`ModeDecision` 由领域构造器创建，包含：

- 已解析的 `mode`。
- 实际胜出的 `source`。
- 非空并去除首尾空白的 `reason`。
- `low`、`medium`、`high` 之一的 `riskLevel`。
- 有效的 `decidedAt` 时间。

Direct Workflow 在创建 Workflow 和根 Task 的同一个 Event Batch 中持久化 `workflow.mode_decided`。Store 从该事件恢复完整决策，CLI 或 Agent 不能绕过 Controller 直接修改。

## 8. R4.4 需求澄清门禁

澄清门禁接收结构化的缺失信息候选，并返回三类结果：

- `questions`：会改变实现且没有安全默认值，必须询问用户。
- `assumptions`：存在安全默认值，记录采用的答案和原因后继续。
- `ignoredCandidateIds`：不会实质改变实现的偏好，不打断用户。

只要 `questions` 非空，`required` 就为 `true`，后续 Controller 才能进入 `clarifying`。门禁本身不调用 LLM、不修改 Workflow，也不把主观文本直接解释为状态事实；候选信息由后续 ModeAdvisor Prompt 或明确规则提供。

## 9. R4.5 自动模式建议

ModeAdvisor 后续通过 Prompt Pipeline 产生结构化评估，Core 只接受以下字段：

- `complexity`：`low`、`medium`、`high`。
- `riskLevel`：`low`、`medium`、`high`。
- `confidence`：`low`、`medium`、`high`。
- `reason`：非空判断依据。

Core 根据评估生成 `suggestedMode`：

- 风险为 `low`、复杂度不是 `high` 且置信度不是 `low` 时建议 `direct`。
- 其他情况保守建议 `plan`。

ModeSelector 把完整 `ModeAdvice` 作为 Agent 候选，但用户明确选择和强制 Plan 安全策略仍拥有更高优先级。R4.5 不调用模型；ModeAdvisor Profile 和 Prompt 接入分别属于 R4.6、R4.8-R4.10。

## 10. R4.6 Agent Profile

工作流层定义五种固定角色，并映射到 Pi 已有 Agent 配置字段：

| 角色 | 职责 | 默认工具与权限 |
|---|---|---|
| ModeAdvisor | 评估复杂度、风险、置信度和模式 | 不直接调用工具，只处理提供的上下文 |
| Planner | 生成结构化 Plan | `read`、`grep`、`find`、`ls`，只读 |
| Explorer | 调查代码并提供文件位置和架构发现 | `read`、`grep`、`find`、`ls`，只读 |
| Worker | 执行分配的 Task 并验证修改 | 允许内置读写工具和 `bash`，默认禁止网络 |
| Reviewer | 审查 Diff 和上下文并报告问题 | `read`、`grep`、`find`、`ls`，只读 |

每个 Profile 包含名称、角色、描述、可选模型、System Prompt、工具白名单、权限上限和默认预算。Profile 校验禁止只读角色获得写入、命令或网络能力，并保证工具不会超过权限上限。

这些定义不替换 Pi 的 Markdown Agent 加载格式。后续 Runtime 可以将 Profile 映射到 Pi 的 `name`、`description`、`model`、`tools` 和 Prompt；项目本地 Profile 仍必须经过 Project Trust。

## 11. R4.7 PromptEnvelope

`PromptEnvelope` 是进入 Prompt Pipeline 的结构化输入，不是最终发送给模型的字符串。它包含：

- `schemaVersion`：Envelope 数据结构版本。
- `promptVersion`：角色 Prompt 或模板版本。
- `role` 和 `profileName`：执行角色与具体 Profile。
- `task`：当前 Task 的身份、描述、状态、依赖和验证要求。
- `context`：带来源、稳定 ID 和 required 标记的上下文块。
- `toolNames`：本次调用实际允许的工具名称。
- `constraints`：安全、权限、预算、Workflow 和输出约束。
- `outputSchema`：期望结构化输出的名称、版本和 JSON Schema。

领域构造器校验必要字段、唯一 ID、版本、时间和输出 Schema，并复制调用方数据，避免创建后被外部修改。R4.7 不重新构建 Pi 的 System Prompt 或 Tool Schema；R4.8-R4.10 负责输入顺序、裁剪以及 AgentSession 适配。

## 12. R4.8 Prompt 输入来源与顺序

Envelope 使用以下规范顺序记录上下文来源：

1. `agent_profile`
2. `project_rule`
3. `history`
4. `user_request`
5. `plan`
6. `task`
7. `handoff`
8. `tool_schema`

同一来源内保持调用方顺序，例如历史消息和多个项目规则不会被重排。创建 Envelope 时自动规范化顺序；恢复或读取已持久化 Envelope 时校验顺序，防止不同调用路径生成不同 Prompt。

该顺序是结构化组装顺序，不把所有内容拼成一个字符串：

- Agent Profile、强制约束和项目规则属于 System 层。
- 历史位于当前用户需求之前。
- 用户需求、Plan、当前 Task 和 Handoff 构成 Workflow 上下文。
- Tool Schema 由 Pi AgentSession 的工具通道提供，Envelope 只记录来源与实际工具白名单。

R4.8 不替代 Pi 当前的 System Prompt、Skills、Prompt Templates、项目上下文或 Tool Schema 组装。

## 13. R4.9 Prompt 裁剪与预算

裁剪器接收 `maxInputTokens`、预留 Token 和可注入的文本 Token 估算器。R4.9 不复制模型 tokenizer；R4.10 在最终消息构造阶段适配 Pi 已有的消息估算能力。

不可裁剪内容：

- 所有安全、权限、预算、Workflow 和输出约束。
- 当前 Task 结构。
- `agent_profile`、`user_request`、`task` 上下文。
- 所有标记为 `required` 的上下文，包括必要 Handoff 和项目规则。
- 输出 Schema 和实际工具白名单。

可选上下文按以下顺序整块移除，直到满足预算：

1. 最旧的历史。
2. 非必要 Handoff。
3. 可选 Plan 上下文。
4. 非必要项目规则。
5. Envelope 中的可选 Tool Schema 文本引用。

同一来源内保持原顺序，因此历史总是从最旧条目开始裁剪。如果不可裁剪内容本身超过预算，返回明确错误，不静默删除安全约束、当前 Task 或必要 Handoff。

## 14. R4.10 AgentSession 适配

`PromptAgentSessionAdapter` 是 Prompt Pipeline 与 Pi `AgentSession` 之间的薄适配层，不创建第二套 Agent Loop、System Prompt、会话历史或 Tool Schema：

- `agent_profile`、`project_rule`、`history` 和 `tool_schema` 由调用方预先配置的 AgentSession 管理，不重复拼入当前用户消息。
- 当前 Task 使用 Envelope 的结构化 `task` 字段，只渲染一次；同源 `task` 上下文只保留追踪 ID。
- `user_request`、`plan` 和 `handoff` 作为当前 Workflow 上下文传入。
- 约束和输出 Schema 随当前 Task 传入，但实际权限不能依赖提示词，R7 仍需提供正式策略执行。
- Envelope 工具集必须是 AgentSession 当前活动工具的子集；执行期间临时收紧，结束或失败后恢复，不能借 Prompt 扩大工具能力。
- 调用 `AgentSession.prompt()` 时关闭 Prompt Template 展开并使用 `extension` 来源，避免再次解析 Workflow 命令或创建嵌套 Direct Workflow。
- 同一个 AgentSession 同时只允许一个 Envelope 执行，忙碌时明确拒绝。

独立 Planner、Reviewer 和 Subagent 的 AgentSession 创建与 Profile System Prompt 注入分别由 R5、R8 实现；R4.10 只固定可复用的执行接缝。
