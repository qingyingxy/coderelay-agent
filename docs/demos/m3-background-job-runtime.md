# M3 Background Job Runtime 演示

## 目标

演示不经过 LLM Agent Loop 的后台命令链路：

```text
Command Task
  → JobRuntime
  → 本地后台进程
  → stdout/stderr 增量日志
  → Job 终态与完成事件
```

## 运行

在仓库根目录执行：

```bash
npm run demo:job-runtime
```

演示不访问网络、不读取 API Key，也不会修改仓库。

## 验收点

- Job 状态为 `succeeded`，退出码为 0。
- stdout 和 stderr 分开显示。
- 事件序列包含 queued、started、output 和 completed。
- 最后一行是 `[demo] PASS`。
