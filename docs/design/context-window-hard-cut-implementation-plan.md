# Context Window 硬切与长程记忆改造计划

> 状态：实施中，CW.0-CW.17.2 已完成
> 范围：`packages/coding-agent`
> 默认行为：保持现有摘要压缩，不在评测完成前切换默认值
> 核心方案：Session JSONL 完整历史 + Context Window 硬切 + Workflow Snapshot + Notes + History

## 1. 结论

Pi 不应复制 Codex 的全部内部实现，而应复用它的窗口管理原则：

```text
完整历史持续持久化
  -> 旧窗口退出 active history
  -> 新窗口注入最小连续性状态
  -> 需要旧细节时按需检索原文
```

Pi 的连续性应以 Workflow Snapshot 为权威来源，Notes 只补充非结构化信息，History 只负责读取旧窗口原文：

```text
Workflow Snapshot：现在做到哪里、事实状态是什么
Notes：为什么这样做、发现了什么、还有什么未决
History：当时具体说了什么、工具具体返回了什么
```

硬切只替换发送给模型的 `agent.state.messages`，不得删除、覆盖或重写 Session JSONL 中的旧消息和工具结果。

## 2. 事实基线

### 2.1 Codex 参考能力

本计划使用以下已经核对的 Codex PR 作为行为参考：

- [#29255](https://github.com/openai/codex/pull/29255)：Token 预算接近阈值时提醒。
- [#29256](https://github.com/openai/codex/pull/29256)：持久化 first/current/previous window ID。
- [#29743](https://github.com/openai/codex/pull/29743)：不生成旧对话摘要的窗口替换。
- [#33255](https://github.com/openai/codex/pull/33255)：Notes fallback buffer。
- [#39827](https://github.com/openai/codex/pull/39827)：History/Notes 扩展。
- [#40539](https://github.com/openai/codex/pull/40539)：向新窗口提供有界 `thread_hint`。
- [#41743](https://github.com/openai/codex/pull/41743)：记录 `history_ingest_requested` 元数据。
- [#42385](https://github.com/openai/codex/pull/42385)：组合启用 token-budget context、history notes 和 `new_context` 的实验开关。

官方 OpenAI 文档只作为产品发布和可用性背景，不用于推断未公开的内部协议：

- [ChatGPT 与 Codex 变更记录](https://learn.chatgpt.com/docs/changelog)

Codex 的参考流程为：

```text
Rollout 保存完整原始记录
  -> Token 预算进入提醒区
  -> 模型整理 Notes
  -> 模型请求 new_context，或达到强制阈值
  -> 等当前响应和工具周期结束
  -> 创建新 window_id
  -> 旧窗口退出 active history，但仍保留在 Rollout
  -> 注入标准初始上下文、WorldState、window lineage 和 thread_hint
  -> 旧细节通过 History 查询
```

### 2.2 Pi 当前能力

| 能力 | 当前实现 | 与硬切的关系 |
|---|---|---|
| 完整会话 | `session-manager.ts` 使用追加式树状 Session JSONL | 直接作为完整历史事实源 |
| 活动上下文 | `buildSessionContext()` 沿当前 leaf 构建消息 | 改造为识别最新窗口边界 |
| 当前压缩 | `CompactionEntry` + LLM 摘要 + recent messages | 保留为兼容和对照组 |
| Workflow Event | `workflow-event-batch` Custom Entry | 不直接进入模型上下文 |
| Workflow Snapshot | `workflow-snapshot` Custom Entry | 生成新窗口权威状态投影 |
| Prompt Envelope | 已区分 task、context、constraints 和 tools | 可复用其结构化表达原则 |
| Session 分支 | entry `id`/`parentId` 构成树 | 窗口和 History 必须限定当前分支 |
| 恢复 | Session、Workflow Snapshot 和 Event 重放 | 增加窗口种子的确定性恢复 |

当前摘要压缩的实际语义是：

```text
选择切点
  -> 调用模型生成摘要
  -> 追加 CompactionEntry
  -> buildSessionContext 注入摘要和保留消息
  -> 替换 agent.state.messages
```

硬切与它最大的区别是：不再生成旧对话摘要，也不保留旧窗口的 recent messages；新窗口只获得明确生成并持久化的连续性种子。

## 3. 目标与非目标

### 3.1 目标

1. Session JSONL 继续保存完整原始消息、工具调用、工具结果和 Workflow 数据。
2. 通过一等 `ContextWindowEntry` 表达窗口边界和 lineage。
3. `buildSessionContext()` 能从当前分支的最新有效边界确定性重建 active history。
4. 切窗只发生在模型响应和工具调用完整落盘后的安全边界。
5. Workflow Snapshot 投影成为 Workflow 会话的主要连续性来源。
6. Notes 保存无法可靠放入 Workflow 领域模型的非结构化信息。
7. History 能按窗口和 entry ID 找回旧原文，不复制第二份完整历史。
8. resume、fork、branch 和 rollback 使用相同的窗口重建规则。
9. 保留现有摘要压缩，并支持可控的 A/B/C 评测。
10. 所有自动动作可观测、可测试、可恢复，失败时不得静默丢失上下文。

### 3.2 非目标

- 不把向量数据库作为第一版前置条件。
- 不自动删除或重写旧 Session Entry。
- 不让 Notes 覆盖 Workflow Snapshot 的权威状态。
- 不把完整 Workflow Snapshot 原样塞进模型上下文。
- 不允许一次 History 调用无界读取整个 Session。
- 不在第一版改变已有 Session 文件的历史内容。
- 不承诺与 Codex 的私有后端协议、字段名或阈值完全一致。
- 不在没有真实模型评测结果时宣称硬切优于摘要压缩。

## 4. 目标架构

```text
Session JSONL（完整事实源）
│
├── message / toolResult
├── workflow-event-batch
├── workflow-snapshot
├── memory-note
└── context_window
      ├── window lineage
      ├── snapshotEntryId
      ├── contextSeed
      └── token / reason metadata

当前分支 leaf
  -> 找到最新上下文缩减边界
  -> 重建当前 system prompt 和 tool schema
  -> 注入 ContextWindowEntry.contextSeed
  -> 加载边界后的新消息
  -> agent.state.messages

旧窗口
  -> History list/search/read
  -> 有界结果进入当前窗口
```

系统指令、项目规则和工具 Schema 继续由 AgentSession 的现有运行时重建，不复制进 `contextSeed`。`contextSeed` 只保存跨窗口连续性内容。

## 5. 数据模型

### 5.1 ContextWindowEntry

在 `SessionEntry` 判别联合中新增一等类型，而不是使用普通 `CustomEntry`。原因是普通 Custom Entry 当前被 `buildSessionContext()` 忽略，无法承担上下文边界语义。

目标结构：

```ts
interface ContextWindowEntry extends SessionEntryBase {
  type: "context_window";
  schemaVersion: 1;
  windowId: string;
  firstWindowId: string;
  previousWindowId: string;
  windowIndex: number;
  reason: "manual" | "model" | "threshold" | "overflow";
  snapshotEntryId?: string;
  workflowId?: string;
  contextSeed: ContextWindowSeed;
  tokensBefore: number;
}
```

窗口创建时间统一使用 `SessionEntryBase.timestamp`，不再增加含义重复的 `createdAt`。

新增核心 Session Entry 时把 `CURRENT_SESSION_VERSION` 从 3 升级到 4。v3 到 v4 不需要改写旧 Entry；迁移只负责声明“没有 `context_window` 的旧 Session 是一个隐式初始窗口”。加载器必须继续正确读取 v1-v3 Session。

`ContextWindowSeed` 保存实际注入模型的内容，而不是只保存一个可变数据源的引用：

```ts
interface ContextWindowSeed {
  schemaVersion: 1;
  content: string;
  workflowSnapshotSequence?: number;
  noteEntryIds: string[];
  truncated: boolean;
}
```

必须同时保存 `snapshotEntryId` 和实际 `content`：

- `snapshotEntryId` 用于审计和追踪权威来源。
- `content` 用于 resume 时确定性重建。
- 后续 Snapshot 或 Notes 更新不得改变旧窗口当时的种子。

### 5.2 初始窗口

第一版使用惰性初始化，不要求每个新 Session 立即写入窗口 Entry：

1. 尚未切窗的 Session 视为隐式初始窗口。
2. 第一次切窗时生成 `initialWindowId` 和 `newWindowId`。
3. 新 `ContextWindowEntry` 同时记录：
   - `firstWindowId = initialWindowId`
   - `previousWindowId = initialWindowId`
   - `windowId = newWindowId`
   - `windowIndex = 1`
4. 后续切窗从最新有效 Entry 推导 lineage。

这样不需要为所有短会话增加额外 JSONL 记录，同时仍能列出初始窗口。

### 5.3 Notes

第一版 Notes 使用版本化 Custom Entry，不进入 active history：

```text
customType: "memory-note"
data:
  schemaVersion
  noteId
  operation: upsert | archive
  category: decision | discovery | preference | constraint | open_question
  content
  workflowId?
  taskId?
  sourceEntryIds
  createdAt
```

Notes Store 沿当前分支重放 `upsert/archive`，输出有界 hint。Notes 不能保存以下权威事实：

- Task 是否完成。
- Attempt 是否成功。
- Verification 是否通过。
- Workflow 当前状态。
- 权限和预算是否有效。

这些内容必须来自 Workflow Snapshot。

### 5.4 窗口 ID 与 Entry ID

- Entry ID 标识 JSONL 中的一条记录。
- Window ID 标识一段 active-context 生命周期。
- Window ID 不承载旧窗口全文。
- 消息第一版不新增 `windowId` 字段；通过当前分支上的 `ContextWindowEntry` 边界计算归属。
- History 返回窗口范围时同时提供 window ID、起止 Entry ID 和时间。

本文所说的“完整历史”是 AgentSession 实际接收并写入 Session 的完整记录。外部命令或工具在生成 AgentMessage 之前已经按自身规则截断的内容，不会因为硬切机制重新变成未截断原文。

## 6. 上下文重建规则

### 6.1 统一缩减边界

`buildContextEntries()` 需要把 `CompactionEntry` 和 `ContextWindowEntry` 视为两种上下文缩减边界，并选择当前分支上最后出现的有效边界：

| 最后边界 | active history |
|---|---|
| 无边界 | 当前分支全部上下文可见 Entry |
| `compaction` | Compaction 摘要 + `firstKeptEntryId` 起的保留消息 + 边界后消息 |
| `context_window` | Context seed + 窗口边界后的消息 |

因此模式在同一 Session 中切换时，按路径上的最后边界决定行为：

- `compaction -> context_window`：新窗口取代旧摘要和保留消息。
- `context_window -> compaction`：摘要只能压缩当前窗口，不得重新读入更早窗口。
- 多次 `context_window`：只注入最新窗口种子和其后的消息。

### 6.2 Settings 与模型状态

thinking level 和 model selection 继续从完整当前分支路径计算，不受窗口边界裁剪。窗口只裁剪 LLM 消息，不回滚会话设置。

### 6.3 Context seed 的消息表示

`ContextWindowEntry` 应投影为一种隐藏的、可识别的上下文消息，内容至少包含：

```text
Window lineage
Current objective
Workflow status
Current plan and ready/running tasks
Latest attempts and failures
Verification status
Active constraints and assumptions
Relevant Notes hint
Next recommended action
History retrieval instruction
```

不得伪装成新的用户请求，也不得在 TUI 中显示为用户发送的普通消息。

### 6.4 损坏数据处理

发现以下情况时必须停止重建并报告明确错误：

- ContextWindowEntry schema 不支持。
- `windowId` 重复或 lineage 断裂。
- `snapshotEntryId` 指向错误类型或错误 Workflow。
- `contextSeed` 缺失或超过硬上限。
- 当前分支出现循环或无法解析的 parent 链。

不得静默回退为“把全部旧历史重新发给模型”，因为这可能再次溢出；也不得静默使用空种子，因为这会造成状态丢失。

## 7. Workflow Snapshot 集成

### 7.1 权威来源

切窗前必须在安全边界保存最新 Workflow Snapshot。现有 Plan Workflow 会频繁 checkpoint，但硬切仍应显式取得本次切窗对应的 Snapshot Entry ID。

需要增加一个统一端口：

```ts
interface WorkflowContextProvider {
  checkpointForContextWindow(): {
    workflowId: string;
    snapshotEntryId: string;
    snapshot: WorkflowSnapshot;
  } | undefined;
}
```

具体接入要求：

- `PlanWorkflowRuntime` 暴露显式 checkpoint，并返回 Snapshot 和 Session Entry ID。
- `AgentSessionAdapter` 为 Direct Workflow 提供相同能力；当前 Direct 路径只有 Event Log 和进程内 Store，不能假设已有可恢复 Snapshot。
- 没有 Workflow 的普通聊天返回 `undefined`，由 Notes 和最小会话种子负责连续性。
- 活动 Workflow 存在但 Snapshot 写入失败时，硬切失败，旧 active history 保持不变。

### 7.2 Snapshot 投影

不得把整个 Snapshot JSON 序列化进 prompt。新增纯函数投影器，只选择继续执行需要的字段：

```text
workflow: id, mode, status, request, stopReason
plan: current version, approval status, task outline
tasks: id, title, kind, status, dependencies
attempts: current/latest attempt, failure, usage summary
verifications: requirement, status, evidence summary
constraints: budget, permission, user-confirmed assumptions
nextAction: 根据权威状态确定性推导
```

投影器必须满足：

- 同一 Snapshot 输入产生相同内容。
- 使用稳定排序，不能依赖 Map 插入偶然顺序。
- 明确标记截断，不得静默丢字段。
- 不把 Notes 中的推断写回 Snapshot。
- 单元测试使用固定 Snapshot，不调用模型。

## 8. 切窗状态机

### 8.1 状态

AgentSession 增加窗口运行状态：

```text
idle
soft_warning_pending
notes_collection
cut_pending
cutting
failed
```

最少需要记录：

```text
pending reason
requestedAt entry/turn
continueAfterCut
soft warning issued for current window
overflow recovery attempted for current window
```

这些是运行状态；成功切窗后的持久状态以 `ContextWindowEntry` 为准。需要跨进程恢复的 pending 状态才写入 JSONL，否则崩溃后按最后完整边界恢复。

### 8.2 触发来源

| 来源 | 行为 |
|---|---|
| `/new-context` | 仅在 AgentSession idle 时立即准备并切窗 |
| `new_context` tool | 只设置 `cut_pending`，当前响应结束后处理 |
| soft threshold | 一次性提醒模型更新 Notes 并收束当前步骤 |
| hard threshold | 设置强制 `cut_pending` |
| overflow | 移除失败的 overflow assistant message，硬切后最多重试一次 |

`new_context` 工具不接收参数。工具执行本身不得清空消息，也不得在未完成的 tool call/tool result 对之间插入窗口边界。

### 8.3 Token 预算

复用当前模型的 `contextWindow` 和现有 `reserveTokens` 概念，第一版不硬编码某个模型窗口大小：

```text
hardLimit = contextWindow - reserveTokens
softLimit = contextWindow - 2 * reserveTokens
```

实现时校验 `0 < softLimit < hardLimit < contextWindow`。有效 reserve 不超过模型窗口的 20%，最小为 1 token；因此配置 reserve 对小窗口过大时，阈值兜底为约 60% soft warning、80% hard cut。小于 3 tokens 的无效模型窗口不启用自动硬切。

原则：

- soft 区间必须足以完成一次 Notes 更新和当前工具周期。
- hard 阈值到达后不能继续开启新的高成本工作。
- Token 状态优先使用最新成功 Assistant usage；估算值只作保守兜底。
- 切窗成功后重置当前窗口 usage、prefill、warning 和 overflow-retry 状态。

### 8.4 安全切窗事务

切窗固定顺序：

```text
1. 等当前 Agent run 到 agent_end/agent_settled 安全边界
2. 确认所有 message_end 和 tool result 已写入 Session JSONL
3. 若有活动 Workflow，写入最新 Snapshot
4. 读取当前分支有效 Notes
5. 生成有界 ContextWindowSeed
6. 校验 Snapshot 引用、lineage 和 seed
7. 追加 ContextWindowEntry
8. 调用 buildSessionContext() 重建消息
9. 原子替换 agent.state.messages
10. 重置窗口运行状态并发出 context_window_end 事件
11. 仅在策略要求时继续 Agent run
```

故障边界：

- Snapshot 已写但窗口 Entry 未写：旧窗口仍有效，多余 Snapshot 无害。
- 窗口 Entry 已写：它必须已经包含完整且校验通过的 seed。
- Entry 追加后重建失败：进入 `failed`，禁止继续采样并报告恢复错误。
- 不需要多文件事务；通过“先依赖数据，最后写边界”获得追加日志原子性。

## 9. History

### 9.1 工具接口

第一版实现一个 session-aware `history` 工具，用 `action` 区分操作，避免增加多个顶层工具：

```text
history { action: "list", ... }
history { action: "search", query, ... }
history { action: "read", entryIds | windowId, ... }
```

逻辑能力：

| Action | 输入 | 输出 |
|---|---|---|
| `list` | 可选分页游标 | 当前分支窗口列表、范围和原因 |
| `search` | query、可选 role/tool/window 过滤 | 命中片段和 Entry ID |
| `read` | Entry ID 或 window ID、分页范围 | 有界原始内容 |

### 9.2 查询边界

- 默认只查询当前 leaf 的祖先路径，不能混入兄弟分支。
- 只读，不创建第二份完整消息存储。
- 搜索第一版使用确定性文本匹配和字段过滤，不引入 embedding。
- 工具结果必须包含 Entry ID，便于二次精确读取。
- 单次结果同时受字节、条目数和估算 token 限制。
- 大工具结果按已有 truncation 约定分页读取。
- 尊重 `excludeFromContext` 和未来的敏感数据标记。
- 不允许 History 返回自己的完整历史结果形成递归膨胀。

### 9.3 检索策略

模型的新窗口提示只说明“缺少旧细节时使用 History”，不主动把搜索结果永久写入 Notes。只有经模型确认仍具长期价值的信息，才通过 Notes 工具保存。

## 10. Notes

### 10.1 工具接口

实现一个 session-aware `notes` 工具：

```text
notes { action: "list" }
notes { action: "upsert", noteId?, category, content, sourceEntryIds? }
notes { action: "archive", noteId }
```

所有写操作追加新 Custom Entry，不原地修改旧记录。

### 10.2 hint 生成

新窗口 hint 按以下优先级选择 Notes：

1. 当前用户约束和偏好。
2. 当前 Workflow/Task 的关键决策。
3. 未决问题和阻塞原因。
4. 与下一步直接相关的发现。
5. 其他近期 Notes。

设置明确的 byte/token 上限，并记录 `truncated`。Codex 的有界 `thread_hint` 可作为设计参考，但 Pi 的具体默认值必须通过评测确定，不能仅因 Codex 使用某个上限就照抄。

### 10.3 soft warning

每个窗口最多发送一次 soft warning：

```text
上下文接近硬限制。
先完成当前不可中断的工具步骤；
把跨窗口仍需要的信息写入 Notes；
然后调用 new_context。
```

如果模型没有写 Notes 且到达 hard threshold，系统仍使用 Workflow Snapshot 和已有 Notes 强制切窗。Notes 是增强层，不是安全切窗的必需事务。

## 11. 配置与模式

扩展现有 compaction 配置，最终提供：

```text
summary   现有摘要压缩
windowed  所有会话使用硬切
hybrid    有可恢复 Workflow 时硬切，普通聊天使用摘要
```

建议配置形状：

```ts
interface ContextManagementSettings {
  mode?: "summary" | "windowed" | "hybrid";
  reserveTokens?: number;
  notesHintMaxBytes?: number;
  historyResultMaxBytes?: number;
}
```

CW.0 固定的初始实验默认值：

| 配置 | 默认值 | 说明 |
|---|---:|---|
| `mode` | `summary` | 保持现有摘要压缩行为 |
| `reserveTokens` | `16384` | 为收束步骤和下一次输出保留预算 |
| `notesHintMaxBytes` | `4000` | 新窗口 Notes hint 的初始上限 |
| `historyResultMaxBytes` | `16000` | 单次 History 结果的初始上限 |

三个数值配置必须是正安全整数。以上值属于评测基线，后续只能依据 CW.16/CW.17 的结果调整。

兼容规则：

- 未设置 `mode` 时等价于 `summary`。
- 现有 `compaction.enabled = false` 继续禁用自动上下文缩减。
- 手动 `/compact` 在 `summary` 模式保持现有语义。
- 手动 `/compact` 在 `windowed` 模式调用硬切，命令输出必须说明没有生成摘要。
- `hybrid` 中“有可恢复 Workflow”必须由 Snapshot provider 判断，不能仅根据最近消息猜测。
- 模式切换不得改写旧 Entry，后续 `buildContextEntries()` 按最后边界处理。

第一版不改变默认模式。真实模型评测完成后再决定是否把 Workflow 默认改为 `hybrid`。

## 12. 事件与可观测性

新增 AgentSession 事件：

```text
context_window_warning
context_window_requested
context_window_start
context_window_end
context_window_failed
history_query
notes_changed
```

`context_window_end` 至少包含：

```text
reason
windowId
previousWindowId
tokensBefore
estimatedTokensAfter
snapshotEntryId?
seedBytes
noteCount
continueAfterCut
```

统计必须区分：

- Session 总 token/cost：包括所有窗口和上下文管理调用。
- 当前窗口 token：只表示最新 active history。
- History 读取 token。
- Notes 维护 token。
- 摘要调用 token：硬切本身应为零，除非未来显式启用模型生成 seed。

## 13. Resume、Fork、Branch 与 Rollback

### 13.1 Resume

```text
打开 Session JSONL
  -> 选择当前 leaf
  -> 验证当前分支 Session Entry
  -> 找到最后一个 compaction/context_window 边界
  -> 恢复 model 和 thinking settings
  -> 使用已保存 seed 重建 active history
  -> 恢复 first/current/previous window lineage
```

resume 不重新生成 seed，不自动重写 Notes，也不调用模型。

### 13.2 Fork 和 Branch

- 窗口边界是 Session 树节点，天然随祖先链继承。
- fork 到某个旧窗口之前时，不能继承该窗口之后的 seed。
- fork 到窗口内某条消息时，使用该路径上最近的有效边界。
- 新分支首次切窗时，`previousWindowId` 是该分支继承的当前窗口。
- History 默认只查询目标分支祖先路径。

### 13.3 Rollback

rollback 后必须重新调用 `buildSessionContext(targetLeafId)`，不能只修改内存中的 `currentWindowId`。Window lineage 始终从目标 leaf 的祖先路径推导。

## 14. 实施阶段

### Phase 0：基线与开关

目标：建立兼容边界，不改变现有行为。

- 定义 `summary/windowed/hybrid` 模式和配置校验。
- 增加硬切事件类型，但不启用自动切窗。
- 为现有摘要压缩、Session 恢复和统计建立基线 Fixture。
- 记录当前测试指标和真实模型任务集版本。

完成条件：默认配置下所有现有行为和测试保持不变。

### Phase 1：窗口持久化与上下文重建

目标：只实现数据语义，不接入模型自动触发。

- 新增 `ContextWindowEntry`、运行时校验和 append API。
- 升级 Session schema 到 v4，并覆盖旧 Session 读取。
- 实现初始窗口和 lineage 推导。
- 改造 `buildContextEntries()` 的统一边界规则。
- 将 context seed 投影为隐藏上下文消息。
- 覆盖 compaction/window 混合、分支和损坏数据测试。

完成条件：测试可以手动构造多个窗口，JSONL 保留全部消息，而 active history 只包含最新 seed 和新消息。

### Phase 2：Workflow Snapshot 连续性

目标：为 Direct 和 Plan Workflow 提供统一 Snapshot provider。

- `PlanWorkflowRuntime` checkpoint 返回 Snapshot Entry ID。
- `AgentSessionAdapter` 增加 Direct Workflow Snapshot checkpoint。
- 新增确定性的 Snapshot 投影器。
- 生成并持久化 `ContextWindowSeed`。
- Snapshot 失败时保证不写窗口边界。

完成条件：Workflow 在手动切窗并 resume 后，目标、Task、Attempt、Verification、约束和下一步一致。

### Phase 3：手动硬切

目标：完成第一个端到端可用纵切。

- 增加 `/new-context` 命令。
- 增加无参数 `new_context` 工具。
- 实现 pending flag 和安全边界处理。
- 发出 start/end/failed 事件并更新统计。
- 支持队列消息和 `continueAfterCut`。

完成条件：工具周期中请求切窗不会破坏 tool call/tool result 顺序，当前 run 结束后能继续执行。

### Phase 4：History

目标：硬切后可以精确找回旧原文。

- 实现当前分支窗口索引。
- 实现 `history list/search/read`。
- 增加分页、过滤、截断和递归结果保护。
- 增加 tool prompt guideline。

完成条件：新窗口可以通过两步 search/read 找回第一窗口中的指定消息或工具结果。

### Phase 5：Notes 与自动 Token 预算

目标：引入 Codex 式提前准备和自动切换。

- 实现 Notes 追加式 Store 和工具。
- 实现有界 Notes hint。
- 增加 soft warning 一次性状态。
- 增加 hard threshold 强制切窗。
- 将 overflow recovery 改为按当前模式选择摘要或硬切。
- 切窗后重置 token/prefill/reminder 状态。

完成条件：模型未主动调用 `new_context` 时，达到 hard threshold 也能完成一次可恢复硬切；overflow 最多自动重试一次。

### Phase 6：生命周期和界面

目标：所有入口使用相同语义。

- 完成 resume、fork、branch、rollback 回归。
- Interactive、Print、JSON 和 RPC 暴露窗口事件和状态。
- `/compact` 根据模式路由并显示明确结果。
- stats 区分 Session 总量和当前窗口。
- 文档说明配置、命令和故障恢复。

完成条件：四种入口重建出的 active history 和 window lineage 一致。

### Phase 7：评测与灰度

目标：用数据决定默认模式。

- 运行确定性机制评测。
- 运行 Faux Provider 集成回归。
- 运行真实模型长程任务矩阵。
- 对比 summary、windowed、hybrid。
- 审查失败 Session JSONL、窗口 seed、History trace 和最终 Workflow View。
- 只有达到门槛后才考虑 Workflow 默认使用 `hybrid`。

## 15. 实施任务清单

| ID | 状态 | 任务 | 主要文件 | 依赖 |
|---|---|---|---|---|
| CW.0 | `DONE` | 固定配置、事件和基线 Fixture | `settings-manager.ts`、测试 | 无 |
| CW.1 | `DONE` | 升级 Session v4，定义 ContextWindowEntry 和校验 | `session-manager.ts`、新 context-window 模块 | CW.0 |
| CW.2 | `DONE` | 实现统一上下文边界算法 | `session-manager.ts` | CW.1 |
| CW.3 | `DONE` | 实现窗口 lineage 和窗口索引 | 新 context-window 模块 | CW.1 |
| CW.4 | `DONE` | 实现 Snapshot 投影器 | `workflow/`、新 context-window 模块 | CW.1 |
| CW.5 | `DONE` | 为 Plan 暴露 checkpoint 引用 | `workflow/plan-runtime.ts` | CW.4 |
| CW.6 | `DONE` | 为 Direct 增加 Snapshot checkpoint | `workflow/agent-session-adapter.ts` | CW.4 |
| CW.7 | `DONE` | 实现安全切窗事务和运行状态 | `agent-session.ts` | CW.2、CW.5、CW.6 |
| CW.8 | `DONE` | 增加 `/new-context` 与 `new_context` | `agent-session.ts`、工具注册 | CW.7 |
| CW.9 | `DONE` | 实现 History list/search/read | 新 history tool、SessionManager 只读 API | CW.3、CW.7 |
| CW.10 | `DONE` | 实现 Notes Store 和工具 | 新 notes 模块、工具注册 | CW.7 |
| CW.11 | `DONE` | 实现 soft/hard token 预算 | `agent-session.ts`、compaction 路由 | CW.8、CW.10 |
| CW.12 | `DONE` | 接入 overflow recovery | `agent-session.ts` | CW.11 |
| CW.13 | `DONE` | 完成 resume/fork/rollback | `agent-session-runtime.ts`、SessionManager | CW.2、CW.7 |
| CW.14 | `DONE` | 接入 Interactive/Print/JSON/RPC | 各 mode 与 RPC 层 | CW.7、CW.13 |
| CW.15 | `DONE` | 完成统计和 trace | AgentSession stats、evaluation | CW.9、CW.10、CW.11 |
| CW.16 | `DONE` | 确定性和 Faux Provider 评测 | `test/`、`evals/` | CW.15 |
| CW.17 | `DONE` | 真实模型 A/B/C 矩阵 | `evals/`、文档 | CW.16 |
| CW.17.1 | `DONE` | 强化内部/外部 ID 命名空间 | Snapshot 投影、真实评测协议 | CW.17 |
| CW.17.2 | `DONE` | 三次重复真实模型矩阵 | `evals/`、报告 | CW.17.1 |
| CW.18 | `TODO` | 默认模式决策 | 设置、CHANGELOG、用户文档 | CW.17.2 |

每完成一个任务，应把状态改为 `DONE`，并在任务下补充实际文件、测试命令和与原计划的偏差。不能在未完成依赖时批量标记后续任务完成。

### CW.0 实施记录

- 实际文件：`core/context-management.ts`、`core/settings-manager.ts`、包导出入口、`test/context-management-settings.test.ts`。
- 固定协议：`summary/windowed/hybrid`、四种切窗原因、七种 context-management 事件及 payload。
- 验证：专项 Vitest 通过；`npm run check` 通过。
- 偏差：基线使用代码内测试向量而不是单独 JSON Fixture，避免尚无窗口 Schema 时制造伪 Session 数据；运行时仍未发出新增事件，按 CW.7、CW.9、CW.10 分别接入。

### CW.1 实施记录

- 实际文件：`core/session-manager.ts`、`core/context-management.ts`、包导出入口、Session migration/context-window 专项测试。
- 数据语义：Session header 升为 v4；v1-v3 迁移只增加既有迁移字段并更新 header，旧会话视为隐式初始窗口。
- 校验：追加前验证基础字段、Schema、reason、seed、note 引用、token 数和单条 lineage 约束；跨 Entry 校验留给 CW.2/CW.3。
- 验证：两个专项 Vitest 文件共 10 项测试通过；`npm run check` 通过。
- 偏差：复用 `core/context-management.ts` 承载校验，而未新建第二个 context-window 模块，避免循环定义协议类型。

### CW.2 实施记录

- 实际文件：`core/session-manager.ts`、`core/context-management.ts`、包导出入口、Session context 专项测试。
- 边界规则：当前分支最后一个 `compaction/context_window` 获胜；硬切仅保留 seed 与边界后 Entry；硬切后的 compaction 不得保留硬切前 Entry。
- 消息表示：seed 投影为 `customType = "context-window"` 且 `display = false` 的隐藏消息，转换到 LLM 时仍使用现有 custom message 路径。
- 验证：两个专项 Vitest 文件共 29 项测试通过；`npm run check` 通过。
- 偏差：跨 Entry lineage 和 Snapshot 引用校验按依赖拆分到 CW.3/CW.7，本任务只校验最后硬切边界自身的结构。

### CW.3 实施记录

- 实际文件：`core/context-management.ts`、`core/session-manager.ts`、包导出入口、lineage 专项测试。
- lineage：第一次切窗生成隐式初始窗口和当前窗口两个唯一 ID；后续固定 first ID、引用 preceding window，并将 index 加一。
- 恢复规则：`getContextWindowLineage()` 始终从所选分支路径推导；SessionManager 不维护第二份可漂移的 current-window 状态。
- 校验：拒绝首边界 index 非 1、跳号、first ID 漂移、previous 断裂和分支内 window ID 重复。
- 验证：lineage/context 两个专项 Vitest 文件共 30 项测试通过；`npm run check` 通过。
- 偏差：lineage 能力继续集中在既有 `core/context-management.ts`，未拆分新文件。

### CW.4 实施记录

- 实际文件：`workflow/context-window-projection.ts`、Workflow 导出入口、投影专项测试。
- 投影内容：Workflow mode/status/request/stop reason、当前 Plan、排序后的 Task、每个 Task 当前或最新 Attempt、Verification、预算/假设、确定性 next action 和 History 指引。
- 边界：默认上限 12000 bytes、硬最小值 1024 bytes；字段和整体输出均按 UTF-8 byte 计算，明细不足时写入显式 omitted marker。
- 确定性：实体、依赖、假设和 evidence 使用稳定排序；不投影 eventIds、processedCommands 或完整 Snapshot JSON。
- 验证：投影专项 Vitest 4 项测试通过；`npm run check` 通过。
- 偏差：投影器位于 Workflow 模块内，context-management 仅消费其持久化结果，保持领域依赖单向。

### CW.5 实施记录

- 实际文件：`workflow/context-window-projection.ts`、`workflow/plan-runtime.ts`、Plan checkpoint 专项测试。
- 统一端口：新增 `WorkflowContextProvider` 和 `WorkflowContextCheckpoint`，返回 `workflowId/snapshotEntryId/snapshot`。
- Plan 行为：`checkpointForContextWindow()` 创建当前权威 Snapshot，先追加 Session Entry，再返回精确引用；原有 checkpoint 调用继续忽略返回值。
- 验证：Plan checkpoint 专项 Vitest 2 项测试通过；`npm run check` 通过。
- 偏差：无。

### CW.6 实施记录

- 实际文件：`workflow/agent-session-adapter.ts`、Direct checkpoint 专项测试。
- Direct 行为：`AgentSessionAdapter` 实现统一 `WorkflowContextProvider`；每次切窗 checkpoint 从当前 Controller 创建最新 Snapshot，先写入 Session，再返回精确 Entry 引用。
- 失败边界：Snapshot 追加失败时同步抛错，不返回不可恢复的 checkpoint，旧 active history 可由后续切窗事务保持不变。
- 验证：Direct checkpoint 专项 Vitest 2 项测试通过；`npm run check` 通过。
- 偏差：无。

### CW.7 实施记录

- 实际文件：`core/agent-session.ts`、公共导出入口、Faux Provider 硬切事务专项测试。
- 状态机：加入 `idle/soft_warning_pending/notes_collection/cut_pending/cutting/failed`；记录 reason、请求 Entry/turn、续跑策略、warning、overflow retry 和失败原因。
- 安全事务：空闲请求立即切窗；运行中请求延迟到 `turn_end` 之后的 `prepareNextTurnWithContext`，确认工具调用清空并落盘后，依次写 Snapshot、生成投影、创建 lineage、追加边界并重建 active history。
- 故障边界：Snapshot 或边界写入失败不会替换 active messages；边界写入后重建失败进入 `failed`，后续采样被拒绝。
- 验证：Faux Provider 专项 Vitest 3 项、既有 prompt/compaction 回归 29 项通过；`npm run check` 通过。
- 偏差：Notes 尚未实现，seed 的 `noteEntryIds` 暂为空；无 Workflow 时使用有界的最近用户目标作为最小连续性种子，CW.10 再合并 Notes hint。

### CW.8 实施记录

- 实际文件：`core/agent-session.ts`、`core/tools/new-context.ts`、工具导出、slash 命令清单和 Faux Provider 专项测试。
- 工具策略：`summary` 不注册 `new_context`；`windowed` 注册并默认启用；`hybrid` 注册工具，但模型请求仅在 Direct/Plan Workflow context provider 存在时接受；allowed/excluded tools 继续生效。
- 安全行为：`new_context` 是无参数 sequential 工具，只设置 `cut_pending` 并等待当前 tool result 落盘；`/new-context` 仅在空闲状态立即切窗，命令反馈只发 presentation event，不写 Session 或 active history。
- 验证：CW.8 专项 Vitest 7 项、既有 prompt/硬切回归 16 项通过；`npm run check` 通过。
- 偏差：显式 `/new-context` 在 `summary` 模式也可使用，因为它是用户明确请求而非自动策略；模型工具仍严格按模式暴露。

### CW.9 实施记录

- 实际文件：`core/history.ts`、`core/tools/history.ts`、`core/session-manager.ts`、`core/agent-session.ts`、公共导出入口和两层专项测试。
- 查询能力：`list` 返回当前分支的隐式初始窗口和持久化窗口范围；`search` 支持 role/tool/window 过滤并返回 Entry ID；`read` 支持 Entry ID 或 window ID，并能从同一超大 Entry 的 byte offset 继续分页。
- 隔离与边界：只遍历当前 leaf 的祖先路径；排除 sibling branch、内部状态 Entry、`excludeFromContext`/敏感标记、History 自身的 tool call/tool result；紧凑 JSON 同时受 50 条、UTF-8 bytes 和估算 token 限制。
- 验证：SessionManager/AgentSession 专项 Vitest 7 项及 CW.8/CW.7 相关回归通过；`npm run check` 通过。
- 偏差：为保证任意返回页至少能容纳元数据和 continuation cursor，单次 History 结果预算低于 2048 bytes 时明确拒绝查询；第一版 cursor 是版本化 opaque offset，不承诺跨分支切换复用。

### CW.10 实施记录

- 实际文件：`core/notes.ts`、`core/tools/notes.ts`、`core/session-manager.ts`、`core/agent-session.ts`、公共导出入口和两层专项测试。
- 存储语义：`memory-note` Custom Entry 使用版本化 `upsert/archive` 追加操作；当前分支重放得到 active Notes，保留稳定 `createdAt`，并验证 Note ID、category、来源 Entry 和操作顺序。
- 工具与 hint：`notes list/upsert/archive` 仅在 `windowed/hybrid` 注册；hint 按约束/偏好、当前 Workflow 决策、未决问题、发现和其他近期 Notes 排序，受 UTF-8 byte 上限约束并写入显式 `[notes truncated]`。
- 硬切集成：切窗事务在 Snapshot 后读取 Notes，把实际注入的 Note Entry IDs、content 和 truncated 状态固化进 `ContextWindowSeed`；同一 assistant batch 中 Notes 先落盘、`new_context` 后请求时能够进入新 seed。
- 验证：SessionManager/AgentSession 专项 Vitest 8 项及 Context Window 相关回归通过；`npm run check` 通过。
- 偏差：单条 Note 内容上限复用 `notesHintMaxBytes`，避免保存一个永远无法完整进入配置 hint 的 Note；Notes list 使用 `historyResultMaxBytes` 作为工具结果上限。

### CW.11 实施记录

- 实际文件：`core/context-management.ts`、`core/agent-session.ts`、公共导出入口、预算单元测试和 Faux Provider 集成测试。
- 阈值：正常窗口使用配置的 `reserveTokens`；当 reserve 超过窗口 20% 时按 20% 截断，保持约 60% soft warning、80% hard cut，并验证严格阈值顺序。
- 路由：`summary` 保持原有摘要压缩；`windowed` 自动使用硬切；`hybrid` 仅在当前存在 Direct/Plan Workflow context provider 时硬切，普通聊天继续摘要。
- 运行语义：优先采用最新成功 Assistant usage；缺失、错误或零 usage 时估算 active messages。每个窗口只追加一次隐藏 warning，要求更新 Notes 后调用 `new_context`；hard threshold 在消息完整持久化后强制执行现有安全切窗事务。
- 重置：成功切窗继续重置最新 Assistant、soft warning、overflow retry 和窗口 phase；`/new-context` 可在 Notes 收集阶段手动完成切窗。
- 验证：预算与 Faux Provider 专项 12 项、Context Window/compaction/Notes 相关回归 33 项通过；`npm run check` 通过。
- 偏差：overflow 分流按任务依赖保留给 CW.12；CW.11 只替换非 overflow threshold 路径。

### CW.12 实施记录

- 实际文件：`core/agent-session.ts`、Faux Provider overflow 专项测试。
- 路由：`windowed` 和当前有 Workflow provider 的 `hybrid` 使用硬切恢复；`summary` 和普通 `hybrid` 保持原有摘要恢复。
- 错误恢复：overflow Assistant 错误先写入 Session JSONL，再从 active messages 移除；随后以 `reason = overflow` 建立边界，并从持久化 seed 自动继续一次。
- 成功响应：provider 成功返回但 usage 已超过窗口时建立硬切边界，不重复采样已经完成的 Assistant 响应。
- 重试上限：overflow 切窗期间保留 recovery-attempt 标志；重试成功、下一条用户消息或非 overflow 切窗后重置，连续第二次 overflow 不再切窗或重试。
- 验证：overflow 专项 4 项、compaction/token budget/context window/retry 相关回归 48 项通过；`npm run check` 通过。
- 偏差：没有把“第二次 overflow”伪装成 `context_window_failed`，因为边界事务本身并未失败；原始 Assistant error 仍是可观测和持久化的失败记录。

### CW.13 实施记录

- 实际文件：`core/agent-session.ts`、Session lifecycle 专项测试。
- resume/fork：恢复继续复用 `SessionManager.buildSessionContext()` 和完整分支推导的 lineage；持久化重开不调用 provider、不重新生成 seed，也不改写 Notes。fork 到边界前不继承窗口，边界上和边界后继承对应 seed，sibling 分支保持隔离。
- rollback：`navigateTree()` 成功重建目标分支后统一清空旧分支的 pending cut、soft warning、overflow retry、失败原因和最近 Assistant 缓存，active messages 与 lineage 均以目标分支为准。
- 验证：Session lifecycle 专项 Vitest 通过；`npm run check` 通过。
- 偏差：resume/fork 创建新 `AgentSession` 时窗口运行态已由字段初始化为 idle，因此无需修改 `agent-session-runtime.ts`；新增代码只处理同一 Runtime 内的 tree navigation/rollback。

### CW.14 实施记录

- 实际文件：`core/agent-session.ts`、slash 命令描述、Interactive/Print/RPC mode、RPC client/types 及专项测试。
- `/compact` 路由：新增显式 `CompactCommandResult`；`summary` 和无 Workflow provider 的 `hybrid` 返回生成摘要的结果，`windowed` 和有 provider 的 `hybrid` 返回 hard-cut boundary/pending 状态，并明确 `summaryGenerated = false`。底层 `AgentSession.compact()` 保持纯摘要 API，扩展调用不被静默改义。
- 界面：Interactive 对 warning/end/failed 提供状态并在切窗后从 active entries 重建聊天；Print 记录最后完成的可输出消息，因此自动硬切替换 active history 后仍输出真正的 Assistant；JSON 和 RPC 继续原样流出全部窗口事件。
- RPC 状态：`get_state` 增加 context-management mode、窗口运行态和当前分支 lineage；RPC `compact` 返回带策略判别的命令结果。
- 验证：compact 路由、Interactive 和 Print/JSON 专项 Vitest 通过；相关 `/new-context`、RPC JSONL 回归通过；`npm run check` 通过。
- 偏差：Print 文本模式不额外输出自动窗口事件，以保持 stdout 是最终结果；结构化 JSON 模式提供完整事件。RPC 命令使用结构化 strategy 字段，不用人类文本推断是否生成摘要。

### CW.15 实施记录

- 实际文件：`core/context-management-stats.ts`、`core/agent-session.ts`、公共导出、Interactive `/session` 展示和专项测试。
- 统计边界：既有 Session token/cost 继续覆盖完整 Session 树；context-management 聚合只看当前分支，并单列当前 active window 的消息数和估算 token、硬切次数/seed、History 结果、Notes 操作/结果以及摘要调用 usage。
- 精度：compaction summary token/cost 读取持久化 provider usage；hard cut 不调用模型，`modelCallTokens` 固定为 0；History/Notes 暂无独立 tokenizer usage，因此以实际 UTF-8 result bytes 除以 4 明确标记为估算值。
- trace：`getContextManagementTrace()` 返回逐窗口 boundary、History action/request/result 和 Note operation，并携带当前分支 lineage；可与 Session JSONL 和 Workflow View 一起保存用于失败样本审查。
- 验证：context-management stats/trace 专项 Vitest 和既有 AgentSession stats 回归通过；`npm run check` 通过。
- 偏差：未修改正在并行开发的 `core/evaluation/*`；评测层可直接调用公共 trace API，具体持久化接入留在 CW.16 的独立评测脚本中。

### CW.16 实施记录

- 实际文件：`evals/context-window/evaluate.ts`、对应 README、Faux Provider 评测回归和根目录 `eval:context-window` 命令。
- 矩阵：A=`summary`；B=`windowed + Notes + History`；C=`windowed + Workflow Snapshot + Notes + History`；D=`hybrid` 普通会话和活动 Workflow 分流。
- 机制断言：完整分支继续保留旧消息、active history 排除旧 Entry、摘要或 seed 保留控制信息、Notes 固化进 seed、History 精确找回旧值并进入 trace、Workflow 边界引用权威 Snapshot、hard cut 不产生摘要模型调用。
- 失败样本：评测结果在失败时附带当前分支、active messages 和 context-management trace；成功结果只保留聚合指标，避免报告无界膨胀。
- 验证：`npm run eval:context-window` 和专项 Vitest 均为 4/4 通过；评测固定使用 Faux Provider，不需要网络、凭据或付费 token。
- 偏差：CW.16 只证明确定性机制和策略路由满足协议，不能衡量真实模型的 Notes 质量、History 使用决策或长任务完成率；默认模式继续保持 `summary`，等待 CW.17。

### CW.17 实施记录

- 实际文件：`evals/context-window/evaluate-real.ts`、版本化 Task Set、评测 README、`cw17-report.md`、真实评测专项测试，以及 History strict-schema 兼容回归。
- 固定配置：`qingyingxy/gpt-5.6-terra`、`medium` effort、272000 token 评测窗口、每次最多 3000 output tokens；8 个 run 和所有模型交互严格串行，禁用 Provider 自动重试。
- 计费：按 OpenAI 官方 GPT-5.6 Terra 短上下文价格估算；reasoning 作为 output 子集不重复计费。最终矩阵估算 `$0.472444`，包括调试和中止批次的开发评测总估算约 `$1.183453`。
- 机制结果：8/8 使用预期 summary/hard-cut 路由并保留完整 Session JSONL；6/6 硬切组 Notes 和 History 查询成功；4/4 Workflow 组的窗口边界引用 Snapshot。
- 任务结果：严格端到端输出 5/8 通过；所有 8 个 run 都找回了除外部 `task_id` 以外的全部耐久事实和精确工具值。三个失败分别把 `record_id` 或 Workflow 内部 `task-<uuid>` 写入通用 `task_id`，暴露了 Snapshot、History 和任务协议之间的 ID 命名空间歧义。
- 评测修正：History 的 OpenAI-compatible strict Schema 允许无关可选字段使用 `null` 并在执行前归一化；强制切窗工具在首个成功 benchmark boundary 后从续跑窗口移除，防止 checkpoint 指令随 seed 重放形成重复切窗。
- 验证：Task Set 校验通过；History 与真实 runner 专项 Vitest 7/7 通过；`npm run check` 退出码 0。Biome 仍对另一并行会话占用的 `core/evaluation/protocol.ts` 报 Windows 访问拒绝，但未修改该文件，后续依赖、类型和 browser smoke 检查均通过。
- 结论：当前样本证明硬切、Notes、History 和 Workflow Snapshot 的机制链路可用，但没有证明 Workflow 组端到端质量优于摘要组。默认模式继续保持 `summary`；CW.18 必须先消除外部/内部 ID 歧义并增加重复样本，不能直接切换默认值。

### CW.17.1 实施记录

- Snapshot 投影中的 Workflow、Plan、Task、Attempt 和 Verification 标识统一改为显式 `workflow_*_id` 命名，并声明这些值是内部控制面 ID，不得替代用户请求的领域标识。
- 真实 Task Set 升级为 `context-window-real-smoke-v2`，外部评测主键从含混的 `task_id` 改为 `case_id`；`repair-ledger` 另外保留 `domain_task_id=domain-repair-42`，专门测试它不会被 Workflow 内部 Task ID 覆盖。
- 评测 Prompt 明确区分 `case_id`、`domain_task_id`、`record_id` 和 Workflow 内部 ID；解析器拒绝缺失或不匹配的 `case_id`。
- 验证：投影与真实 runner 专项 Vitest 9/9 通过；v2 Task Set 校验通过；`npm run check` 退出码 0。Biome 仍对另一并行会话占用的 `core/evaluation/protocol.ts` 报 Windows 访问拒绝，后续检查全部通过。
- 默认模式继续保持 `summary`；下一步 CW.17.2 使用相同模型与 effort 做三次重复的 24-run 串行矩阵，旧 CW.17 结果不改写。

### CW.17.2 实施记录

- 实际文件：真实评测 runner、专项测试、评测 README、`cw17.2-report.md` 和本计划；runner 新增正整数 `--repetitions`，每条结果记录 repetition，并用独立 `repeat-NN` 目录保存 Artifact。
- 固定配置：`qingyingxy/gpt-5.6-terra`、`medium` effort、3 次重复、24 个 run、严格串行、Provider 重试关闭、总估算成本上限 `$2.00`。
- 结果：24/24 严格输出通过，三轮各 8/8；`case_id` 24/24 正确，冲突样本的 `domain_task_id` 12/12 正确，未再出现 record ID 或 Workflow 内部 Task ID 替换外部标识。
- 机制：18/18 硬切 run 的 Notes、History 查询和命中通过；12/12 Workflow run 引用了边界 Snapshot；24/24 保留完整 Session JSONL 并从边界后的 active history 排除旧工具结果。
- 资源：总计 475966 input、11272 output、3836 reasoning、863744 cache-read tokens，140 次 Provider 调用，估算成本 `$1.259945`。B/C/D 相对 A 的平均 input 分别下降 21.4%/11.3%/7.9%，平均成本下降 15.7%/7.7%/5.4%，平均耗时增加 9.9%/17.8%/12.6%。
- 验证：runner 专项 Vitest 5/5 通过，v2 Task Set 的 3-repeat 计划校验为 24 runs；`npm run check` 退出码 0。Biome 仍只对另一并行会话占用的 `core/evaluation/protocol.ts` 报 Windows 访问拒绝，后续检查全部通过。
- 结论：ID 命名空间修正已通过当前控制集，但两个合成任务不足以决定全局或 Workflow 默认值；CW.18 前应补充多窗口编码、resume/fork/rollback、Attempt repair、overflow 和分支隔离评测，默认继续保持 `summary`。

## 16. 测试计划

### 16.1 SessionManager 单元测试

- 无边界时保持旧行为。
- 单次和多次 ContextWindowEntry 只使用最新 seed。
- 旧窗口消息仍存在于 `getEntries()`。
- `buildSessionContext()` 不返回旧窗口消息。
- thinking/model 从完整分支恢复。
- compaction 后 hard cut 由 hard cut 获胜。
- hard cut 后 compaction 只处理当前窗口。
- fork 到边界前、边界上、边界后结果正确。
- sibling branch 的窗口和消息不泄漏。
- 损坏 seed、重复 window ID、断裂 lineage 明确失败。
- v1-v3 旧 Session 无窗口 Entry 时无需迁移即可读取。

### 16.2 AgentSession 集成测试

- `/new-context` 在 idle 状态完成切窗。
- streaming 时 `new_context` 只设置 pending。
- 最后一个 tool result 持久化后才追加窗口 Entry。
- Snapshot 写入失败不会切窗。
- Entry 追加后 active messages 被替换一次。
- 切窗后 queued steering/follow-up 保持顺序。
- threshold 不重复触发同一窗口。
- overflow 最多硬切并重试一次。
- abort/cancel 与 cut pending 的优先级明确。
- extension compaction hook 在 summary 模式保持兼容。

### 16.3 Workflow 恢复测试

- Plan Workflow 的 Task、Attempt、Verification 在切窗后一致。
- Direct Workflow 也能生成可恢复 Snapshot。
- Snapshot Entry ID 与 seed 中 sequence 一致。
- 进程在 Snapshot 后、窗口 Entry 前退出时恢复旧窗口。
- 进程在窗口 Entry 后退出时恢复新窗口。
- rollback 后恢复目标分支对应 Snapshot 和窗口。

### 16.4 History/Notes 测试

- History 默认只查当前分支。
- search 返回稳定顺序和 Entry ID。
- read 支持分页并严格执行上限。
- excluded/sensitive 内容遵守策略。
- Notes upsert/archive 重放确定。
- hint 优先级和截断确定。
- Notes 不能修改 Workflow 权威状态。

### 16.5 测试命令

修改测试文件时先运行对应专项测试：

```bash
cd packages/coding-agent
node ../../node_modules/vitest/dist/cli.js --run test/session-manager/build-context.test.ts
node ../../node_modules/vitest/dist/cli.js --run test/<context-window-specific>.test.ts
```

所有代码修改完成后按仓库规则运行：

```bash
npm run check
```

需要执行全部非 e2e 测试时，从仓库根目录运行：

```bash
./test.sh
```

不得直接运行完整 Vitest suite，也不运行 `npm run build` 或 `npm test`，除非用户明确要求。

## 17. 评测方案

### 17.1 对照组

| 组别 | 策略 |
|---|---|
| A | 当前 summary compaction |
| B | windowed + Notes + History |
| C | windowed + Workflow Snapshot + Notes + History |
| D | hybrid：Workflow hard cut，普通会话 summary |

所有组使用相同模型、reasoning、任务、工具权限、上下文窗口、最大成本和重复次数。

### 17.2 长程任务类型

1. 第一窗口给出约束，第三窗口验证是否继续遵守。
2. 第一窗口产生工具结果，后续必须通过 History 找回精确值。
3. 多次失败 Attempt 后恢复正确的下一步。
4. Verification 失败后创建 Repair，再次验证。
5. 中途退出并 resume。
6. 从旧 Entry fork，验证没有继承未来窗口状态。
7. 单次超大工具结果触发 overflow recovery。
8. 普通无 Workflow 长对话，验证 Notes/History 是否足够。

### 17.3 指标

- 最终任务完成率。
- 跨窗口约束保持率。
- Workflow 状态一致率。
- resume 后成功继续率。
- History search/read 命中率。
- 错误引用旧分支内容的比例。
- 重复工具调用次数。
- 平均输入、输出和缓存 token。
- Notes 与 History 的额外 token/cost。
- 每次切窗后的首轮失败率。
- 平均完成时长。
- 人工判断的摘要失真或状态漂移数量。

### 17.4 最低上线门槛

在考虑把 Workflow 默认改为 `hybrid` 前，至少满足：

- C/D 组长任务完成率不低于 A 组。
- 跨窗口约束保持率和 resume 成功率高于或等于 A 组。
- 无跨分支 History 泄漏。
- 无工具调用对断裂。
- 无 Snapshot/seed 不一致后继续执行的情况。
- 平均输入 token 明显下降，或在完成率提高时成本增幅有明确数据支持。
- 所有失败样本保存 Session JSONL、窗口 lineage、seed、History trace 和 Workflow View。

具体百分比门槛应在建立基线后写入评测配置，不能在没有基线数据时任意指定。

## 18. 风险与控制

| 风险 | 后果 | 控制措施 |
|---|---|---|
| Snapshot 投影遗漏关键状态 | 新窗口错误继续 | 固定 Schema、确定性测试、History 兜底 |
| Notes 被当作权威状态 | 与 Workflow 冲突 | 明确优先级，禁止 Notes 写领域状态 |
| History 返回过多内容 | 新窗口再次膨胀 | 分页、字节/token 上限、片段优先 |
| 切窗发生在工具中间 | tool result 顺序损坏 | pending flag，只在 settled 边界提交 |
| 分支查询污染 | 引用另一分支未来信息 | 默认仅沿当前 leaf 祖先路径查询 |
| 模式混用语义不清 | resume 结果不确定 | 统一“最后缩减边界”算法 |
| seed 只保存引用 | 后续恢复内容漂移 | 同时保存来源 ID 和实际注入 content |
| Direct Workflow 无 Snapshot | hybrid 丢失执行状态 | 为 AgentSessionAdapter 增加 checkpoint |
| 自动提醒消耗剩余窗口 | 未完成 Notes 即 overflow | 双阈值、预留 buffer、强制 deterministic cut |
| 硬切降低 prompt cache 命中 | 成本可能上升 | 单独统计 prefill/cache，纳入 A/B/C |

## 19. 不变量

实现和评审时必须始终满足：

1. Session JSONL 是完整历史事实源，硬切不删除旧 Entry。
2. ContextWindowEntry 只定义边界和恢复种子，不复制旧窗口全文。
3. active history 只能由 `buildSessionContext()` 统一构建。
4. 当前分支之外的 Entry 不进入 active history 或默认 History 查询。
5. Workflow Snapshot 高于 Notes，Notes 高于临时模型推断。
6. seed 必须在窗口边界写入前完成并校验。
7. tool call/tool result 对不能被窗口边界分开。
8. resume 使用持久化 seed，不重新调用模型生成连续性内容。
9. 损坏窗口状态必须显式失败，不能静默丢上下文继续执行。
10. 默认模式在评测通过前保持 `summary`。

## 20. 完成定义

本改造只有同时满足以下条件才算完成：

- `summary/windowed/hybrid` 三种模式均有明确且测试覆盖的行为。
- Session JSONL 可以审计全部旧窗口原文。
- 当前窗口上下文不包含旧窗口原始消息。
- Direct 和 Plan Workflow 都能通过 Snapshot seed 恢复。
- Notes 和 History 工具具备严格边界和稳定输出。
- 手动、自动、模型请求和 overflow 四种切窗来源可用。
- resume、fork、branch、rollback 行为一致。
- `npm run check` 无错误、警告和 info。
- 修改过的专项测试全部通过，完整非 e2e 测试按要求通过。
- 真实模型评测报告包含基线、任务、模型、Prompt、成本和失败样本。
- CHANGELOG 和用户配置文档准确说明默认值与实验状态。

在完成定义满足之前，不移除现有摘要压缩，也不把硬切设为全局默认。
