# M3：Subagent Runtime 实施记录

> 状态：已完成
> 范围：R8
> 前置：R4-R7

## 1. 完成范围

- R8.1：复核现有 Extension 示例。复用独立 Pi 进程、RPC 流式事件、并行与取消思路；不继续使用一次性 Prompt 拼接充当正式运行时。
- R8.2：`AgentRegistry` 保存 Agent ID、父子关系、Task、Attempt、Session、Profile、状态、预算、用量、事件和 Handoff。
- R8.3：`SubagentRuntime` 提供 `spawn`、`send`、`wait`、`interrupt`、`list` 和 `retry`。
- R8.4：默认通过 Pi RPC 模式创建独立 `AgentSession`，使用 `--no-session` 和受限工具集合隔离上下文。
- R8.5：有效权限取 Parent、Profile、Workflow、Task 的交集；预算取各层最小值，流式 Turn 达到硬限制时中断，并限制并发、深度和重试。
- R8.6：记录 created、started、progress、blocked、completed、failed、interrupted 和 usage。
- R8.7-R8.8：严格校验结构化 Handoff，聚合并行结论、证据、修改、风险、未完成项和写入冲突。
- R8.9：Scheduler 可将 Agent/Repair Task 路由为 `subagent`，Plan Runtime 将 Agent 结果转换为 Attempt 和 Task 事件。
- R8.10：提供 `/agents` 和 `/agent` 命令。
- R8.11：单元测试、Faux Provider 集成测试、伪 RPC 子进程测试和离线演示。

## 2. 运行边界

```text
Approved Plan
  → Task Graph / Scheduler
  → SubagentRuntime.spawn
  → Permission ∩ Budget ∩ Writer Lease
  → independent Pi RPC AgentSession
  → Agent Loop / tools / streaming events
  → structured Handoff validation
  → Attempt result
  → Task result with handoffId
```

`AgentRegistry` 只拥有 Agent 运行状态。`WorkflowController` 仍是 Attempt、Task 和 Workflow 状态的唯一转换入口；Subagent 不能直接把 Task 或 Workflow 标记为完成。

## 3. 上下文与 Handoff

子 Agent 只接收当前 Task、Profile System Prompt、工具限制和结构化输出协议，不复制主 Agent 的完整消息历史。成功输出必须包含：

- 任务结论；
- 文件与行号证据；
- 架构发现；
- 修改文件；
- 验证结果；
- 风险；
- 未完成事项。

字段缺失、JSON 无效、结论为空或没有验证结果时，Agent 运行记为失败，Task 不进入 `succeeded`。

## 4. CLI

| 命令 | 作用 |
|---|---|
| `/agents` | 列出当前 Plan Workflow 的 Agent |
| `/agents dispatch [n]` | 通过 Scheduler 分派最多 n 个 Ready Task |
| `/agent spawn <task> [profile]` | 为指定 Ready Task 创建 Subagent |
| `/agent show <agent>` | 展示 Profile、层级、Task、Session、权限、用量、事件和 Handoff |
| `/agent send <agent> <message>` | 给运行中的 Agent 发送 steering 消息 |
| `/agent wait <agent>` | 等待 Agent，并等待结果回写 Task |
| `/agent interrupt <agent> [reason]` | 中断 Agent 并结束对应 Attempt |
| `/agent retry <agent>` | 在 Task 允许重试时创建新的 Agent 和 Attempt |

## 5. 当前限制

- AgentRegistry 当前是进程内运行投影；重启后的 Agent 恢复属于 R10.9-R10.10。
- RPC 子进程按工具集合执行权限收窄；离线权限会移除 `bash`，无法可靠执行的路径级策略会拒绝启动而不是静默放宽。受限命令、网络代理和沙箱策略属于后续完整安全体系。
- 多 Writer 仍使用 R7 Writer Lease 串行化；worktree 隔离和 Patch 合并不在 R8。
- Background Job、Reviewer/Test/Repair 闭环分别属于 R9、R10。

## 6. 验证

- AgentRegistry 测试覆盖层级、状态、阻塞、事件、用量和非法转换。
- Runtime 测试覆盖成功、流式 steering、修改归属、Handoff 失败、重试、中断和深度超限。
- Handoff 测试覆盖严格校验、去重聚合和修改冲突识别。
- AgentSession 使用 Faux Provider 和伪 Subagent Session 验证 Plan → Scheduler → Agent → Task 回写。
- RPC 测试使用伪子进程验证独立 Session、输出和用量传递。
- `npm run demo:subagent-runtime` 无网络、无 API Key、不会修改仓库。
- `npm run check` 通过。
