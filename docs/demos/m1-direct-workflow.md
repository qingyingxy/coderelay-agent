# M1 Direct Workflow 演示

## 目标

用固定 Faux Provider 重复演示一个低风险、单文件 Direct Workflow：

```text
用户请求
  → 创建 Workflow 与根 Task
  → Main Agent 调用 write
  → Main Agent 调用 edit
  → 基础 Verification
  → Workflow completed
  → /workflow 输出最终报告
```

演示不访问网络、不读取 API Key、不产生模型费用，并使用自动清理的临时目录。

## 运行

在仓库根目录执行：

```bash
npm run demo:direct-workflow
```

## 预期输出

输出应包含以下关键内容，ID、Token、费用和耗时可以不同：

```text
[request] Create src/greeting.ts, then change its greeting from hello to hello workflow.
[tool] write
[tool] edit
direct | completed | 1 task | 1 file | tests: not configured
Task: succeeded | Direct request
Attempts: 1
Changed files: 1
Code review: not configured
Tests: not configured
Build: not configured
[file] src/greeting.ts: export const greeting = "hello workflow";
[demo] PASS
```

## 验收点

- Workflow、Task 和 Attempt 均由正式 Controller/Event Log/Store 路径生成。
- `write` 和 `edit` 使用 Pi 内置工具，不使用测试替身工具。
- 同一文件的两次成功修改在报告中去重为一个 `changedFiles` 条目。
- 最终报告明确说明 Review、Test 和 Build 未配置，不虚构通过结果。
- `/workflow` 只展示权威状态，不向模型发送状态查询。
- 任一状态、修改文件或最终内容不符合预期时，脚本以非零状态退出。
