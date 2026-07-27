# M3 Subagent Runtime 演示

## 目标

用固定数据演示 R8 的核心链路：

```text
两个只读 Task
  → 两个独立 Subagent Session
  → 并行执行
  → 校验结构化 Handoff
  → 聚合结论与架构发现
  → 主流程读取 Agent 状态和资源使用
```

## 运行

在仓库根目录执行：

```bash
npm run demo:subagent-runtime
```

演示使用内存伪 Session，不访问网络、不读取 API Key，也不会修改仓库。

## 验收点

- 两个 Agent 拥有不同 Session ID。
- 两个 Agent 均完成并回到 `idle`。
- Handoff 只包含压缩结果，不复制消息历史。
- 重复架构发现被聚合去重。
- 最后一行是 `[demo] PASS`。
