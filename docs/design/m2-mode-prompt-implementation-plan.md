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
- 下一项：R4.3

## 6. R4.2 模式选择顺序

模式选择器是无状态纯函数，不调用 LLM，也不持久化 `ModeDecision`。选择顺序为：

1. 用户明确选择 `plan` 时保持 `plan`，任何来源都不能将其降级为 `direct`。
2. 强制 Plan 安全策略可以否决用户或 Agent 的 `direct`。
3. 没有强制 Plan 时，遵循用户明确选择的 `direct`。
4. 用户未指定时采用 Agent 的结构化建议。
5. 没有 Agent 建议时使用产品默认规则，当前默认解析为 `direct`。

选择器只返回 `mode` 和 `source`。R4.3 再负责补充 `reason`、`riskLevel`、`decidedAt` 并形成可持久化的 `ModeDecision`。
