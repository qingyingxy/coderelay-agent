# M2：Task Graph 与 Scheduler 实施记录

> 状态：已完成
> 范围：R6
> 前置：R5

## 1. 完成范围

- R6.1：父子 Task、DAG 索引、缺失引用和环检测。
- R6.2：从依赖终态批量推导 `Ready` 与 `Blocked`。
- R6.3：每次执行和重试创建独立 Attempt。
- R6.4：Scheduler 只选择 `Ready` Task。
- R6.5：Main Agent、Subagent、Job 的统一执行器接口与 Registry。
- R6.6：只读 Task 有界并行，Writer Task 独占工作区。
- R6.7：依赖失败阻塞、显式解除阻塞和保留重试历史。
- R6.8：`/tasks`、`/task show`、`/task retry`、`/task cancel`。
- R6.9：领域、Controller、Scheduler 和 AgentSession 回归测试。

## 2. 调度流程

```text
Plan approved
  → Plan Step materializes as Task DAG
  → Controller derives Pending → Ready / Blocked
  → Scheduler filters Ready Tasks
  → read-only Tasks may fill available concurrency slots
  → Writer Task runs alone
  → executor creates a distinct Attempt
  → execution and verification facts update Task
  → succeeded dependencies unlock downstream Tasks
```

Scheduler 只做确定性选择，不直接修改状态。Controller 仍是状态转换入口，Store 和 Event Log 仍是权威事实源。

## 3. 执行器边界

`TaskExecutor` 统一定义：

- `canExecute(task)`：执行器能力检查。
- `execute(request)`：接收 Task、Dispatch 和 Attempt。
- `cancel(taskId, reason)`：停止所属运行资源。

当前 Scheduler 将 Agent/Repair Task 路由到 Main Agent，将 Command Task 路由到 Job。Subagent 的自动选择和真实运行时属于 R8，Background Job 的真实运行时属于 R9；R6 只固定稳定接缝，不伪装后续 Runtime 已完成。

## 4. CLI

| 命令 | 行为 |
|---|---|
| `/tasks` | 刷新 Ready/Blocked，显示 Task Tree 和当前可调度 Task |
| `/task show <id>` | 显示依赖、访问模式、执行器和 Attempt 历史 |
| `/task retry <id>` | 在阻塞条件已解除后恢复到 Ready |
| `/task cancel <id> [reason]` | 取消未运行 Task，并重新推导下游阻塞 |

运行中的 Task 必须先由所属 Runtime 停止 Attempt，不能通过 CLI 绕过清理直接进入 Cancelled。

## 5. 验证

- Task Graph 测试覆盖父子索引、依赖索引、缺失引用和环。
- Scheduler 测试覆盖 Ready、失败依赖、并行只读、Writer 独占、Job 路由和 Executor Registry。
- Controller 测试覆盖批量推导、阻塞解除、独立 Attempt、重试成功解锁下游和取消传播。
- AgentSession Faux Provider 测试覆盖 Task Tree、查询和取消命令，不调用真实模型。
- `npm run demo:task-scheduler` 无网络、无费用、不会修改仓库。
- `npm run check` 通过。
