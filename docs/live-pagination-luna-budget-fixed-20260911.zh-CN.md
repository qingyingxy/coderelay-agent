# 直播分页：sol＋luna 候选组补跑

## 结果

本次只补跑 sol＋luna，没有重跑 sol 直接组。候选组首轮共同测试及独立审查均通过，未使用修复额度。完整交付的累计模型费用为 **$0.79120292**，相较已有 sol 直接组的 **$1.7682824** 低 **55.3%**。

这是**跨框架版本的补充比较**，不是同版本重新配对评测，也不能据单次结果推断一般任务的平均节省率。费用按冻结模型价格和返回用量计算，并非供应商账单。

## 分阶段费用

| 阶段 | 模型与思考深度 | 请求数 | 费用（美元） |
| --- | --- | ---: | ---: |
| 规划 | sol xhigh | 6 | 0.47550160 |
| 执行 | luna max | 48 | 0.19253732 |
| 独立审查 | sol xhigh | 1 | 0.12316400 |
| 受限修复、复测后复审 | 未触发 | 0 | 0 |
| 合计 | | 55 | **0.79120292** |

本次没有未知用量请求，请求审计合计与最终报告一致。外部测试本身不产生模型调用费用；上表不包含本机计算、人工及框架开发成本。运行耗时约 27 分 38 秒；已有 sol 直接组约 15 分 49 秒，本次费用更低但耗时更长。

## 共同验收

- 后端分页：6/6 通过。
- 后端回归：59/59 通过。
- 浏览器场景：6/6 通过，包含新进入活动页加载免费资格队列。
- 补充回归：collector.start 的 running 状态变化可被 revision 增量轮询观察到；测试线程正常释放。
- 独立 sol 审查：passed，无必须修复项。
- 修复次数：0，上限仍为 1。
- 评测命令退出码：0；结束后未发现本次目录对应的 node/python 残留进程。

## 比较边界

两组使用相同旧代码基线、任务范围、共同测试、审查标准、价格及一次修复上限。业务源码范围和测试保护规则未改变。本次冻结后校验了框架文件哈希，未在运行中修改框架或人工修复业务代码。

本次框架相较已有对照的关键变化是移除 Planner 配置中残留的 240 秒、12 轮默认限制，并增加真实入口回归测试；仍保留显式调用方限制、30 分钟无进展及重复结果停止规则。该变化使 Planner 能正常交计划，但意味着两个结果不来自完全相同的框架版本。

当前冻结摘要：`52344a52fcb68313d598aa24afc9b74e14e56ccd9272aa2ab5b88b36f8d64e27`。

已有对照冻结摘要：`9e29d8d7033257acdbd9bd6b6fdf603744016cfb7d00502a6cb62f98182267d3`。

紧邻本次的上一轮候选失败尝试已知费用为 **$0.4147296**，另有一次取消请求用量未知。若将该次失败与本次成功补跑合计，已知支出为 **$1.20593252**，这是下限，不能视为精确完整费用；它也不是项目全部历史实验费用。该失败记录保留，不纳入本次单次成功运行的 $0.79120292。

## 证据

- [汇总与哈希校验结果](../.artifacts/live-pagination-luna-budget-fixed-20260911/summary.json)
- [冻结来源、基线哈希和对照路径](../.artifacts/live-pagination-luna-budget-fixed-20260911/provenance.json)
- [协议](../.artifacts/live-pagination-luna-budget-fixed-20260911/tasks/live-state-pagination/protocol.json)
- [最终报告](../.artifacts/live-pagination-luna-budget-fixed-20260911/tasks/live-state-pagination/luna/report.json)
- [逐请求费用](../.artifacts/live-pagination-luna-budget-fixed-20260911/tasks/live-state-pagination/luna/request-accounting.json)
- [独立审查](../.artifacts/live-pagination-luna-budget-fixed-20260911/tasks/live-state-pagination/luna/review-0.json)
- [共同验收](../.artifacts/live-pagination-luna-budget-fixed-20260911/tasks/live-state-pagination/luna/verification-1/results.json)
- [59 项回归日志](../.artifacts/live-pagination-luna-budget-fixed-20260911/tasks/live-state-pagination/luna/verification-1/live/regression.txt)
