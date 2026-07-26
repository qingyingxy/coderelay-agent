# M3 Runtime Guardrails 演示

## 目标

用固定数据演示 R7 的四条保障边界：

```text
权限交集拒绝写工具
预算达到 80% 警告、达到上限停止
两个独立 Registry 竞争同一工作区时只允许一个 Writer
取消 Workflow 时停止全部 Agent / Job 运行资源
```

## 运行

在仓库根目录执行：

```bash
npm run demo:runtime-guardrails
```

演示不访问网络、不读取 API Key，也不会修改仓库。跨进程租约数据使用系统临时目录，并在演示结束后删除。

## 验收点

- 输出允许的只读工具集合。
- 输出 Budget warning 和 exceeded。
- 第二个 Writer 被明确拒绝。
- Agent 与 Job 都收到级联停止请求。
- 最后一行是 `[demo] PASS`。
