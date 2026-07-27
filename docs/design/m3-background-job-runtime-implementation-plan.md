# M3：Background Job Runtime 实施记录

> 状态：已完成
> 范围：R9
> 前置：R6-R8

## 1. 完成范围

- R9.1：Job 保存 Workflow、Task、Attempt、命令、cwd、状态、PID、日志引用、退出码、超时和时间戳。
- R9.2：`JobRegistry` 负责 Job 生命周期、归属、日志和事件，终态不可被迟到的进程退出覆盖。
- R9.3：`JobRuntime` 提供 `jobs`、`logs`、`wait`、`kill` 和 Workflow 级联取消。
- R9.4：stdout/stderr 分离记录，日志带递增游标，超过总量后丢弃头部并保留尾部。
- R9.5：超时和取消先向进程组发送正常终止，再在宽限期后强制清理完整进程树。
- R9.6：`job_completed` 事件和完成 Promise 将结果通知 Plan Runtime，由 Controller 更新 Attempt 和 Task。
- R9.7：Plan 可声明 Command Step，批准后生成 Command Task；Scheduler 将它路由到 Job。
- R9.8：提供 `/jobs`、`/jobs dispatch`、`/job run/show/logs/wait/kill`。
- R9.9：测试覆盖输出、日志截断、超时、重复 kill、级联取消、本地进程和 Task 完成通知。

## 2. 状态所有权

```text
Plan Command Step
  → Command Task
  → Scheduler selects executorKind=job
  → JobRuntime owns process and logs
  → JobRegistry emits terminal notification
  → PlanWorkflowRuntime translates result
  → WorkflowController updates Attempt / Verification / Task
```

Job 退出码为 0 只证明命令成功。Task 是否成功仍由 `WorkflowController` 根据关联的 Verification Requirement 决定；Job Runtime 不能直接改变 Task 或 Workflow。

## 3. 进程与日志

- Windows 使用 `taskkill /T`，宽限期后使用 `/F /T`。
- Unix 对独立进程组发送 `SIGTERM`，宽限期后发送 `SIGKILL`。
- stdout 和 stderr 使用同一个全局递增序号，CLI 可通过 `after-sequence` 增量读取。
- 默认每个 Job 保留 256 KiB 日志尾部；累计字节数和截断标志仍保存在 Job。
- 超时、kill 和 interrupted 先固定 Job 终态，之后到达的退出事件不会把它改回 succeeded。

## 4. CLI

| 命令 | 作用 |
|---|---|
| `/jobs` | 列出当前 Workflow 的 Job |
| `/jobs dispatch [n]` | 调度 Ready Command Task |
| `/job run <task-id>` | 运行指定 Ready Command Task |
| `/job show <job-id>` | 展示命令、状态、PID 和退出码 |
| `/job logs <job-id> [after-sequence]` | 读取全量或增量 stdout/stderr |
| `/job wait <job-id>` | 等待完成并展示终态 |
| `/job kill <job-id> [reason]` | 终止进程树 |

## 5. 当前限制

- JobRegistry 当前是进程内运行投影；重启恢复与 interrupted 标记属于 R10.9-R10.10。
- Command Task 默认取得 Writer Lease，因为任意构建或脚本可能写入工作区；更细的命令副作用策略属于后续安全增强。
- R9 只把命令退出结果接入单项 Verification；Review、Build/Test 汇总、Repair 和 Completion Gate 属于 R10。

## 6. 验证

- Job Runtime 单元测试覆盖状态、事件、日志、超时、kill、取消与本地进程。
- Plan Runtime 集成测试覆盖 Command Step 到 Task 成功回写。
- AgentSession 使用 Faux Provider 和伪进程验证 Job CLI，不访问真实模型。
- `npm run demo:job-runtime` 离线运行真实本地命令，不读取 API Key，不修改仓库。
- `npm run check` 通过。
