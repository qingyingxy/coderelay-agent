# 实际入口核对与验收

本次停止扩展队列样例和付费对照，只核对并连接正式 CLI/TUI/RPC 入口。

## 链路边界

| 环节 | 实际状态 | 本次处理 |
| --- | --- | --- |
| 接任务 | 普通 CLI 已有；双 Agent 配置此前仅 SDK/脚本可用 | 新增 --planner-model、--executor-model、可重复的 --verify，复用 SDK 入口 |
| 规划 | 强模型只读规划已有 | 默认补齐 grep/find/ls，避免只读 Planner 无法发现文件 |
| 批准计划 | 用户控制点；TUI /approve 或 RPC decide_workflow_plan | 保留；--approve 仍仅表示项目信任 |
| 执行 | 批准后运行器自动调度 RPC Worker，固定计划与模型角色 | 复用，单资源并发，不手工调度 |
| 按需切窗 | Worker 自动启用持久化 windowed 会话，提供 new_context/notes/history 和固定任务契约 | 复用；是否切窗由上下文需要决定 |
| 验证 | 运行器执行固定验收命令，再向审查传递当前交付版本的实际证据 | 复用 |
| 有限修复 | 必须修复的失败可自动创建并调度 repair，随后重新验证；默认上限 1，原生 repair 使用强模型 | 复用；本次真实任务未触发，离线回归覆盖该分支 |
| 交付 | 验证通过后自动记录 completed 和 workflow_result | 已通过正式入口实测 |

仍需用户处理：计划批准/修订、范围歧义的确认、预算或修复耗尽后的下一步。
新双 Agent 入口不支持恢复已有会话；同一 Attempt 内切窗续接不等于跨进程崩溃恢复。
模型发现计划矛盾后的自动重规划协议也尚未接通，本次不扩展这些能力。

## 真实任务验收

- 任务：更新项目现有 docs/planner-executor.md，补充新 CLI 用法和审批/恢复边界。
- 在非 Git 临时工作目录放入该文档及实际源码参考，避免影响当前脏工作区。
- 启动正式 src/cli.ts --mode rpc，并使用本次新增参数；未使用 SDK 工作流替代入口。
- 强模型：qingyingxy/gpt-5.6-sol；快速 Worker：qingyingxy/gpt-5.6-luna。
- 核对实际计划后，按本次已授权任务范围提交一次批准；之后无手动 dispatch、verify 或 repair。
- 一个 Worker 只修改文档；命令任务与交付阶段分别执行 node verify.cjs，均退出 0；只读审查通过。
- 最终状态 completed，未完成项为空。已核对并将文档差异应用回项目，SDK 示例和历史报告保持原样。
- 本次没有故意制造失败或强制切窗，不据此声称真实长上下文切窗、自动修复或复杂编码能力已得到实测证明。
- 验收驱动脚本只负责传输请求、观察状态和提交已核对的批准；产品运行器负责后续链路。

本地证据：.artifacts/cli-entry-acceptance/plan.json、report.json、sessions/。
首次启动遇到沙箱配置锁权限；随后一次规划因验收客户端 60 秒等待超时中止。
调整客户端等待时间后，同一文档任务从新会话完成；未增加对照组。
Workflow 汇总费用并不包含全部规划/审查开销，本报告不把它当作总成本或节省结论。

## 检查

6 个针对性测试文件共 51 项通过；随后补充新会话命名兼容回归，相关 2 个文件 12 项通过。
覆盖参数校验、Planner 默认发现工具、审批、模型分工、真实 RPC 子进程切窗、审查和自动修复运行器。
修改文件 Biome 检查与全项目 TypeScript 检查通过。
完整 npm run check 被已有 .artifacts/window-stage1-validation/biome.json 嵌套根配置阻断，未修改该旧产物。
