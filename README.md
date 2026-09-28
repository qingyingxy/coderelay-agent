<p align="center">
  <img src="docs/images/pi-windows-agent-icon.png" alt="CodeRelay Agent 图标" width="176">
</p>

# CodeRelay Agent

基于 [Pi](https://github.com/earendil-works/pi) 的编程助手，优先适配 Windows，让任务在上下文切换后继续推进，并保留计划、执行、验证和修复记录。

> **项目状态：** Beta，主要在 Windows 11 和 PowerShell 下开发与测试。本项目基于 Pi 二次开发，底层框架与本项目新增能力的划分见文末。

CodeRelay Agent 关注的是：上下文切换后，仍能知道原来的计划、已经修改的内容、尚未通过的检查，以及下一步要做什么。

## 新增能力

| 能力 | 具体行为 |
|---|---|
| 跨上下文继续任务 | 可选的硬切窗模式在硬阈值自动切换；宿主保存 Workflow Snapshot，新窗口接收当前任务状态投影和近期 Notes 目录，缺失的旧证据再从 History 回查。 |
| 持久化工作流与恢复 | 管理计划、任务、执行尝试和验收结果，通过事件日志与快照支持恢复，保留失败与重试记录。 |
| 规划与执行分工 | Planner / Executor 将复杂工作拆成范围明确的任务，记录执行、验证和修复结果；可为规划、执行和审查配置不同档位的模型。 |

## 演示一：达到上下文阈值后继续任务

![读取大文件达到上下文阈值，自动切窗后继续完成配置读取](docs/images/coderelay-auto-context-demo.gif)

*15 秒，现有 CLI 界面的关键画面节选。使用 64k 演示窗口和大文件真实触发阈值，模型回复预设；不是自然长任务的速度基准。[静态画面](docs/images/coderelay-auto-context-demo.png)。*

实现配置读取时，读取参考资料使上下文达到阈值。运行时自动切窗，新窗口保留原始目标，读取已写入的代码后继续补全，最后三项 Node 测试一次通过。演示没有主动调用 `new_context`，测试失败也不是切窗条件。

## 演示二：双 Agent，一位规划、一位执行

![Planner 只读规划，批准后交给独立 Executor 会话修改代码并验收](docs/images/coderelay-planner-executor-demo.gif)

*12 秒，现有 CLI 交互界面的关键画面节选。模型回复预设，演示脚本自动输入审批与派发命令；计划校验、RPC 子进程、代码修改和三项 Node 验收真实执行。[静态画面](docs/images/coderelay-planner-executor-demo.png)。*

规划代理（Planner）先读取代码，给出修改范围和验收要求；批准后，执行代理（Executor）在独立会话中接手实现并返回结果。执行代理在内部称为 Worker / Subagent，是这两个角色中的执行方。本例展示到执行任务交付，不包含整个工作流的最终审查，也不衡量模型能力或费用收益。

## 运行离线演示

需要 Node.js **22.19 或更新版本**及 npm。在源码仓库根目录运行：

```powershell
npm install --ignore-scripts
npm run hydrate:model-data
npx tsx packages/coding-agent/examples/sdk/25-config-workflow-demo.ts --automatic
```

在终端界面中观看同一演示，同时查看实时工作流（Workflow）状态：

```powershell
npx tsx packages/coding-agent/examples/sdk/25-config-workflow-demo.ts --automatic --interactive
```

在 CLI 界面观看 Planner / Executor 演示（省略 `--interactive` 可运行 SDK 文本示例）：

```powershell
npx tsx packages/coding-agent/examples/sdk/26-planner-executor-demo.ts --interactive
```

两段演示均在临时目录运行，成功后输出 `[demo] PASS` 并清理退出。不需要 API Key、Docker 或模型权重；首次安装和初始化公开模型目录元数据需要联网，之后演示本身离线运行。GIF 添加了阶段说明并调整停留时间。

原有主动切窗、History 回查与失败修复演示仍保留。各演示的真实执行范围、命令和 GIF 生成方法见[演示说明](docs/cli-agent-showcase.md)。

## Windows 快速开始

完成上面的依赖安装和模型目录初始化后，启动交互式编程助手：

```powershell
.\pi-test.ps1
```

普通会话默认使用摘要模式。要启用自动硬切窗，运行 `.\pi-test.ps1 --context-mode windowed`。软阈值只提醒补存尚未持久化的重要信息；达到硬阈值后，宿主在工具调用结束的安全边界保存快照并自动切窗。普通硬切不额外调用摘要模型。

使用 `/auth` 配置模型服务凭据，通过 `/model` 选择模型。真实模型调用需要你自己的服务访问权限，并可能产生费用。使用 `/workflow` 查看任务状态，通过 `/plan` 创建需要审批的计划。详见[模型配置与使用文档](packages/coding-agent/README.md)和[工作流命令](docs/cli-agent-architecture.md#7-cli-与机器输出)。

## 源码入口

| 模块 | 入口 |
|---|---|
| 工作流状态、规划、调度与恢复 | [`packages/coding-agent/src/core/workflow`](packages/coding-agent/src/core/workflow) |
| 子代理、团队执行与约束 | [`packages/coding-agent/src/core/subagents`](packages/coding-agent/src/core/subagents) |
| 后台进程生命周期 | [`packages/coding-agent/src/core/jobs`](packages/coding-agent/src/core/jobs) |
| 差异、审查、验证与有次数限制的修复 | [`packages/coding-agent/src/core/delivery`](packages/coding-agent/src/core/delivery) |
| AgentSession 会话集成 | [`agent-session.ts`](packages/coding-agent/src/core/agent-session.ts) |
| 工作流快照投影与验证状态延续 | [`context-window-projection.ts`](packages/coding-agent/src/core/workflow/context-window-projection.ts) |
| 配置读取、测试与切窗演示 | [`25-config-workflow-demo.ts`](packages/coding-agent/examples/sdk/25-config-workflow-demo.ts) |
| Planner / Executor 交接演示 | [`26-planner-executor-demo.ts`](packages/coding-agent/examples/sdk/26-planner-executor-demo.ts) |
| CLI 工作流回归测试示例 | [`workflow-direct.test.ts`](packages/coding-agent/test/suite/workflow-direct.test.ts) |

## 技术文档与验证范围

- [架构说明](docs/cli-agent-architecture.md) · [演示说明](docs/cli-agent-showcase.md) · [编程助手文档](packages/coding-agent/README.md)
- [评测汇总](docs/evaluation-results.zh-CN.md)集中说明历史事实恢复、模型分工费用的结果、对照条件和原报告来源，并区分可运行的机制演示与未公开完整输入的历史实验。
- 演示验证执行与恢复机制，不衡量模型自主解决问题的能力或成本收益。GIF 调整了停留时间，不代表实际执行速度。
- 已有[产品回归测试](packages/coding-agent/docs/context-window-regressions.md)覆盖快照投影优先保留失败和未检查事项、避免过早引导收尾，以及切窗后的状态续作；这些测试使用 Faux Provider，不产生付费模型调用。
- 本地测试只验证覆盖的机制；工作流完成不代表未列入验收的需求已得到验证，也不能证明真实模型的任务完成率或成本优势。
- 调用真实模型的评测脚本用于开发验证，不是安装必需步骤，也不构成已发布的对比基准。

## 当前限制

- 当前通过源码使用，尚未提供签名的 Windows 安装包。
- 主要面向 Windows 11 和 PowerShell 开发与测试；保留上游的其他平台支持，但未作为本项目的重点验证范围。
- 本个人分支不使用上游的版本发布和包发布工作流。

## 开发与检查

```powershell
npm run check
Set-Location packages/coding-agent
node ../../node_modules/vitest/dist/cli.js --run test/suite/workflow-direct.test.ts
```

从 `packages/coding-agent` 目录运行切窗相关定向测试（Faux Provider，无付费模型调用）：

```powershell
node ../../node_modules/vitest/dist/cli.js --run test/suite/agent-session-context-window.test.ts test/workflow/context-window-projection.test.ts test/suite/context-window-completion-receipt.test.ts
```

## 安全说明

助手使用宿主进程的文件、进程、网络及凭据权限运行。处理不可信任务时，应使用专用工作树、容器或沙箱。详见[容器化指南](packages/coding-agent/docs/containerization.md)和[安全政策](SECURITY.md)。

## 上游与许可证

本项目派生自 [earendil-works/pi](https://github.com/earendil-works/pi)，保留 Pi 的模型服务抽象、代理执行循环（Agent Loop）、会话、扩展、终端界面、包结构和原始提交历史。上文介绍的工作流、任务编排、验证、恢复、模型路由及 Windows 使用体验相关改动由本项目扩展。

采用 [MIT 许可证](LICENSE)。上游文档见 [pi.dev](https://pi.dev/docs/latest)。
