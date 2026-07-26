# M1：Direct Workflow MVP 实施计划

> 状态：实现中
> 范围：R3
> 前置条件：M0 已完成并验证

当前进度：

- R3.1 源码与测试边界：`DONE`
- R3.2 Direct 领域类型：`DONE`
- R3.3 状态转换与不变量：`DONE`
- R3.4 Workflow Event Batch：`DONE`
- R3.5 Session Event Log 与 Store：`DONE`
- R3.6 最小 WorkflowController：`DONE`
- R3.7 接入 Direct 请求创建：`DONE`
- R3.8 对接 Pi AgentSession：`DONE`
- 下一项：R3.9 基础 Verification

## 1. 阶段目标

M1 将 M0 的设计第一次实现为可运行 TypeScript，并接入 Pi 的主 AgentSession：

```text
用户提交普通编码请求
  → 创建 Direct Workflow 和根 Task
  → 复用 Pi AgentSession 执行
  → 跟踪重试、工具、取消和最终结果
  → 进入基础 Verifying
  → 输出 CLI 状态和最终报告
```

M1 完成后只能声明：

> 已实现单 Main Agent 的 Direct Workflow 状态闭环。

不能声明已经实现自动模式、正式 Plan、Task Graph、Subagent、后台 Job、完整代码 Review/Test 或崩溃恢复。

## 2. 为什么 M1 采用 Core-first

M1 的权威状态不能只放在示例 Extension 中：

- Extension `agent_end` 事件不包含 `AgentSessionEvent.willRetry`，无法准确区分“即将自动重试”和“最终失败”。
- Workflow 必须直接使用 `AgentSession.subscribe()` 获得完整生命周期事件。
- Workflow 取消需要调用并等待 `AgentSession.abort()`。
- 领域模型、状态守卫和 Event Log 将被后续 Plan、Subagent 和 Job 共同复用。
- 示例 Extension 不会自动成为 Pi CLI 的默认产品能力。

因此 M1 把领域和协调代码放入 Core，CLI 只负责调用和展示。Extension 仍可用于后续 Plan/Subagent 交互原型，但不保存权威 Workflow 状态。

## 3. 源码与测试目录

```text
packages/coding-agent/src/core/workflow/
├── types.ts
├── transitions.ts
├── invariants.ts
├── events.ts
├── event-log.ts
├── stores.ts
├── controller.ts
├── agent-session-adapter.ts
└── index.ts

packages/coding-agent/src/modes/interactive/components/
└── workflow-status.ts

packages/coding-agent/test/workflow/
├── transitions.test.ts
├── invariants.test.ts
├── events.test.ts
├── fixtures.ts
├── stores.test.ts
├── event-log.test.ts
├── controller.test.ts
├── direct-request.test.ts
└── agent-session-adapter.test.ts

packages/coding-agent/test/suite/
└── workflow-direct.test.ts
```

约束：

- Core Workflow 不依赖 TUI。
- UI 只读取状态快照或订阅 Workflow 事件。
- M1 不创建 `tasks/`、`subagents/`、`jobs/` 等独立 Core 目录。
- 只有模块稳定或规模扩大后才拆分更多目录。
- 所有新增源码和测试都在根 `tsconfig.json` 的检查范围内。
- `test/workflow` 测纯领域逻辑和适配器边界；真实 AgentSession 集成使用 `test/suite/harness.ts` 和 faux provider。

## 4. M1 最小领域子集

M1 不一次实现 M0 的全部远期字段，只实现 Direct 所需字段，但命名和状态必须兼容 M0：

### 4.1 必须实现

- `Workflow`
- `Task`
- `Attempt`
- `VerificationResult`
- `WorkflowResult`
- `WorkflowEvent`
- `WorkflowEventBatch`
- Workflow、Task、Attempt 状态联合类型
- revision、sequence、commandId 和 schemaVersion

### 4.2 暂不实现

- `Plan`、`PlanStep` 和审批模型
- `AgentProfile` 和 `AgentRegistry`
- `Job`
- `Handoff`
- 完整 Budget 分配
- Writer Lease
- Snapshot

暂不实现的字段不能使用虚假默认值伪装为有效数据，应使用明确的可选字段或推迟对应事件。

## 5. M1 Direct 状态路径

### 5.1 成功

```text
Workflow:
received → executing → verifying → completed

Task:
pending → ready → running → verifying → succeeded

Attempt:
queued → running → succeeded
```

事件顺序：

```text
workflow.created
workflow.mode_decided(mode=direct, source=default)
task.created(root)
workflow.status_changed(executing)
task.ready
attempt.created
task.started
attempt.started
attempt.succeeded
task.verification_started
verification.started
verification.passed
task.succeeded
workflow.status_changed(verifying)
workflow.completed
```

同一命令产生的相关事件写入一个 Event Batch。

### 5.2 Pi 自动重试

`AgentSessionEvent.agent_end` 包含 `willRetry`：

- `willRetry=true`：当前 Attempt 记录失败，但 Workflow 不进入 failed；下一次 `agent_start` 创建新 Attempt。
- `willRetry=false`：根据最后 AssistantMessage 的 stopReason 进入验证、失败或取消。
- 不能使用 Extension 的简化 `agent_end` 替代此判断。

### 5.3 取消

```text
Workflow executing
  → workflow.cancel_requested
  → cancelling
  → await AgentSession.abort()
  → Attempt cancelled
  → Task cancelled
  → Workflow cancelled
```

只有 `AgentSession.abort()` 已完成、AgentSession 回到 idle 后，Workflow 才能进入 `cancelled`。

### 5.4 失败

M1 将以下情况视为失败：

- 最终 AssistantMessage `stopReason=error`。
- 最终 `stopReason=length` 且 Pi 不再重试。
- Agent Loop 结束但没有可解释的最终 AssistantMessage。
- Event 持久化或 Store 应用出现不可恢复的不一致。

如果 `stopReason=aborted` 且存在用户取消命令，则进入取消流程；否则记录异常失败。

## 6. 基础 Verification

M1 尚未实现 Review/Test/Repair，因此 Verification 只检查：

1. AgentSession 已最终结束，不再重试。
2. Attempt 有明确成功结果。
3. 根 Task 没有未处理的运行错误。
4. 成功的 edit/write Tool Result 可以汇总出修改文件。
5. Workflow 没有活动 Attempt。

M1 的最终报告必须明确显示：

```text
Code review: not configured
Tests: not configured
Build: not configured
```

不能把“未配置”写成“通过”。完整验证闭环属于 R10。

## 7. 与 Pi 的接入方式

### 7.1 Prompt 调用

Interactive CLI 的顶层 Prompt 调用经过一个薄适配器：

```text
WorkflowRuntime.runDirect(userInput)
  → Controller 创建 Workflow/Task
  → 调用现有 session.prompt(userInput)
  → Adapter 监听 AgentSessionEvent
```

M1 不修改 Pi Agent Loop，不复制 Prompt 展开、Skills、历史或 Tool Schema 逻辑。

### 7.2 生命周期事件

`AgentSessionAdapter` 使用：

- `session.subscribe(listener)`
- `session.prompt(...)`
- `session.abort()`
- `session.isStreaming`
- `session.sessionManager`

需要处理的最小事件：

- `agent_start`
- `agent_end`
- `turn_start`
- `turn_end`
- `tool_execution_start`
- `tool_execution_end`
- `auto_retry_start`
- `auto_retry_end`

### 7.3 修改文件跟踪

M1 只记录成功的内置 `edit` 和 `write` Tool Result 中的路径：

- 工具失败时不计入已修改文件。
- Bash 产生的文件变化 M1 不宣称能够完整跟踪。
- 最终报告应把该限制写清楚。

## 8. Event Log

M1 实现 `SessionWorkflowEventLog`：

- 使用 `SessionManager.appendCustomEntry("workflow-event-batch", batch)`。
- 使用 `SessionManager.getBranch()` 读取当前叶节点路径。
- 一个 Batch 对应一个 commandId。
- Batch 内 sequence 和 entityRevision 连续。
- Event 持久化成功后才能应用 Store。
- 重复 commandId 返回第一次结果。
- sequence 缺口、未知 schemaVersion 或 revision 冲突立即停止恢复。

M1 只实现当前 Session 分支重放，不实现 Snapshot 和跨 Session Workflow。

R3.5 的 `WorkflowStore` 暂时保存整个 Direct Workflow 聚合，并提供 Workflow、Task、Attempt 和 Verification 的只读查询。R6 引入 Task Graph 后，再根据规模决定是否拆出独立 `TaskStore`；M1 不提前维护两份可变状态。

Pi 在首次 Assistant 消息前可能延迟创建 Session 文件。Event Batch 会先进入 SessionManager 当前分支，磁盘刷新沿用 Pi 原有生命周期；因此 M1 只验证 Session 重放，不宣称这一窗口已经具备崩溃安全。

## 9. CLI 行为

### 9.1 状态展示

最小状态行：

```text
direct | executing | task: running | attempt: 1
```

终态：

```text
direct | completed | 1 task | 2 files | tests: not configured
```

### 9.2 控制命令

M1 只提供：

- `/workflow`：显示当前或最近一次 Workflow 摘要。
- `/workflow-cancel`：取消当前 Workflow。

`/plan`、`/tasks`、`/agents`、`/jobs` 和 `/resume` 不属于 M1。

### 9.3 输入边界

- AgentSession idle 时的普通交互输入创建新 Direct Workflow。
- 当前 Workflow 执行期间的 steer/follow-up 继续属于同一个 Workflow。
- Workflow 进入终态后，下一个普通输入创建新 Workflow。
- M1 不做自动 Direct/Plan 判断；ModeDecision 固定为 direct/default。

## 10. 实现批次

| 批次 | 对应任务 | 内容 | 完成标准 |
|---|---|---|---|
| B1 | R3.1-R3.3 | 目录、类型、状态转换和不变量 | 纯函数单元测试通过 |
| B2 | R3.4-R3.6 | Event Batch、Event Log、Store、Controller | 重放和幂等测试通过 |
| B3 | R3.7-R3.9 | 根 Task、AgentSession Adapter、基础 Verification | Fake Provider 成功和重试场景通过 |
| B4 | R3.10-R3.12 | 取消、最终报告、CLI 状态 | 取消等待 idle，状态展示正确 |
| B5 | R3.13-R3.15 | 单元/集成测试和演示 | R3 验收场景全部通过 |

每个批次完成后独立运行相关测试；所有代码完成后运行 `npm run check`。

## 11. 测试矩阵

| 测试 | 类型 | 关键断言 |
|---|---|---|
| 合法状态转换 | 单元 | revision 递增、事件正确 |
| 非法状态转换 | 单元 | 不写 Event、不改 Store |
| Event Batch 重放 | 单元 | 空 Store 重放得到相同状态 |
| 重复 commandId | 单元 | 不产生重复 Batch |
| Session 分支 | 单元 | 只读取当前 getBranch 路径 |
| Direct 成功 | Suite faux provider | Workflow completed、Task succeeded |
| Pi 自动重试 | Suite faux provider | willRetry 时不提前 failed |
| Agent 最终错误 | Suite faux provider | Workflow failed，保留 Attempt |
| 用户取消 | Suite faux provider | cancelling 后等待 abort，再 cancelled |
| 修改文件汇总 | 工具集成 | 只记录成功 edit/write |
| 下一次输入 | 集成 | 前一 Workflow 终态后创建新 ID |
| Session 恢复 | 集成 | Event Batch 可以恢复终态数据 |

测试不得调用真实 Provider、API Key 或付费模型。

## 12. M1 完成条件

只有全部满足时，M1 才能标记 `DONE`：

- M0 Direct 所需模型已实现为 TypeScript。
- Store 不能绕过 Event Log 修改状态。
- AgentSession 自动重试不会导致 Workflow 提前失败。
- Direct 请求具有根 Task 和 Attempt。
- 成功、失败和取消都有明确终态。
- 取消会等待 AgentSession idle。
- 当前 Session 分支可以重放 Workflow Event Batch。
- CLI 可以查看状态和取消。
- 最终报告不虚构 Review、Test 或 Build 结果。
- 相关测试通过。
- `npm run check` 无错误、警告和 info。
- 单文件低风险 Demo 可以重复执行。
