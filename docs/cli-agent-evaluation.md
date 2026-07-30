# CLI Agent 确定性评测

## 目标

评测只验证已经实现的 CLI Workflow 机制，不调用真实模型、不使用 API Key，也不把单元测试结果包装成模型能力。

运行：

```bash
npm run eval:cli-agent
```

## 固定任务集

| 用例 | 验证点 | 期望 |
|---|---|---|
| localized-readme-fix | 低复杂度、低风险单文件任务 | Direct |
| workflow-state-refactor | 跨 Controller、Store、Recovery 的高复杂度任务 | Plan |
| destructive-cli-migration | 有破坏性风险的持久化迁移 | Plan |
| approval-gate | Plan 批准前不生成可执行 Task | 通过 |
| dependency-scheduling | 两个有依赖的 Task 只放行首个 | 通过 |
| snapshot-recovery | 终态和停止原因可恢复 | 通过 |

## 2026-07-27 基线

```text
Completion rate: 6/6 (100.0%)
Mode accuracy: 3/3 (100.0%)
```

CLI 的 Faux Provider 集成回归另覆盖 Direct、Plan、Subagent、Job、取消、Repair 和恢复；当前两个专项文件共 16 个用例通过。

## R19 多 Agent 协议评测

真实模型策略不再依赖“必须调用 Subagent”的 Prompt。Runner 将五种策略编译为 `r19-v1` Workflow Execution Protocol，并分别统计协议合规、任务验证、成本、时长和 Reviewer 发现。

只校验固定 Fixture：

```bash
npm run eval:cli-agent:model -- --verify-task-set
```

运行单任务稳定性烟测：

```bash
npm run eval:cli-agent:model -- --tasks slug-normalization --strategies main_explorer,main_reviewer,planner_worker_reviewer --repetitions 3 --output .artifacts/r19-smoke --keep-failed-workspaces
```

运行 45 次完整矩阵：

```bash
npm run eval:cli-agent:model -- --repetitions 3 --output .artifacts/r19-matrix --keep-failed-workspaces
```

失败 Artifact 包含 Workspace、Session JSONL、Workflow View、Diff、Verification 和 Handoff。真实模型命令会产生 API 成本；没有报告文件时不得宣称多 Agent 效果已验证。

## 限制

- 这是确定性机制评测，不代表真实 LLM 的代码正确率。
- 模式任务是固定小样本，只能用于回归，不支持泛化结论。
- 没有声称真实仓库任务成功率、Token 节省比例或性能提升。
- 后续若加入真实模型评测，必须记录模型、版本、Prompt、数据集、失败样本和实际成本。
