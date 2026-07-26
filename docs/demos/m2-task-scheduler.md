# M2 Task Scheduler 演示

## 目标

用固定 Task DAG 演示：

```text
两个无依赖只读 Task
  → 同一批次并行调度
  → 两者成功
  → 下游 Writer Task 进入 Ready
  → Writer 独占调度
```

## 运行

在仓库根目录执行：

```bash
npm run demo:task-scheduler
```

演示不访问网络、不读取 API Key，也不会修改仓库。

## 验收点

- DAG 依赖决定 Ready 状态。
- 两个只读 Task 在并发上限内同时被选择。
- Writer 在依赖未完成时不可调度。
- Writer 就绪后独占一个调度批次。
- 输出包含 Task Tree、并行 Task 和 Writer Task。
