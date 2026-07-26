# M2：正式 Plan Mode 实施记录

> 状态：已完成
> 范围：R5
> 前置：R4、R5.2

## 1. 完成范围

- R5.1：复核现有 Plan Mode Extension。
- R5.2：正式 Plan 数据模型与状态机。
- R5.3：Planner 只读门禁。
- R5.4：批准、拒绝和修改请求记录。
- R5.5：不可覆盖的 Plan 版本链。
- R5.6：批准后将 Plan Step 转换为 Task。
- R5.7：从关联 Task 推导 Plan 进度。
- R5.8：`/plan`、`/approve`、`/reject`、`/replan`。
- R5.9：领域、适配器和 AgentSession 回归测试。
- R5.10：无网络、无费用、可重复演示。

## 2. 现有 Extension 复核

可以参考：

- `/plan` 命令和状态展示交互。
- 进入规划时收紧活动工具，结束后恢复。
- 使用 Session Entry 恢复当前分支状态的思路。
- 批准前向用户展示 Plan。

不能作为正式状态源：

- Extension 内存中的 `enabled`、`executing` 和 Todo 列表。
- 从 Assistant Markdown 的 `Plan:` 标题提取步骤。
- 依靠 `[DONE:n]` 文本判断执行进度。
- 关闭 Plan Mode 后直接恢复完整工具集合。
- 仅靠 Bash 正则判断所有命令是否只读。

正式实现使用 Core Event Log、WorkflowStore、结构化 PlanContent 和关联 Task。第一版 Planner 完全禁用 Bash，比示例的命令 allowlist 更严格；正式命令策略仍属于 R7。

## 3. 正式流程

```text
/plan
  → 下一条需求进入 Plan Mode
  → 创建 Workflow、Control Root Task、Draft Plan
  → Planner PromptEnvelope
  → AgentSession 工具临时收紧为 read/grep/find/ls 子集
  → 解析结构化 PlanContent
  → Plan awaiting_approval
  ├─ /approve → 记录批准 → Plan Step 转 Task → Workflow executing
  ├─ /reject  → 记录拒绝 → Workflow cancelled
  └─ /replan  → 旧版本 superseded → 新 Draft → 再次只读规划
```

R5 的 `executing` 只表示批准后的 Task Graph 已准备好。Task Ready 推导和调度由现已完成的 R6 接续；真实 Subagent 与 Job Runtime 仍分别属于 R8、R9。

## 4. 状态与持久化

- 每个批准、拒绝和修改请求写入 `Plan.decisionHistory`，包含动作、意见和时间。
- 修改不会覆盖旧 Plan，而是创建 `version + 1` 并设置 `supersedesPlanId`。
- `workflow.plan_selected` 始终指向当前版本。
- 批准时按 Plan Step 创建 Task，并保存 `sourcePlanId`、`sourcePlanStepId`、父 Task 和依赖。
- Plan 进度只读取这些 Task 的状态，不扫描 Assistant 文本。

## 5. CLI

| 命令 | 行为 |
|---|---|
| `/plan` | 显示当前 Plan；没有活动 Plan 时让下一条需求进入只读规划 |
| `/approve [comment]` | 批准当前 Plan，记录意见并生成 Task |
| `/reject [reason]` | 拒绝当前 Plan并终止 Workflow |
| `/replan [instructions]` | 创建新版本并等待下一条细化需求 |
| `/workflow` | 显示 Plan 版本、状态、目标和步骤 |

## 6. 验证

- Workflow 与 Plan 相关测试：27 个文件、202 个用例通过。
- Plan AgentSession 集成使用 Faux Provider，不调用真实模型。
- `npm run demo:plan-workflow` 通过。
- Plan 演示确认批准前不创建计划中的文件，批准后生成 Task；R6 调度另由 `npm run demo:task-scheduler` 独立演示。
- `npm run check` 通过。

演示说明见 [`M2 Plan Workflow 演示`](../demos/m2-plan-workflow.md)。
