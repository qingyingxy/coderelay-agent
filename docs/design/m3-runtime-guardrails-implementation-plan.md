# M3：运行保障能力实施记录

> 状态：已完成
> 范围：R7
> 前置：R4-R6

## 1. 完成范围

- R7.1：父级、Agent Profile、Workflow、Task 权限取交集，路径白名单取最窄范围，拒绝越权工具。
- R7.2：Planner、Explorer、Reviewer 等只读 Profile 在 AgentSession Prompt 执行边界不能启用写入或命令工具。
- R7.3-R7.4：同一工作区只有一个 Writer Lease；默认 Registry 使用临时目录中的原子租约文件协调不同 CLI 进程，并支持续约、释放、TTL 过期和恢复。
- R7.5：成功的 `edit`、`write` 记录 Workflow、Task、Attempt、Agent、Tool Call、操作和路径。
- R7.6-R7.8：统一 Token、费用、轮次、时间、并发、深度和重试预算；子级取最小值；达到 80% 生成软警告，达到硬限制拒绝新 Attempt。
- R7.9：取消先进入 `cancelling`，停止 Workflow 的 Agent/Job 资源，再释放 Writer Lease，最后级联取消非终态 Attempt 和 Task。
- R7.10：Controller 和 Scheduler 同时约束 Agent/Job 并发、Agent 深度和重试次数。
- R7.11：领域、Controller、AgentSession、跨 Registry 和 CLI 集成测试，以及无网络离线演示。

## 2. 运行边界

```text
PromptEnvelope
  → Effective Permission = Parent ∩ Profile ∩ Workflow ∩ Task
  → 拒绝越权工具

Scheduler / Controller
  → 校验 Workflow 与 Task Budget
  → 获取 Writer Lease（写 Task）
  → 创建 Attempt
  → 注册 Agent / Job 运行资源
  → 成功写工具记录修改归属

Workflow cancel
  → cancelling
  → stop Agent / Job
  → release Writer Lease
  → cancel Attempts / Tasks
  → cancelled
```

权限、预算和 Writer Lease 是运行时守卫，不依赖 Prompt 自觉遵守。Controller 仍是状态转换入口，Store 与 Event Log 保存权威状态和修改历史。

## 3. Writer Lease

默认 Writer Lease Registry 将标准化工作区路径做 SHA-256 映射，并通过同一临时目录下的原子目录重命名获取租约：

- 不向用户仓库写锁文件。
- 不同 Pi CLI 进程共享租约目录。
- 租约包含 Workflow、Task、可选 Attempt、所有者、获取时间、续约时间和过期时间。
- 只有租约所有者可以续约或主动释放。
- 过期租约在读取、获取或枚举时回收。

Git worktree 隔离、Patch 合并和冲突解决仍属于后续安全增强，不在 R7 内伪装完成。

## 4. CLI 可见性

| 入口 | 展示 |
|---|---|
| `/workflow` | Direct Workflow 状态、Budget 和 Writer Lease |
| `/plan` | Plan 状态、Budget 和当前工作区 Writer Lease |
| `/tasks` | Budget、Writer Lease、Task Tree 和可调度 Task |
| `/task show <id>` | Attempt 历史和逐条文件修改归属 |

## 5. 后续边界

R7 只完成受控 Runtime 的公共保障底座：

- R8 才实现正式 Subagent、AgentRegistry、父子层级和结构化 Handoff。
- R9 才实现后台 Job 进程、日志、超时和进程树终止。
- R10 才实现 Diff、Review、Test、Repair 和恢复闭环。

## 6. 验证

- 权限测试覆盖交集、路径收窄、只读 Profile 和 AgentSession 工具拒绝。
- Writer Lease 测试覆盖冲突、续约、释放、过期、Workflow 清理和两个独立 Registry 的共享目录竞争。
- Budget 测试覆盖继承、80% 警告、Token/费用硬限制、并发、深度和重试拒绝。
- Controller 测试覆盖修改归属、Plan 多 Task 级联取消和 Attempt 清理。
- Runtime Registry 测试覆盖 Agent/Job 并行停止和失败报告。
- `npm run demo:runtime-guardrails` 无网络、无 API Key、不会修改仓库。
- `npm run check` 通过。
