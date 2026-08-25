<p align="center">
  <a href="https://pi.dev">
    <img alt="pi logo" src="https://pi.dev/logo-auto.svg" width="128">
  </a>
</p>
<p align="center">
  <a href="https://discord.com/invite/3cU7Bz4UPx"><img alt="Discord" src="https://img.shields.io/badge/discord-community-5865F2?style=flat-square&logo=discord&logoColor=white" /></a>
  <a href="https://www.npmjs.com/package/@earendil-works/pi-coding-agent"><img alt="npm" src="https://img.shields.io/npm/v/@earendil-works/pi-coding-agent?style=flat-square" /></a>
</p>

> 来自新贡献者的新 issue 和 PR 默认会被自动关闭。维护者每天会审查这些自动关闭的 issue。参见 [CONTRIBUTING.md](../../CONTRIBUTING.md)。

---

Pi 是一个极简的终端 coding harness。你可以让 pi 适应你的工作流，而不是反过来为了适应 pi 去 fork 并修改 pi 内部。你可以用 TypeScript [扩展](#extensions)、[技能](#skills)、[提示模板](#prompt-templates) 和 [主题](#themes) 扩展它。也可以把扩展、技能、提示模板和主题放进 [Pi 包](#pi-packages)，再通过 npm 或 git 分享给其他人。

Pi 自带强大的默认能力，但不会内置 sub-agent、plan mode 这类功能。你可以让 pi 为你构建想要的能力，或者安装符合你工作流的第三方 pi 包。

Pi 有四种运行方式：交互模式、print/JSON 模式、用于进程集成的 RPC 模式，以及可嵌入你自己应用的 SDK。真实 SDK 集成案例可参考 [openclaw/openclaw](https://github.com/openclaw/openclaw)。

<a id="share-your-oss-coding-agent-sessions"></a>
## 分享你的开源 coding agent 会话

如果你用 pi 做开源工作，请分享你的 coding agent 会话。

公开的开源会话数据可以帮助基于真实开发工作流改进模型、提示、工具和评测。

完整解释见 [这篇 X 帖子](https://x.com/badlogicgames/status/2037811643774652911)。

发布会话可使用 [`badlogic/pi-share-hf`](https://github.com/badlogic/pi-share-hf)。阅读它的 README.md 完成配置。你只需要一个 Hugging Face 账号、Hugging Face CLI 和 `pi-share-hf`。

你也可以观看 [这个视频](https://x.com/badlogicgames/status/2041151967695634619)，作者展示了如何发布自己的 `pi-mono` 会话。

作者会定期在这里发布自己的 `pi-mono` 工作会话：

- [badlogicgames/pi-mono on Hugging Face](https://huggingface.co/datasets/badlogicgames/pi-mono)

<a id="table-of-contents"></a>
## 目录

- [快速开始](#quick-start)
- [Provider 与模型](#providers--models)
- [交互模式](#interactive-mode)
  - [编辑器](#editor)
  - [命令](#commands)
  - [键盘快捷键](#keyboard-shortcuts)
  - [消息队列](#message-queue)
- [会话](#sessions)
  - [分支](#branching)
  - [压缩](#compaction)
- [设置](#settings)
- [上下文文件](#context-files)
- [自定义](#customization)
  - [提示模板](#prompt-templates)
  - [技能](#skills)
  - [扩展](#extensions)
  - [主题](#themes)
  - [Pi 包](#pi-packages)
- [程序化使用](#programmatic-usage)
- [设计理念](#philosophy)
- [CLI 参考](#cli-reference)

---

<a id="quick-start"></a>
## 快速开始

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
```

`--ignore-scripts` 会在安装期间禁用依赖生命周期脚本。Pi 的普通 npm 安装不需要运行安装脚本。

也可以使用安装脚本：

```bash
curl -fsSL https://pi.dev/install.sh | sh
```

用 API key 认证：

```bash
export ANTHROPIC_API_KEY=sk-ant-...
pi
```

或者使用你已有的订阅：

```bash
pi
/login  # 然后选择 provider
```

之后直接和 pi 对话即可。默认情况下，pi 会给模型四个工具：`read`、`write`、`edit` 和 `bash`。模型会用这些工具完成你的请求。你也可以通过 [skills](#skills)、[prompt templates](#prompt-templates)、[extensions](#extensions) 或 [pi packages](#pi-packages) 添加能力。

**平台说明：** [Windows](docs/windows.md) | [Termux (Android)](docs/termux.md) | [tmux](docs/tmux.md) | [终端设置](docs/terminal-setup.md) | [Shell aliases](docs/shell-aliases.md)

---

<a id="providers--models"></a>
## Provider 与模型

对每个内置 provider，pi 都维护了一份支持工具调用的模型列表，并在每次发布时更新。你可以通过订阅登录（`/login`）或 API key 完成认证，然后用 `/model`（或 Ctrl+L）选择该 provider 下的任意模型。

**订阅：**
- Anthropic Claude Pro/Max
- OpenAI ChatGPT Plus/Pro (Codex)
- GitHub Copilot

**API keys：**
- Anthropic
- Ant Ling
- OpenAI
- Azure OpenAI
- DeepSeek
- NVIDIA NIM
- Google Gemini
- Google Vertex
- Amazon Bedrock
- Mistral
- Groq
- Cerebras
- Cloudflare AI Gateway
- Cloudflare Workers AI
- xAI
- OpenRouter
- Vercel AI Gateway
- ZAI Coding Plan (Global)
- ZAI Coding Plan (China)
- OpenCode Zen
- OpenCode Go
- Hugging Face
- Fireworks
- Together AI
- Kimi For Coding
- MiniMax
- Xiaomi MiMo
- Xiaomi MiMo Token Plan (China)
- Xiaomi MiMo Token Plan (Amsterdam)
- Xiaomi MiMo Token Plan (Singapore)

详细配置说明见 [docs/providers.md](docs/providers.md)。

**自定义 provider 与模型：** 如果 provider 使用受支持的 API（OpenAI、Anthropic、Google），可以通过 `~/.pi/agent/models.json` 添加。自定义 API 或 OAuth 请使用扩展。参见 [docs/models.md](docs/models.md) 和 [docs/custom-provider.md](docs/custom-provider.md)。

---

<a id="interactive-mode"></a>
## 交互模式

<p align="center"><img src="docs/images/interactive-mode.png" alt="Interactive Mode" width="600"></p>

界面从上到下依次是：

- **启动头部** - 显示快捷键（`/hotkeys` 查看全部）、已加载的 AGENTS.md 文件、提示模板、技能和扩展
- **消息区** - 你的消息、assistant 回复、工具调用和结果、通知、错误以及扩展 UI
- **编辑器** - 你输入内容的位置；边框颜色表示 thinking level
- **底部状态栏** - 工作目录、会话名称、总 token/cache 用量（`↑` 输入、`↓` 输出、`R` cache read、`W` cache write、`CH` 最近 cache 命中率）、成本、上下文用量和当前模型

编辑器可以临时被其他 UI 替换，例如内置 `/settings`，或扩展提供的自定义 UI（例如让用户用结构化方式回答模型问题的 Q&A 工具）。[扩展](#extensions) 还可以替换编辑器，在编辑器上方/下方添加 widget、状态行、自定义 footer 或 overlay。

<a id="editor"></a>
### 编辑器

| 功能 | 使用方式 |
|---------|-----|
| 文件引用 | 输入 `@` 模糊搜索项目文件 |
| 路径补全 | Tab 补全路径 |
| 多行输入 | Shift+Enter（Windows Terminal 上也可用 Ctrl+Enter） |
| 外部编辑器 | Ctrl+G 打开 `externalEditor`、`$VISUAL`、`$EDITOR`，Windows 上默认 Notepad，其他平台默认 `nano` |
| 图片 | Ctrl+V 粘贴（Windows 上 Alt+V），或拖拽到终端 |
| Bash 命令 | `!command` 运行并把输出发送给 LLM，`!!command` 运行但不发送输出 |

删除单词、撤销等标准编辑快捷键见 [docs/keybindings.md](docs/keybindings.md)。

<a id="commands"></a>
### 命令

在编辑器中输入 `/` 触发命令。[扩展](#extensions) 可以注册自定义命令，[技能](#skills) 可通过 `/skill:name` 使用，[提示模板](#prompt-templates) 可通过 `/templatename` 展开。

| 命令 | 说明 |
|---------|-------------|
| `/login`, `/logout` | OAuth 认证 |
| `/model` | 切换模型 |
| `/scoped-models` | 启用/禁用 Ctrl+P 循环模型列表 |
| `/settings` | Thinking level、主题、消息投递方式、transport |
| `/resume` | 从历史会话中选择 |
| `/new` | 开始新会话 |
| `/name <name>` | 设置会话显示名称 |
| `/session` | 显示会话信息（文件、ID、消息、tokens、成本） |
| `/tree` | 跳转到会话中的任意位置并从那里继续 |
| `/trust` | 保存项目 trust 决策，供未来会话使用（需要重启生效） |
| `/fork` | 从之前的用户消息创建新会话 |
| `/clone` | 将当前活跃分支复制到一个新会话 |
| `/compact [prompt]` | 手动压缩上下文，可附带自定义指令 |
| `/copy` | 复制上一条 assistant 消息到剪贴板 |
| `/export [file]` | 导出会话为 HTML 或 JSONL 文件 |
| `/import <file>` | 从 JSONL 文件导入并恢复会话 |
| `/share` | 上传为 private GitHub gist，并生成可分享的 HTML 链接 |
| `/reload` | 重新加载 keybindings、extensions、skills、prompts 和 context files（themes 会自动热重载） |
| `/hotkeys` | 显示所有键盘快捷键 |
| `/changelog` | 显示版本历史 |
| `/quit` | 退出 pi |

<a id="keyboard-shortcuts"></a>
### 键盘快捷键

完整列表见 `/hotkeys`。可通过 `~/.pi/agent/keybindings.json` 自定义。参见 [docs/keybindings.md](docs/keybindings.md)。

**常用快捷键：**

| 按键 | 动作 |
|-----|--------|
| Ctrl+C | 清空编辑器 |
| Ctrl+C 两次 | 退出 |
| Escape | 取消/中止 |
| Escape 两次 | 打开 `/tree` |
| Ctrl+L | 打开模型选择器 |
| Ctrl+P / Shift+Ctrl+P | 正向/反向循环 scoped models |
| Shift+Tab | 循环 thinking level |
| Ctrl+O | 折叠/展开工具输出 |
| Ctrl+T | 折叠/展开 thinking blocks |

<a id="message-queue"></a>
### 消息队列

当 agent 正在工作时也可以提交消息：

- **Enter** 会排入一条 *steering* 消息，在当前 assistant turn 完成工具调用后投递
- **Alt+Enter** 会排入一条 *follow-up* 消息，只在 agent 完成所有工作后投递
- **Escape** 中止并把已排队消息恢复到编辑器
- **Alt+Up** 把排队消息取回编辑器

在 Windows Terminal 中，`Alt+Enter` 默认是全屏快捷键。请按 [docs/terminal-setup.md](docs/terminal-setup.md) 重映射，让 pi 能接收到 follow-up 快捷键。

可在 [settings](docs/settings.md) 中配置投递方式：`steeringMode` 和 `followUpMode` 可设为 `"one-at-a-time"`（默认，等待回复）或 `"all"`（一次性投递所有排队消息）。`transport` 可为支持多 transport 的 provider 选择偏好：`"sse"`、`"websocket"` 或 `"auto"`。

---

<a id="sessions"></a>
## 会话

会话存储为带树结构的 JSONL 文件。每个 entry 都有 `id` 和 `parentId`，因此可以在不创建新文件的情况下原地分支。文件格式见 [docs/session-format.md](docs/session-format.md)。

<a id="management"></a>
### 管理

会话自动保存到 `~/.pi/agent/sessions/`，并按工作目录组织。

```bash
pi -c                  # 继续最近的会话
pi -r                  # 浏览并选择历史会话
pi --no-session        # 临时模式，不保存
pi --name "my task"    # 启动时设置会话显示名称
pi --session <path|id> # 使用指定会话文件或 ID
pi --fork <path|id>    # 将指定会话文件或 ID fork 成新会话
```

在交互模式中使用 `/session` 查看当前会话 ID，然后可用 `--session <id>` 或 `--fork <id>` 复用。

<a id="branching"></a>
### 分支

**`/tree`** - 在当前会话文件中导航会话树。选择任意历史位置，从那里继续，并在不同分支之间切换。所有历史都会保存在同一个文件中。

<p align="center"><img src="docs/images/tree-view.png" alt="Tree View" width="600"></p>

- 输入即可搜索；用 Ctrl+←/Ctrl+→ 或 Alt+←/Alt+→ 折叠/展开并在分支间跳转；用 ←/→ 翻页
- 过滤模式（Ctrl+O）：default → no-tools → user-only → labeled-only → all
- Shift+L 给 entry 加书签标签，Shift+T 切换标签时间戳显示

**`/fork`** - 从活跃分支上的某条历史用户消息创建新会话文件。它会打开选择器，复制到该点为止的活跃路径，并把选中的 prompt 放到编辑器中供修改。

**`/clone`** - 在当前位置把当前活跃分支复制到新会话文件。新会话保留完整活跃路径历史，并以空编辑器打开。

**`--fork <path|id>`** - 直接从 CLI fork 一个已有会话文件或部分会话 UUID。它会把完整源会话复制到当前项目中的新会话文件。

<a id="compaction"></a>
### 压缩

长会话可能耗尽上下文窗口。压缩会总结旧消息，同时保留最近消息。

**手动：** `/compact` 或 `/compact <custom instructions>`

**自动：** 默认启用。在上下文溢出时触发（恢复并重试），或在接近限制时主动触发。可通过 `/settings` 或 `settings.json` 配置。

压缩是有损的。完整历史仍保留在 JSONL 文件中；可用 `/tree` 回看。压缩行为可通过 [扩展](#extensions) 自定义。内部机制见 [docs/compaction.md](docs/compaction.md)。

---

<a id="settings"></a>
## 设置

使用 `/settings` 修改常用选项，或直接编辑 JSON 文件：

| 位置 | 作用域 |
|----------|-------|
| `~/.pi/agent/settings.json` | 全局（所有项目） |
| `.pi/settings.json` | 项目级（覆盖全局） |

所有选项见 [docs/settings.md](docs/settings.md)。

<a id="project-trust"></a>
### Project Trust

交互模式启动时，如果项目文件夹包含项目本地 settings、resources 或项目 `.agents/skills`，且该文件夹或其父级在 `~/.pi/agent/trust.json` 中没有保存过决策，pi 会先询问是否信任该项目。信任项目后，pi 才会加载 `.pi/settings.json` 和 `.pi` 资源，安装缺失的项目包，并执行项目扩展。

在 trust 决策之前，pi 只加载 context files、用户/全局 extensions 和 CLI `-e` extensions，以便它们处理 `project_trust` 事件。项目本地 extensions、项目包管理的 extensions 和项目 settings 只有在项目被信任后才加载。切换到另一个 cwd 的会话且当前进程还没解析该 cwd 的 trust 时，也遵循同样的分离。

非交互模式（`-p`、`--mode json` 和 `--mode rpc`）不会显示 trust prompt。如果没有适用的已保存 trust 决策，它们会使用全局 settings 中的 `defaultProjectTrust`：`ask`（默认）和 `never` 会忽略这些项目资源，`always` 会信任它们。可用 `--approve`/`-a` 或 `--no-approve`/`-na` 为单次运行覆盖项目 trust。

如果没有 extension 或已保存决策适用，`defaultProjectTrust` 决定 fallback 行为。可在 `~/.pi/agent/settings.json` 中设为 `"ask"`、`"always"` 或 `"never"`，也可通过 `/settings` 修改。

`pi config` 和包命令使用同一套项目 trust 流程，但 `pi update` 永远不会提示。对单个命令可传 `--approve` 信任项目本地 settings，或传 `--no-approve` 忽略它们。

在交互模式中使用 `/trust` 可为未来会话保存项目 trust 决策，也可包含对直接父目录的 trust。它只写入 `~/.pi/agent/trust.json`；当前会话不会重新加载，所以需要重启 pi 才会生效。

<a id="telemetry-and-update-checks"></a>
### Telemetry 和更新检查

Pi 启动时有两个独立功能：

- **更新检查：** 请求 `https://pi.dev/api/latest-version` 检查是否有新版本。设置 `PI_SKIP_VERSION_CHECK=1` 可禁用。禁用更新检查只影响这个检查。
- **安装/更新 telemetry：** 首次安装后或 changelog 检测到更新后，会向 `https://pi.dev/api/report-install` 发送匿名版本 ping。该设置也控制 OpenRouter、Cloudflare 和直接 NVIDIA NIM 请求中的可选 provider attribution headers。可在 `settings.json` 中将 `enableInstallTelemetry` 设为 `false`，或设置 `PI_TELEMETRY=0` 退出。它不会禁用更新检查；除非禁用更新检查或启用 offline mode，Pi 仍可能联系 `pi.dev` 获取最新版本。

使用 `--offline` 或 `PI_OFFLINE=1` 可禁用这里描述的所有启动网络操作，包括更新检查、包更新检查和安装/更新 telemetry。

---

<a id="context-files"></a>
## 上下文文件

Pi 启动时会从以下位置加载 `AGENTS.md`（或 `CLAUDE.md`）：
- `~/.pi/agent/AGENTS.md`（全局）
- 父目录（从 cwd 向上遍历）
- 当前目录

这些文件用于项目指令（`AGENTS.md`/`CLAUDE.md`）、约定和常用命令。所有匹配文件会被拼接。

可用 `--no-context-files`（或 `-nc`）禁用 context file 加载。

<a id="system-prompt"></a>
### System Prompt

可用 `.pi/SYSTEM.md`（项目）或 `~/.pi/agent/SYSTEM.md`（全局）替换默认 system prompt。若只想追加而不是替换，可使用 `APPEND_SYSTEM.md`。

---

<a id="customization"></a>
## 自定义

<a id="prompt-templates"></a>
### 提示模板

提示模板是可复用的 Markdown 文件。输入 `/name` 展开。

```markdown
<!-- ~/.pi/agent/prompts/review.md -->
Review this code for bugs, security issues, and performance problems.
Focus on: {{focus}}
```

把模板放到 `~/.pi/agent/prompts/`、`.pi/prompts/` 或 [pi package](#pi-packages) 中即可分享。参见 [docs/prompt-templates.md](docs/prompt-templates.md)。

<a id="skills"></a>
### 技能

技能是遵循 [Agent Skills standard](https://agentskills.io) 的按需能力包。可以通过 `/skill:name` 调用，也可以让 agent 自动加载。

```markdown
<!-- ~/.pi/agent/skills/my-skill/SKILL.md -->
# My Skill
Use this skill when the user asks about X.

## Steps
1. Do this
2. Then that
```

可放在 `~/.pi/agent/skills/`、`~/.agents/skills/`、`.pi/skills/`、`.agents/skills/`（从 `cwd` 向上遍历父目录），或放入 [pi package](#pi-packages) 分享。参见 [docs/skills.md](docs/skills.md)。

<a id="extensions"></a>
### 扩展

<p align="center"><img src="docs/images/doom-extension.png" alt="Doom Extension" width="600"></p>

扩展是 TypeScript 模块，可为 pi 添加自定义工具、命令、键盘快捷键、事件处理器和 UI 组件。

```typescript
export default function (pi: ExtensionAPI) {
  pi.registerTool({ name: "deploy", ... });
  pi.registerCommand("stats", { ... });
  pi.on("tool_call", async (event, ctx) => { ... });
}
```

默认导出也可以是 `async`。pi 会等待异步 extension factory 完成后再继续启动，这适合做一次性初始化，例如获取远程模型列表后再调用 `pi.registerProvider()`。

**可以做什么：**
- 自定义工具（或完全替换内置工具）
- Sub-agents 和 plan mode
- 自定义压缩和总结
- 权限 gate 和路径保护
- 自定义编辑器和 UI 组件
- 状态行、header、footer
- Git checkpoint 和自动提交
- SSH 和沙箱执行
- MCP server 集成
- 让 pi 看起来像 Claude Code
- 等待时玩游戏（是的，Doom 能跑）
- 以及其他你能想到的能力

放到 `~/.pi/agent/extensions/`、`.pi/extensions/` 或 [pi package](#pi-packages) 中即可分享。参见 [docs/extensions.md](docs/extensions.md) 和 [examples/extensions/](examples/extensions/)。

<a id="themes"></a>
### 主题

内置主题：`dark`、`light`。主题支持热重载：修改当前主题文件后，pi 会立即应用。

主题可放在 `~/.pi/agent/themes/`、`.pi/themes/` 或 [pi package](#pi-packages) 中分享。参见 [docs/themes.md](docs/themes.md)。

<a id="pi-packages"></a>
### Pi 包

可以通过 npm 或 git 打包并分享 extensions、skills、prompts 和 themes。可在 [npmjs.com](https://www.npmjs.com/search?q=keywords%3Api-package) 或 [Discord](https://discord.com/channels/1456806362351669492/1457744485428629628) 查找包。

> **安全：** Pi 包拥有完整系统访问权限。Extensions 会执行任意代码，skills 可以指示模型执行任何动作，包括运行可执行文件。安装第三方包前请审查源码。

```bash
pi install npm:@foo/pi-tools
pi install npm:@foo/pi-tools@1.2.3      # pinned version
pi install git:github.com/user/repo
pi install git:github.com/user/repo@v1  # tag or commit
pi install git:git@github.com:user/repo
pi install git:git@github.com:user/repo@v1  # tag or commit
pi install https://github.com/user/repo
pi install https://github.com/user/repo@v1      # tag or commit
pi install ssh://git@github.com/user/repo
pi install ssh://git@github.com/user/repo@v1    # tag or commit
pi remove npm:@foo/pi-tools
pi uninstall npm:@foo/pi-tools          # alias for remove
pi list
pi update                               # update pi only
pi update --all                         # update pi and packages
pi update --extensions                  # update packages only
pi update --self                        # update pi only
pi update --self --force                # reinstall pi even if current
pi update npm:@foo/pi-tools             # update one package
pi config                               # enable/disable extensions, skills, prompts, themes
```

包会安装到 `~/.pi/agent/git/`（git）或 `~/.pi/agent/npm/`（npm）。使用 `-l` 可进行项目本地安装（`.pi/git/`、`.pi/npm/`）。Git `@ref` 值会固定到 tag 或 commit；固定版本的包会被 `pi update --extensions` 和 `pi update --all` 跳过，因此如果要把已有包移动到新 ref，请使用 `pi install git:host/user/repo@new-ref`。Git 包默认用 `npm install --omit=dev` 安装依赖，因此运行时依赖必须列在 `dependencies` 下；配置了 `npmCommand` 时，git 包会使用普通 `install` 以兼容 wrapper。如果你使用 Node 版本管理器并希望包安装复用稳定的 npm 上下文，可在 `settings.json` 中设置 `npmCommand`，例如 `["mise", "exec", "node@20", "--", "npm"]`。

创建包时，在 `package.json` 中添加 `pi` key：

```json
{
  "name": "my-pi-package",
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./extensions"],
    "skills": ["./skills"],
    "prompts": ["./prompts"],
    "themes": ["./themes"]
  }
}
```

如果没有 `pi` manifest，pi 会从约定目录自动发现：`extensions/`、`skills/`、`prompts/`、`themes/`。

参见 [docs/packages.md](docs/packages.md)。

---

<a id="programmatic-usage"></a>
## 程序化使用

<a id="sdk"></a>
### SDK

```typescript
import { AuthStorage, createAgentSession, ModelRegistry, SessionManager } from "@earendil-works/pi-coding-agent";

const authStorage = AuthStorage.create();
const modelRegistry = ModelRegistry.create(authStorage);
const { session } = await createAgentSession({
  sessionManager: SessionManager.inMemory(),
  authStorage,
  modelRegistry,
});

await session.prompt("What files are in the current directory?");
```

高级多会话 runtime replacement 可使用 `createAgentSessionRuntime()` 和 `AgentSessionRuntime`。

参见 [docs/sdk.md](docs/sdk.md) 和 [examples/sdk/](examples/sdk/)。

<a id="rpc-mode"></a>
### RPC 模式

对非 Node.js 集成，可通过 stdin/stdout 使用 RPC 模式：

```bash
pi --mode rpc
```

RPC 模式使用严格的 LF 分隔 JSONL framing。客户端必须只按 `\n` 分割记录。不要使用 Node `readline` 这类通用 line reader，因为它们也会按 JSON payload 内的 Unicode separators 分割。

协议见 [docs/rpc.md](docs/rpc.md)。

---

<a id="philosophy"></a>
## 设计理念

Pi 极度重视可扩展性，因此它不需要规定你的工作流。其他工具内置的功能，可以用 [extensions](#extensions)、[skills](#skills) 构建，或从第三方 [pi packages](#pi-packages) 安装。这让核心保持最小，同时允许你把 pi 塑造成适合自己工作的样子。

**不内置 MCP。** 构建带 README 的 CLI 工具（见 [Skills](#skills)），或构建添加 MCP 支持的扩展。[为什么？](https://mariozechner.at/posts/2025-11-02-what-if-you-dont-need-mcp/)

**不内置 sub-agent。** 实现方式有很多。可以用 tmux 启动多个 pi 实例，也可以通过 [extensions](#extensions) 自己构建，或安装符合你方式的包。

**不内置权限弹窗。** 可以在容器中运行，或通过 [extensions](#extensions) 构建符合你环境和安全要求的确认流程。

**不内置 plan mode。** 把计划写入文件，或通过 [extensions](#extensions) 构建，或安装包。

**不内置 to-do。** 它们会让模型困惑。请使用 TODO.md 文件，或通过 [extensions](#extensions) 自己构建。

**不内置后台 bash。** 使用 tmux。它具有完整可观察性，并可直接交互。

完整理由见 [这篇博客](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/)。

---

<a id="cli-reference"></a>
## CLI 参考

```bash
pi [options] [@files...] [messages...]
```

<a id="package-commands"></a>
### 包命令

```bash
pi install <source> [-l]     # 安装包，-l 表示项目本地安装
pi remove <source> [-l]      # 移除包
pi uninstall <source> [-l]   # remove 的别名
pi update [source|self|pi]   # 只更新 pi，或更新一个包 source
pi update --all              # 更新 pi 和 packages
pi update --extensions       # 只更新 packages
pi update --self             # 只更新 pi
pi update --self --force     # 即使当前已是最新也重新安装 pi
pi update --extension <src>  # 更新一个包
pi list                      # 列出已安装包
pi config                    # 启用/禁用包资源
```

`pi config` 和项目包命令接受 `--approve`/`--no-approve`，用于对单个命令信任或忽略项目本地 settings。`pi update` 永远不会提示 project trust。

<a id="modes"></a>
### 模式

| Flag | 说明 |
|------|-------------|
| 默认 | 交互模式 |
| `-p`, `--print` | 打印响应后退出 |
| `--mode json` | 以 JSON lines 输出所有事件（见 [docs/json.md](docs/json.md)） |
| `--mode rpc` | 用于进程集成的 RPC 模式（见 [docs/rpc.md](docs/rpc.md)） |
| `--export <in> [out]` | 将会话导出为 HTML |

在 print 模式中，pi 也会读取 piped stdin，并合并到初始 prompt：

```bash
cat README.md | pi -p "Summarize this text"
```

<a id="model-options"></a>
### 模型选项

| 选项 | 说明 |
|--------|-------------|
| `--provider <name>` | Provider（anthropic、openai、google 等） |
| `--model <pattern>` | 模型 pattern 或 ID（支持 `provider/id` 和可选 `:<thinking>`） |
| `--api-key <key>` | API key（覆盖环境变量） |
| `--thinking <level>` | `off`、`minimal`、`low`、`medium`、`high`、`xhigh` |
| `--models <patterns>` | 用于 Ctrl+P 循环的逗号分隔 patterns |
| `--list-models [search]` | 列出可用模型 |

<a id="session-options"></a>
### 会话选项

| 选项 | 说明 |
|--------|-------------|
| `-c`, `--continue` | 继续最近会话 |
| `-r`, `--resume` | 浏览并选择会话 |
| `--session <path\|id>` | 使用指定会话文件或部分 UUID |
| `--fork <path\|id>` | 将指定会话文件或部分 UUID fork 成新会话 |
| `--session-dir <dir>` | 自定义会话存储目录 |
| `--no-session` | 临时模式，不保存 |
| `--name <name>`, `-n <name>` | 启动时设置会话显示名称 |

<a id="tool-options"></a>
### 工具选项

| 选项 | 说明 |
|--------|-------------|
| `--tools <list>`, `-t <list>` | 对内置、扩展和自定义工具按名称设置 allowlist |
| `--exclude-tools <list>`, `-xt <list>` | 对内置、扩展和自定义工具按名称禁用 |
| `--no-builtin-tools`, `-nbt` | 默认禁用内置工具，但保留 extension/custom tools |
| `--no-tools`, `-nt` | 默认禁用所有工具 |

可用内置工具：`read`、`bash`、`edit`、`write`、`grep`、`find`、`ls`

<a id="resource-options"></a>
### 资源选项

| 选项 | 说明 |
|--------|-------------|
| `-e`, `--extension <source>` | 从 path、npm 或 git 加载 extension（可重复） |
| `--no-extensions` | 禁用 extension discovery |
| `--skill <path>` | 加载 skill（可重复） |
| `--no-skills` | 禁用 skill discovery |
| `--prompt-template <path>` | 加载 prompt template（可重复） |
| `--no-prompt-templates` | 禁用 prompt template discovery |
| `--theme <path>` | 加载 theme（可重复） |
| `--no-themes` | 禁用 theme discovery |
| `--no-context-files`, `-nc` | 禁用 AGENTS.md 和 CLAUDE.md context file discovery |

把 `--no-*` 和显式 flags 组合，可精确加载你需要的内容并忽略 settings.json，例如 `--no-extensions -e ./my-ext.ts`。

<a id="other-options"></a>
### 其他选项

| 选项 | 说明 |
|--------|-------------|
| `--system-prompt <text>` | 替换默认 prompt（context files 和 skills 仍会追加） |
| `--append-system-prompt <text>` | 追加到 system prompt |
| `--verbose` | 强制显示详细启动信息 |
| `-a`, `--approve` | 本次运行信任项目本地文件 |
| `-na`, `--no-approve` | 本次运行忽略项目本地文件 |
| `-h`, `--help` | 显示帮助 |
| `-v`, `--version` | 显示版本 |

<a id="file-arguments"></a>
### 文件参数

用 `@` 前缀把文件包含到消息中：

```bash
pi @prompt.md "Answer this"
pi -p @screenshot.png "What's in this image?"
pi @code.ts @test.ts "Review these files"
```

<a id="examples"></a>
### 示例

```bash
# 带初始 prompt 的交互模式
pi "List all .ts files in src/"

# 非交互
pi -p "Summarize this codebase"

# 非交互，并使用 piped stdin
cat README.md | pi -p "Summarize this text"

# 命名 one-shot session
pi --name "release audit" -p "Audit this repository"

# 使用不同模型
pi --provider openai --model gpt-4o "Help me refactor"

# 带 provider 前缀的模型（无需 --provider）
pi --model openai/gpt-4o "Help me refactor"

# 模型携带 thinking level 简写
pi --model sonnet:high "Solve this complex problem"

# 限制可循环模型
pi --models "claude-*,gpt-4o"

# 只读模式
pi --tools read,grep,find,ls -p "Review the code"

# 禁用一个 extension 或内置工具，同时保留其他工具
pi --exclude-tools ask_question

# 高 thinking level
pi --thinking high "Solve this complex problem"
```

<a id="environment-variables"></a>
### 环境变量

| 变量 | 说明 |
|----------|-------------|
| `PI_CODING_AGENT_DIR` | 覆盖配置目录（默认：`~/.pi/agent`） |
| `PI_CODING_AGENT_SESSION_DIR` | 覆盖会话存储目录（会被 `--session-dir` 覆盖） |
| `PI_PACKAGE_DIR` | 覆盖包目录（对 Nix/Guix 这类 store paths tokenize 效果差的环境有用） |
| `PI_OFFLINE` | 禁用启动网络操作，包括更新检查、包更新检查和安装/更新 telemetry |
| `PI_SKIP_VERSION_CHECK` | 跳过 Pi 版本更新检查。阻止 `pi.dev` latest-version 请求 |
| `PI_TELEMETRY` | 覆盖安装/更新 telemetry 和 provider attribution headers。用 `1`/`true`/`yes` 启用，或 `0`/`false`/`no` 禁用。这不会禁用更新检查 |
| `PI_CACHE_RETENTION` | 设为 `long` 开启扩展 prompt cache（Anthropic：1h，OpenAI：24h） |
| `VISUAL`, `EDITOR` | 当 `externalEditor` 未设置时，作为 Ctrl+G 的外部编辑器 fallback；Windows 默认 Notepad，其他平台默认 `nano` |

---

<a id="contributing--development"></a>
## 贡献与开发

贡献规则见 [CONTRIBUTING.md](../../CONTRIBUTING.md)，本地配置、fork 和调试见 [docs/development.md](docs/development.md)。

<a id="license"></a>
## License

MIT

<a id="see-also"></a>
## 另见

- [@earendil-works/pi-ai](https://www.npmjs.com/package/@earendil-works/pi-ai)：核心 LLM toolkit
- [@earendil-works/pi-agent-core](https://www.npmjs.com/package/@earendil-works/pi-agent-core)：Agent framework
- [@earendil-works/pi-tui](https://www.npmjs.com/package/@earendil-works/pi-tui)：终端 UI 组件

<p align="center">
  <a href="https://pi.dev">pi.dev</a> 域名由
  <br /><br />
  <a href="https://exe.dev"><img src="docs/images/exy.png" alt="Exy mascot" width="48" /><br />exe.dev</a>
  慷慨捐赠
</p>
