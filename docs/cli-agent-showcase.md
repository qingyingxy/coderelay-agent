# CLI Agent 可复现演示

运行：

```bash
npm run demo:cli-agent-showcase
```

演示完全离线，使用确定性 Job 和伪 Subagent，不需要模型密钥。脚本依次展示：

1. 生成 Plan 并停在 Awaiting Approval。
2. 批准后生成 Task Graph。
3. Scheduler 将 Command Task 交给后台 Job。
4. 首轮 Test 失败并创建有次数上限的 Repair Task。
5. Writer Subagent 完成 Repair，并返回结构化 Handoff。
6. 第二轮 Test 通过 Completion Gate。
7. 输出 Task、Verification、风险、资源用量和停止原因。
8. 从 Snapshot 与 Event Log 恢复终态 Workflow。
9. 创建第二个 Workflow 并演示取消。

预期最后一行：

```text
[showcase] PASS
```

固定评测：

```bash
npm run eval:cli-agent
```

CLI 集成回归：

```bash
cd packages/coding-agent
node ../../node_modules/vitest/dist/cli.js --run test/suite/workflow-direct.test.ts test/suite/workflow-plan.test.ts
```
