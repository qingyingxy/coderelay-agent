# CLI Agent 简历证据

## 1. 目标岗位与证据映射

目标方向：AI Agent / LLM 应用开发，重点为 TypeScript CLI Agent。

| 岗位能力 | 仓库证据 | 支持强度 |
|---|---|---|
| Agent 工作流设计 | Workflow/Plan/Task/Attempt 状态机、Controller、Event Log | 强 |
| 多 Agent 协作 | Subagent Runtime、Profile、父子层级、结构化 Handoff | 强 |
| 工具与异步执行 | Pi Tool Calling 复用、后台 Job、增量日志、超时和取消 | 强 |
| 可靠性与安全 | 权限/预算交集、单 Writer Lease、级联取消、幂等和恢复 | 强 |
| 代码交付闭环 | Diff、只读 Review、Test/Build、Repair、Completion Gate | 强 |
| CLI 产品化 | TUI 状态、控制命令、Print/JSON/RPC Workflow View | 强 |
| 大规模线上效果 | 当前没有真实生产流量和线上指标 | 不支持，不写 |

## 2. 贡献边界

项目必须表述为“基于 Pi Fork 二次开发”。多模型 Provider、Agent Loop、基础 Tool Calling、AgentSession、会话能力和 TUI 来自 Pi；个人贡献是 Workflow 产品层、受控 Runtime、交付恢复闭环和 CLI 输出集成。

## 3. 简历可用版本

**项目：基于 Pi 的 CLI Coding Agent（二次开发）**

**角色：个人项目 / AI Agent 开发**

**技术栈：TypeScript、Node.js、Pi Agent Loop、Tool Calling、Event Sourcing、Vitest**

- 设计并实现 Workflow、Plan、Task、Attempt、Verification 分层状态模型，以 Event Log 作为事实来源，支持幂等更新、失败重试、取消和 Snapshot 恢复。
- 产品化 Plan 审批、Task Graph 与 Scheduler，接入独立 Subagent、结构化 Handoff 和后台 Job，实现串并行执行、依赖调度及 Agent/Job CLI 控制。
- 建立权限与预算继承、只读角色、跨进程单 Writer Lease、级联取消等运行保障，避免子 Agent 越权和同工作区并发写冲突。
- 打通 Diff、只读 Review、Test/Build、受限 Repair 与 Completion Gate，统一 TUI、Print、JSON、RPC 输出；16 个 CLI 专项集成用例和 6 个确定性评测用例通过。

## 4. 面试说明

演示入口是 `npm run demo:cli-agent-showcase`，可以按“为什么 Plan 和 Task 分离、为什么 Runtime 只上报事件、为什么采用单 Writer、如何保证取消与恢复一致性”四个问题讲解设计权衡。
