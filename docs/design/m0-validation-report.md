# M0 验证报告

> 结论：通过
> 验证日期：2026-07-26
> 验证范围：R0-R2 设计交付物，不包含运行时代码

## 1. 验证对象

- [`m0-architecture-baseline.md`](./m0-architecture-baseline.md)
- [`m0-domain-model.md`](./m0-domain-model.md)
- [`m0-state-event-protocol.md`](./m0-state-event-protocol.md)
- [`m0-acceptance-cases.md`](./m0-acceptance-cases.md)
- [`cli-agent-long-term-roadmap.md`](../cli-agent-long-term-roadmap.md)

## 2. 验证方法

1. 将 R0-R2 的每项任务映射到明确设计交付物。
2. 检查 Workflow、Plan、Task、Attempt、Agent、Job、Handoff 和 Verification 的关系。
3. 逐条走查 Workflow、Plan 和 Task 状态转换及守卫。
4. 检查 Event Batch、revision、幂等、当前 Session 分支重放和副作用恢复语义。
5. 使用 74 个设计验收场景验证正常、失败、阻塞、取消和恢复路径。
6. 对照 Pi 源码和示例检查复用边界，避免把 Extension 示例写成正式 Core 能力。
7. 静态检查文档链接、代码块、任务引用、状态术语和用例 ID。

## 3. R0-R2 追踪结果

| 范围 | 数量 | 结果 | 主要证据 |
|---|---:|---|---|
| R0：范围与架构基线 | 6 | 通过 | 架构层、目录边界、术语、非目标、Pi 复用边界 |
| R1：核心数据模型 | 8 | 通过 | 领域关系、Schema、不变量、模型验收用例 |
| R2：状态、Store 与 Event | 10 | 通过 | 三个状态机、转换守卫、Store、Controller、Event Batch、幂等 |
| 合计 | 24 | 通过 | R0.1-R2.10 |

其中 R0.1、R0.2 在本轮之前已经完成；本轮验证了其结论与实际仓库仍一致。

## 4. Pi 实现边界核对

| 判断 | 证据 | 结果 |
|---|---|---|
| Pi 已有 AgentSession 和会话 Runtime | `packages/coding-agent/src/core/agent-session.ts`、`agent-session-runtime.ts` | 通过 |
| Extension 可以注册命令、工具、事件和 Custom Entry | `packages/coding-agent/src/core/extensions/types.ts` | 通过 |
| Session 使用 JSONL 树和当前分支路径 | `packages/coding-agent/docs/session-format.md`、`session-manager.ts#getBranch` | 通过 |
| Plan Mode 是提示词和文本进度驱动的示例 | `examples/extensions/plan-mode/index.ts` 与 README | 通过 |
| Subagent 是独立 Pi 子进程示例 | `examples/extensions/subagent/index.ts` 与 README | 通过 |
| Subagent 示例没有正式 Registry 和持久化 Runtime | 子进程以 `--no-session` 运行，结果保存在单次工具调用中 | 通过 |
| Orchestrator 是实验性实例管理包 | `packages/orchestrator/README.md` 与 `src/types.ts` | 通过 |
| Orchestrator 不等于 Task Graph Scheduler | 当前类型围绕 Pi Instance/Machine 状态 | 通过 |

## 5. 验收用例结果

| 用例组 | 数量 | 结果 |
|---|---:|---|
| 领域模型 | 10 | 通过 |
| Workflow 状态机 | 17 | 通过 |
| Task 状态机 | 16 | 通过 |
| Plan | 7 | 通过 |
| Event Log 与幂等 | 10 | 通过 |
| 权限与资源边界 | 8 | 通过 |
| Pi 集成边界 | 6 | 通过 |
| 合计 | 74 | 通过 |

这里的“通过”表示设计可以对每个场景给出唯一合法结果，不代表运行时代码已经实现或自动化测试已经运行。

## 6. 验证中发现并修正的问题

| ID | 问题 | 修正 |
|---|---|---|
| V01 | Plan 保存 `producedTaskIds`，与批准后 Plan 不可变冲突 | 删除正向 Task ID，改由 Task 的 Plan 来源字段反向查询 |
| V02 | Task 同时保存 `parentTaskId` 和 `childTaskIds` | 只保存 `parentTaskId`，子列表由 TaskStore 推导 |
| V03 | Direct 发现高风险后没有合法进入 Plan 的转换 | 增加 `executing → planning` 和停止写入守卫 |
| V04 | Verifying 进入 Blocked 后无法返回 | BlockedReason 保存 `resumeStatus`，增加 `blocked → verifying` |
| V05 | Workflow 取消直接进入终态 | 增加 `cancelling`，完成资源清理后才能 `cancelled` |
| V06 | Session 恢复可能混入其他分支 Event | 强制使用 `sessionManager.getBranch()` 读取当前叶节点路径 |
| V07 | 一个命令产生多个 Event 时可能部分写入 | 同一命令使用单个 `WorkflowEventBatch` Custom Entry |
| V08 | Plan 根 Task 可能在批准前被 Scheduler 执行 | 根 Control Task 保持 pending，Ready 还要求 Workflow executing |
| V09 | Event 已写但副作用未启动存在崩溃窗口 | 使用 Attempt 意图事件和 `attemptId` 幂等启动 |
| V10 | Plan 可以没有验证方式 | 要求 Plan 至少包含一个 VerificationRequirement |

## 7. 自动一致性检查

- M0 开发阶段：12 个总阶段中的 R0-R2。
- 路线图任务引用无缺失；任务总数允许在后续里程碑细化时增长。
- M0 验收用例：74 个，无重复 ID。
- Workflow、Task、Plan 状态术语：无缺失。
- 旧的 `producedTaskIds`、`childTaskIds`：无残留。
- M0 文档相对链接：有效。
- Markdown 代码块：闭合。

## 8. 延后但不阻塞 M0 的事项

以下内容已经定义边界，但应在对应里程碑实现：

- Prompt Pipeline 和自动模式启发式：R4。
- Plan Runtime 和审批 UI：R5。
- Task Scheduler 具体算法：R6。
- 权限、预算、Writer Lease 具体实现：R7。
- Subagent Registry 和 Runtime：R8。
- Job 进程监管：R9。
- Snapshot、完整崩溃恢复和 Repair Loop：R10。
- CLI/TUI 打磨和评测：R11。

这些延期项不影响 R3 Direct MVP 使用 Main Agent 建立第一个纵向闭环。

## 9. 验证结论

M0 通过以下出口条件：

- 架构边界与 Pi 实际能力一致。
- 模型关系不存在已知双重事实源。
- Workflow、Plan、Task 状态机包含合法守卫和终态规则。
- `blocked`、`cancelling` 和恢复目标语义明确。
- Event Batch 可以表达原子命令结果，并支持当前 Session 分支重放。
- Direct MVP 不依赖尚未实现的 Subagent、Job 或完整恢复。
- 74 个设计场景均有唯一合法结果。

因此 M0 可以标记为 `DONE`。下一阶段是 M1，对应 R3 Direct Workflow MVP。
