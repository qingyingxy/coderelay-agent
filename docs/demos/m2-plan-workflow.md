# M2 Plan Workflow 演示

## 目标

用固定 Faux Provider 重复演示正式 Plan Mode：

```text
/plan 选择模式
  → 只读 Planner 生成结构化 Plan
  → Workflow awaiting_approval
  → 用户 /approve
  → 记录审批
  → Plan Step 转换为关联 Task
  → Workflow executing
```

R5 只负责进入执行并生成 Task Graph；Task 调度与实际代码修改属于 R6。

## 运行

在仓库根目录执行：

```bash
npm run demo:plan-workflow
```

演示不访问网络、不读取真实 API Key，也不会修改仓库。

## 验收点

- Planner 只能使用当前 AgentSession 中的 `read`、`grep`、`find`、`ls` 子集。
- `edit`、`write` 和 `bash` 不会进入 Planner 工具边界。
- Plan 在批准前保持只读，Workflow 为 `awaiting_approval`。
- `/approve` 保存用户审批意见和时间。
- 每个 Plan Step 生成一个带 `sourcePlanId`、`sourcePlanStepId` 的 Task。
- Task 依赖由 Plan Step 依赖转换，不使用 `[DONE:n]` 文本标记。
- R6 Scheduler 尚未运行，因此批准后仍不会实际修改文件。
