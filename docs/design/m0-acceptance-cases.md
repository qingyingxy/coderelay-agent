# M0：设计验收用例

> 状态：已验证
> 这些是设计验证场景，不是当前阶段要实现的测试代码。

## 1. 验收方法

每个用例都要能从以下四部分得到唯一答案：

1. 输入命令或事件。
2. 转换前聚合状态。
3. 应生成的持久化事件。
4. 转换后的 Workflow、Plan、Task 状态。

如果一个场景存在两种合理但未决的结果，M0 不能通过。

## 2. 模型用例

| ID | 场景 | 期望 |
|---|---|---|
| M0-M01 | 创建 Workflow | ID、请求、预算、时间和 received 状态完整；此时可以尚无根 Task |
| M0-M02 | ModeDecision 完成 | 进入 planning 或 executing 前，Workflow 恰好关联一个根 Task |
| M0-M03 | Task 依赖自己 | 模型校验拒绝 |
| M0-M04 | Task 依赖形成环 | Task Graph 校验拒绝 |
| M0-M05 | 重试失败 Task | 产生新 Attempt，旧 Attempt 不改变 |
| M0-M06 | 修改已批准 Plan | 拒绝原地修改，要求创建新版本 |
| M0-M07 | Plan Step 转 Task | Task 保留 sourcePlanId 和 sourcePlanStepId |
| M0-M08 | Agent 返回 Handoff | Handoff 可定位到 Workflow、Task、Attempt 和 Agent |
| M0-M09 | Job 成功退出 | Job 可 succeeded，但 Task 不自动 succeeded |
| M0-M10 | 未知 schemaVersion | 停止恢复并报告明确错误 |

## 3. Workflow 状态机用例

| ID | 场景 | 期望 |
|---|---|---|
| M0-W01 | 用户指定 direct | ModeDecision source=user，进入 Direct 路径 |
| M0-W02 | 用户未指定且低风险 | 自动生成 direct ModeDecision，不打断用户 |
| M0-W03 | 用户未指定且高风险 | 自动进入 planning |
| M0-W04 | 强制策略要求 Plan | 即使 Agent 建议 direct 也进入 planning |
| M0-W05 | 缺少关键需求 | received → clarifying |
| M0-W06 | 非关键细节缺失 | 使用合理默认值，不进入 clarifying |
| M0-W07 | Plan 生成完成 | planning → awaiting_approval |
| M0-W08 | 用户批准 Plan | 先生成有效 Task Graph，再进入 executing |
| M0-W09 | 用户拒绝 Plan | Workflow cancelled，原因是 plan_rejected |
| M0-W10 | Direct 执行中发现高风险 | 停止新增写操作，创建 Plan 并等待批准 |
| M0-W11 | 必要 Task 全成功 | executing → verifying，不直接 completed |
| M0-W12 | 验证通过 | verifying → completed |
| M0-W13 | 验证失败且可修复 | 创建 Repair Task，verifying → executing |
| M0-W14 | 修复次数耗尽 | verifying → failed |
| M0-W15 | 等待外部输入 | 当前状态 → blocked，解除后返回合法阶段 |
| M0-W16 | 用户取消 | 任意可取消状态先进入 cancelling；资源终止且 Lease 释放后才进入 cancelled |
| M0-W17 | Completed 后收到执行事件 | 记录或忽略晚到事件，不改变终态 |

## 4. Task 状态机用例

| ID | 场景 | 期望 |
|---|---|---|
| M0-T01 | 依赖未完成 | Task 保持 pending |
| M0-T02 | 依赖全部成功 | pending → ready |
| M0-T03 | 依赖失败 | pending → blocked |
| M0-T04 | 调度 Ready Task | 先创建 Attempt，再 ready → running |
| M0-T05 | 无验证要求的成功执行 | running → succeeded |
| M0-T06 | 有验证要求的成功执行 | running → verifying |
| M0-T07 | 验证通过 | verifying → succeeded |
| M0-T08 | 可重试执行失败 | Attempt failed，Task 回到 ready |
| M0-T09 | 不可重试失败 | Task failed |
| M0-T10 | 重试次数耗尽 | Task failed，保留全部 Attempt |
| M0-T11 | 写 Task 无 Writer Lease | 不允许进入 running |
| M0-T12 | Task 被取消后收到成功结果 | 保持 cancelled |
| M0-T13 | 非必要 Task 被跳过 | Task skipped，不阻止 Workflow 完成 |
| M0-T14 | 必要 Task blocked | Workflow 不能进入 verifying |
| M0-T15 | Plan 尚未批准 | 根 control Task 保持 pending，Scheduler 不执行 |
| M0-T16 | control Task | 不分配 Agent/Job，状态由必要子 Task 推导 |

## 5. Plan 用例

| ID | 场景 | 期望 |
|---|---|---|
| M0-P01 | Planner 尝试 edit/write | 在工具执行前阻止 |
| M0-P02 | Planner 执行非只读 Bash | 在工具执行前阻止 |
| M0-P03 | Plan 缺少验证方式 | 不能进入 awaiting_approval |
| M0-P04 | 用户请求修改 | 旧 Plan superseded，新 Plan 为 draft |
| M0-P05 | 批准旧 Plan 版本 | 拒绝，不改变当前 Workflow |
| M0-P06 | Plan 批准后生成 Task | 每个生成 Task 可以追溯 Plan Step |
| M0-P07 | Task 执行进度变化 | Plan 内容不变，展示进度从 Task 推导 |

## 6. Event Log 与幂等用例

| ID | 场景 | 期望 |
|---|---|---|
| M0-E01 | 持久化 Event 失败 | Store 不更新 |
| M0-E02 | Event 重复投递 | 只应用一次 |
| M0-E03 | entityRevision 不匹配 | 拒绝更新并重新读取状态 |
| M0-E04 | 相同 commandId 重复取消 | 只触发一次级联取消 |
| M0-E05 | 相同 Plan 重复批准 | 返回第一次结果，不重复生成 Task |
| M0-E06 | Event sequence 存在缺口 | 停止自动恢复 |
| M0-E07 | 从空 Store 重放全部 Event | 得到与原 Store 相同的状态 |
| M0-E08 | 从 Snapshot 加后续 Event 恢复 | 与完整重放结果相同 |
| M0-E09 | 终态重放 | 不重新启动 Agent、Job 或写操作 |
| M0-E10 | Session 分支 | 不隐式共享同一个可变 Workflow |

## 7. 权限与资源边界用例

| ID | 场景 | 期望 |
|---|---|---|
| M0-G01 | 子 Agent 请求父级没有的写权限 | 拒绝 |
| M0-G02 | Planner Profile 包含写工具 | 有效权限仍为只读 |
| M0-G03 | 两个 Writer 请求同一工作区 | 只有一个获得 Lease |
| M0-G04 | 父 Workflow 取消 | 所有子 Task、Agent 和 Job 收到取消 |
| M0-G05 | Agent 预算超过父级剩余预算 | 拒绝创建或缩减到允许范围 |
| M0-G06 | Agent 达到最大嵌套深度 | 拒绝 spawn |
| M0-G07 | Job 超时 | Job timed_out，Task 根据重试规则处理 |
| M0-G08 | CLI 重启时资源原为 running | 标记 interrupted，不推断 succeeded |

## 8. Pi 集成边界用例

| ID | 场景 | 期望 |
|---|---|---|
| M0-I01 | Agent Task 执行 | 复用 Pi AgentSession 和 Agent Loop |
| M0-I02 | Command Task 执行 | 进入 Job Runtime，不调用 LLM Agent Loop |
| M0-I03 | Workflow Event 持久化 | 原型将同一命令的 Event Batch 写入一个不进入 LLM 上下文的 Custom Entry |
| M0-I04 | Session 恢复 | 可以读取当前分支的 Workflow Event |
| M0-I05 | Extension reload 时有后台进程 | 原型不承诺继续监管，触发下沉 Core 条件 |
| M0-I06 | 使用实验 Orchestrator | 只评估实例监管，不把它视为 Task Scheduler |

## 9. M0 通过条件

- 所有用例都能由领域模型和状态转换表唯一解释。
- 不依赖 Subagent、Job 或完整恢复即可描述 Direct MVP。
- 不存在 Agent 直接修改 Workflow 或 Task 的路径。
- 不存在未审批 Plan 触发写操作的路径。
- 不存在仅凭自然语言、进程退出码或 UI 状态判定 Workflow 完成的路径。
- 所有延后能力都有明确里程碑，没有伪装为 Pi 已有正式能力。
