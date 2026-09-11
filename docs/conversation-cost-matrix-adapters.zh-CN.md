# 三任务成本比较：执行适配与离线验证

日期：2026-09-10。本轮付费模型调用为 0；三个业务仓库未修改。

后续状态：原配置已接通，价格已冻结，九组主比较及两组历史尝试已结束，见 [完整交付费用报告](conversation-cost-matrix-results.zh-CN.md)。以下是此前离线准备阶段的记录。

## 已完成

新增 `packages/coding-agent/evals/cost-matrix/` 任务适配入口，沿用 SDK、Plan 和 RPC 执行链路。三方案使用相同任务描述、业务目录权限、共同验收、sol 审查与最多一次 sol 修复。

| 任务 | 允许修改的业务目录 | 参考实现通过共同验收 |
| --- | --- | --- |
| JobFlow 四个入口 | frontend/app、frontend/components、frontend/lib | 8/8 浏览器场景 |
| Memory-RAG 组织权限 | src/memory_assistant、frontend/app、frontend/components、frontend/lib | 89/89 后端、2/2 浏览器流程 |
| 直播状态分页 | Tools/LiveCommentBridge | 65/65 后端、5/5 浏览器场景 |

以上目录内的测试、配置、依赖和锁文件仍禁止修改。允许读取工作区及约定依赖，禁止读取其他组、参考实现和工作区外历史答案。权限检查覆盖路径越界、符号链接、硬链接写入及任意 shell 命令；这是工具权限边界，不是操作系统沙箱。

宿主在一次性副本中执行共同验收，避免 Next 生成文件污染候选代码。服务器由宿主管理并关闭，页面预热发生在原测试计时前，未修改断言或放宽测试超时。测试和审查必须同时通过才能交付；基础设施失败不冒充业务失败，不消耗业务修复机会。

假模型验证包含实际工具拒绝越界访问，以及“失败 → 一次修复 → 复测 → 复审”。适配、Planner/Executor、审查资源释放及交付基线共 20 项定向测试通过；封存版本另外重跑适配测试，4/4 通过。

## 最终离线快照

路径：`.artifacts/conversation-cost-matrix-v4/framework`。

SHA-256：`55759a0d70810b8793cca2b34b9988c84bdcbb56841782ed549d035cfc3d8ac5`。

三个任务分别运行 `--offline-check` 成功，九份工作区的文件哈希检查通过，同一任务三组初始文件完全一致。六份原共同验收文件与 v2 哈希一致。

旧冻结程序误排除了所有 data 目录。新快照统一恢复原提交中的礼物价格表，并补入当前本地框架的模型目录静态 JSON；来源及逐文件哈希记入 matrix.json。v2 与启动失败的 v3 保留，不覆盖历史证据。外部已安装依赖仍共享，不声称环境完全自包含。

实际参考实现验收证据位于 `.artifacts/cost-matrix-adapter-preflight/` 下的 `jobflow-final`、`memory-final`、`live-catalog-restored`。早期失败目录保留，不混作最终结果。

## 当前限制与下一步

本地价格预检 `--preflight jobflow-followup-dialogs` 在任何模型请求前报 `Model/auth unavailable: sol`。因此价格协议尚未冻结，API 可用性尚未验证；不能称付费比较已经开始。下一步确认评测进程所用的模型与认证配置，记录三模型价格后，使用同一封存版本执行三方案。

完整费用包括规划、执行、切窗维护、审查、修复和失败尝试，并同时报告交付状态。只有达到共同交付门槛的结果才能用于“成功交付省钱”的结论。

Memory-RAG 本轮仅覆盖 SQLite、离线检索和浏览器 API fixture，不代表 PostgreSQL 或完整前后端集成通过。根及适配器 TypeScript 检查已通过；`npm run check` 仍被既有 `.artifacts/window-stage1-validation/biome.json` 嵌套根配置阻断，按用户要求不处理，不能记为全量检查通过。
