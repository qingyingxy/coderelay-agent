# R16 真实模型评测

R16 将确定性的机制测试与真实模型效果评测分开。机制测试继续使用 Faux Provider；本目录只保存版本化真实任务集、固定仓库 Fixture 和成功标准。

## 固定对照矩阵

同一轮评测必须固定：

- Task Set 版本和 Fixture SHA-256。
- Provider、Model 和 Thinking Level。
- 任务 Prompt 版本。
- 成本、Turn、时长和 Agent 数量预算。
- 外部验证命令。

支持五种策略：

1. `single_agent`
2. `main_explorer`
3. `main_reviewer`
4. `planner_worker_reviewer`
5. `automatic`

策略协议要求的 Agent 没有真正创建时，Run 记为 `strategy_protocol` 失败，不能把普通单 Agent 完成误算为多 Agent 成功。

## 使用

只校验任务集和 Fixture 摘要，不调用模型：

```bash
npm run eval:cli-agent:model -- --verify-task-set
```

最小真实模型烟测：

```bash
npm run eval:cli-agent:model -- \
  --tasks slug-normalization \
  --strategies single_agent,main_explorer \
  --output .artifacts/r16-smoke
```

完整五策略、三任务矩阵：

```bash
npm run eval:cli-agent:model -- \
  --repetitions 3 \
  --output .artifacts/r16-full
```

与上一份 `automatic` 策略报告执行回归门禁：

```bash
npm run eval:cli-agent:model -- \
  --baseline .artifacts/r16-baseline/report.json \
  --output .artifacts/r16-candidate
```

Runner 使用当前 `/provider` 和 `/model` 选中的活动模型。报告同时生成 JSON 和 Markdown。

## 指标

- 最终任务成功率和必要验证通过率。
- Reviewer 固定缺陷发现率。
- Repair 成功率和次数。
- 无效委派率。
- Handoff 完整率。
- Token、费用、Turn、时长和 Agent 数量。
- 每个成功任务的成本。
- 相比 `single_agent` 的质量和成本边际变化。
- 自动决策 Reason Code 覆盖率。

Reviewer 指标使用固定缺陷关键词与结构化 Handoff 匹配，语义等价表述可能被低估，报告会明确保留该限制。

## 回归门禁

候选策略默认满足以下条件才能通过：

- 成功率下降不超过 5 个百分点。
- 验证通过率下降不超过 5 个百分点。
- 没有质量收益时，总成本不能扩大超过 1.5 倍。
- 自动决策解释覆盖率必须达到 100%。

不同 Task Set、Model、Prompt、Fixture 或预算的报告会被判定为不可比较。

## 当前边界

- 时长预算会主动终止等待；Token 和费用预算在 Run 完成后审计并判失败。
- `.artifacts` 中的模型结果属于运行产物，不作为固定源码提交。
- 单个烟测只能验证链路；策略质量结论必须来自完整任务矩阵和多次重复运行。
