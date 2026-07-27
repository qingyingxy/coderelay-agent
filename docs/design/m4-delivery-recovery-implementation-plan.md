# M4：交付闭环与恢复实施记录

> 状态：已完成
> 范围：R10
> 前置：R7-R9

## 1. 完成范围

- R10.1：`DiffCollector` 只收集 Workflow 已登记的修改，并关联 Task、Attempt、Agent 和操作类型。
- R10.2：`SubagentReadonlyReviewer` 使用 Reviewer Profile 和只读权限检查 Diff，通过结构化 Handoff 返回结论、风险和未完成项。
- R10.3：Test/Build 复用 `JobRuntime`，命令、退出码和日志引用进入 Verification。
- R10.4：Workflow 级 Verification 统一保存 `running → passed/failed/skipped`，skipped 必须有原因。
- R10.5：所有可执行 Task 成功且所有必要 Verification 最新结果通过后，Completion Gate 才允许完成。
- R10.6-R10.7：验证失败创建显式 Repair Task；修复次数由 Workflow `maxRetries` 限制，耗尽后失败。
- R10.8：终态报告汇总 Task、Attempt、文件、Verification、风险、未完成项、用量和耗时。
- R10.9：Session 同时保存 Event Batch 和 Workflow Snapshot；恢复先加载 Snapshot，再重放更晚事件。
- R10.10：重启时将 queued/running/waiting Attempt 标记为 interrupted，并把对应 Task 恢复为 ready。
- R10.11：恢复指定 Workflow 时释放其遗留 Writer Lease，不释放其他 Workflow 的 Lease。
- R10.12：提供 `/verify` 和 `/workflow-resume list/continue/retry/cancel`。
- R10.13：测试覆盖成功交付、Repair、上限、Diff 归属、Snapshot 重放、运行资源中断和 Lease 恢复。

## 2. 交付状态流

```text
Executable Tasks succeeded
  → Workflow verifying
  → Diff / Review / Test / Build
  → latest required Verification results
      ├─ all passed → Completion Gate → completed
      ├─ failed → Repair Task → executing → verify again
      └─ missing/skipped → failed
```

Repair 不是对失败命令的无条件重跑。Controller 创建独立 Task 和 Attempt，因此失败历史、修复归属和预算消耗都可追踪。

## 3. 恢复模型

Event Log 仍是历史事实来源，Snapshot 只是加速投影：

```text
latest valid Snapshot
  + Event Batch(sequence > snapshot.lastSequence)
  → restored WorkflowStore
  → uncertain Attempt becomes interrupted
  → Task becomes ready
  → stale Writer Lease released
```

恢复不会复活旧 PID、AgentSession 或进程内 Registry。运行资源身份来自持久化 Attempt assignment，旧资源统一按不确定中断处理，用户再通过 Resume CLI 重试或取消。

## 4. CLI

| 命令 | 作用 |
|---|---|
| `/verify` | 对当前 Plan Workflow 执行 Diff、Review、Test/Build 和 Completion Gate |
| `/workflow-resume list` | 列出当前 Session 分支中的持久化 Plan Workflow |
| `/workflow-resume continue [workflow-id]` | 从 Snapshot 与后续事件恢复 Workflow |
| `/workflow-resume retry <task-id>` | 重试恢复后的失败或中断 Task |
| `/workflow-resume cancel [workflow-id]` | 级联取消恢复后的 Workflow |

## 5. 边界

- Diff 的可信范围是 Workflow 已记录的修改，工作区中的无归属用户改动不会被认领。
- Test/Build 只执行 Plan 明确配置的命令；缺失的必要命令记为 skipped 并阻止完成。
- Snapshot 损坏时停止恢复，不静默退回可能不一致的状态。
- 自动 Git worktree 合并、容器沙箱和通用策略引擎仍不在 M4 范围。

## 6. 验证

- Delivery 与恢复聚焦测试覆盖成功、失败、Repair、上限、重放、中断和 Lease。
- AgentSession Faux Provider 集成测试覆盖 `/verify` 与 `/workflow-resume`，不访问真实模型。
- `npm run demo:delivery-recovery` 离线演示 Completion Gate、最终报告和终态恢复。
- `npm run check` 通过。
