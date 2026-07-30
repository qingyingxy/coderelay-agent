# R19 Workflow Execution Protocol 实施记录

## 目标

真实模型可以忽略“必须调用 Subagent”的提示词。R19 将显式多 Agent 策略从 Prompt 约定改为 Runtime 协议，使角色、执行阶段、次数、Handoff 和完成门禁成为可持久化、可恢复、可测试的事实。

协议版本为 `r19-v1`，当前支持：

- `before_main`：Main 启动前的只读 Explorer。
- `implementation`：Plan 中必须存在的 Worker。
- `after_main`、`before_delivery`：Main 修改后、完成前的只读 Reviewer。
- `fail_workflow`、`retry_once`：有界失败策略。

## Runtime 数据流

```text
Evaluation Strategy
  -> WorkflowExecutionProtocol
  -> SessionExecutionProtocolRuntime
  -> Session Event Log Checkpoint
  -> WorkflowView / RPC

Direct:
  Explorer -> structured Handoff -> Main -> deferred completion -> Reviewer -> Completion Gate

Plan:
  Planner JSON -> protocol compiler -> Worker Task + required Review Verification
  -> Scheduler / Delivery Runtime -> Completion Gate
```

每次协议运行保存稳定 Run ID、Requirement、角色、阶段、Agent、Handoff、状态、摘要和时间。恢复读取当前 Session Branch 上最后一个 Checkpoint；相同稳定 Run ID 不会重复创建协议记录。

## 已完成门禁

- Main 模型不调用 Subagent 工具时，`main_explorer` 仍会在 Main 前运行 Explorer。
- Explorer 没有成功 Handoff 时，Main 不会开始，Workflow 以协议失败结束。
- `main_reviewer` 的主 Attempt 成功后只进入 `verifying`，Reviewer 通过前不会完成。
- Reviewer 失败或缺少 Handoff 时，Workflow 不会误报完成。
- Reviewer 返回证据化失败时，Runtime 最多触发一次 Main Repair，并在新 Attempt 后重新 Review。
- `planner_worker_reviewer` 会确定性补齐 Worker Task 和必选 Review Verification；Controller 将角色写入 `Task.recommendedAgentRole`。
- Workflow View 和 RPC 可读取协议满足状态与违规原因。
- 取消会先持久化 `cancelling`，再级联停止前置 Explorer；失败评测可保留 Workspace、Session、View、Diff、Verification 和 Handoff。

## 确定性证据

- `test/suite/workflow-direct.test.ts`：模型忽略委派时仍强制 Explorer；Reviewer 通过前保持未完成。
- `test/suite/workflow-protocol-plan.test.ts`：Planner 缺少 Worker/Reviewer 时由协议编译器补齐。
- `test/workflow/execution-protocol.test.ts`：Checkpoint 恢复和稳定 Run ID 幂等。
- `test/workflow/agent-session-adapter.test.ts`：延迟完成与协议失败不误完成。

## 尚未完成

- 真实模型 3 次稳定性烟测与 45 次完整矩阵尚未执行，因此不能宣称“多 Agent 效果已经验证”或“生产级”。
