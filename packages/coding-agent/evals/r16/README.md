# R16 真实模型评测

R16 将确定性的机制测试与真实模型效果评测分开。机制测试继续使用 Faux Provider；本目录只保存版本化真实任务集、固定仓库 Fixture 和成功标准。

## 固定对照矩阵

同一轮评测必须固定：

- Task Set 版本和 Fixture SHA-256。
- Provider、Model 和 Thinking Level。
- 任务 Prompt 版本。
- 成本、Turn、时长和 Agent 数量预算。
- 外部验证命令。
- 受保护验证路径和运行配置指纹。

支持五种策略：

1. `single_agent`
2. `main_explorer`
3. `main_reviewer`
4. `planner_worker_reviewer`
5. `automatic`

Evaluation protocol v2 使用三态协议结果：`satisfied` 表示全部要求已满足；`not_reached_after_quality_failure` 表示外部验证已失败，因而没有到达后置 Reviewer 等角色；`violated` 表示协议状态缺失、已启动的协议 Run 失败或质量通过后仍缺少必需角色。只有 `violated` 记为 `strategy_protocol`，但成功 Run 必须为 `satisfied`，不能把普通单 Agent 完成误算为多 Agent 成功。

## 使用

校验任务集和 Fixture 摘要，并确认每个缺陷基线测试失败；不调用模型：

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
- 协议有效率，以及三态协议结果和具体未满足要求。
- 受保护验证资产完整率和实际使用模型。
- 路由准确率（已到达角色中正确路由的比例）和路由覆盖率（要求角色中实际到达的比例）。
- Reviewer 固定缺陷发现率。
- Repair 成功率和次数。
- 无效委派率。
- Handoff 完整率。
- Token、费用、Turn、时长和 Agent 数量。
- 每个成功任务的成本。
- 相比 `single_agent` 的质量和成本边际变化。
- 自动决策 Reason Code 覆盖率。

Reviewer 指标使用固定缺陷关键词与结构化 Handoff 匹配，语义等价表述可能被低估，报告会明确保留该限制。

Task Set `1.3.0` 使用 Evaluation schema v3 和 Evaluation protocol `model-routing-v3`。Prompt、Workflow 与外部验证共享单个 Run 时长截止时间。旧 schema、旧协议报告与检查点会被拒绝，不能通过 `--resume` 混入新结果；正式评测必须使用新输出目录从零开始。

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
