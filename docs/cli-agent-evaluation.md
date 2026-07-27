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

## 限制

- 这是确定性机制评测，不代表真实 LLM 的代码正确率。
- 模式任务是固定小样本，只能用于回归，不支持泛化结论。
- 没有声称真实仓库任务成功率、Token 节省比例或性能提升。
- 后续若加入真实模型评测，必须记录模型、版本、Prompt、数据集、失败样本和实际成本。
