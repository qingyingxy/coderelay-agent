# M4 交付闭环与恢复演示

## 目标

演示一条不访问模型和网络的确定性交付链路：

```text
Command Task
  → JobRuntime
  → Test Verification
  → Completion Gate
  → Snapshot
  → Workflow 恢复与最终报告
```

## 运行

在仓库根目录执行：

```bash
npm run demo:delivery-recovery
```

演示使用临时工作区和伪进程，不读取 API Key，不修改仓库。

## 验收点

- 实现 Command Task 和交付 Test 均成功。
- Workflow 只有在必要 Verification 通过后进入 `completed`。
- 新 Runtime 能从 Snapshot 与 Event Log 恢复终态和 Verification。
- 最后一行是 `[demo] PASS`。
