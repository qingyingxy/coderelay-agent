# 直播分页试验：请求耗时、超时与取消来源

## 结论

本次仅离线读取冻结源码、会话日志和已安装 SDK，并用 mock fetch 验证错误映射；没有真实网络请求、付费模型调用或业务代码修改。

两组的直接停止原因不同：sol 是请求传输层报告超时；候选组是 Planner 的 90 秒宿主计时器主动取消。网络变慢可能增加规划耗时，但不能将候选组的明确宿主取消解释成已经发生的网络超时。

## 时间线

时间使用日志原始 UTC；北京时间加 8 小时。耗时由 AssistantMessage.timestamp 与会话条目完成时间相减得到，包含 provider 构造到结果持久化，不是 DNS/TCP/TLS 级别测量。

| 组别/请求 | 开始 | 完成 | 耗时 | 结果 |
| --- | --- | --- | ---: | --- |
| sol #1 | 02:17:38.822 | 02:17:49.317 | 10.495 秒 | 成功，返回工具调用 |
| sol #2 | 02:17:54.993 | 02:18:05.401 | 10.408 秒 | error: Request timed out. |
| Planner #1 | 02:19:50.098 | 02:19:55.856 | 5.758 秒 | 成功 |
| Planner #2 | 02:19:59.397 | 02:20:12.356 | 12.959 秒 | 成功 |
| Planner #3 | 02:20:12.378 | 02:20:26.158 | 13.780 秒 | 成功 |
| Planner #4 | 02:20:26.262 | 02:21:15.666 | 49.404 秒 | 成功 |
| Planner #5 | 02:21:15.891 | 02:21:19.959 | 4.068 秒 | aborted: Request aborted |

Planner 最后一个成功工具结果在 02:21:15.887，距离取消只有 **4.072 秒**。此前 31 个工具结果已返回，前四次模型请求成功；没有证据表明此时已经无进展 30 分钟或陷入死循环。首个请求到取消约 89.861 秒，计时器在构造首个请求前已启动，与 90 秒宿主截止吻合。

结构化时间线：`.artifacts/live-pagination-fresh-pair-20260911/timeout-timeline.json`。

## 配置与传播路径

按本轮冻结副本核对：

1. 运行器创建 `SettingsManager.inMemory({ contextManagement, retry: { enabled: false } })`，未设置单次请求超时，且没有载入用户个人超时配置。
2. `settings-manager.ts` 的 HTTP 默认值来自 `DEFAULT_HTTP_IDLE_TIMEOUT_MS = 300_000`。`sdk.ts` 将它作为 `timeoutMs` 传入 provider。
3. `api/openai-responses.ts` 将该值传给 OpenAI SDK 的请求 `timeout`，同时明确 `maxRetries: 0`。外包的 `retryProviderRequest` 未配置时也默认零次重试。
4. OpenAI SDK 在 fetch 阶段区分外部 signal 已取消与底层超时。底层带 timeout 特征的连接错误会映射为 `APIConnectionTimeoutError`，文本为 `Request timed out.`；外部 signal 取消映射为用户取消。provider 再按外部 signal.aborted 将结果标为 `aborted` 或 `error`。
5. Planner 的独立 `setTimeout` 在 90 秒调用 `session.abort()`，并最终抛出 `planner.investigation_timeout`。该计时器不随成功请求、工具返回或流式进展重置。外层 30 分钟无进展看门狗并没有取消它。

因此 sol 的 10.408 秒失败不是该 300 秒 SDK 超时上限到期，也不是 Planner 计时器：直接组不走 Planner，且记录为 error 而非 aborted。SDK 配置的请求等待时间也不能等同于底层连接阶段的超时。

已安装 Undici 的连接器默认超时为约 10 秒，与该失败耗时吻合，属于**连接阶段超时的有力线索**，不是确证。旧日志没有原始 error.cause/code、响应头时间或 socket 事件，无法进一步判定 DNS、TCP、TLS、代理链路或其他底层超时。

mock fetch 离线验证：注入 `UND_ERR_CONNECT_TIMEOUT` 会被当前 OpenAI SDK 映射为同样的 `Request timed out.`，且映射后不保留该 cause code；预先取消的 signal 则得到 `APIUserAbortError`。没有访问 example.invalid 或其他网络。此验证证明错误映射会丢失诊断信息，不证明历史请求一定发生了这个具体错误。

## 停止策略的另一处残留

Planner 还将默认预算合并回来，默认包含 **12 轮、240 秒**。只删除 90 秒计时器，后续仍可能被默认轮次或总时长中断。

若采用已经约定的“持续有进展就继续，只对长期无进展或明确重复循环停止”，应将这三项默认硬上限一并纳入显式宿主策略，避免被内部默认值重新加回。用户主动配置的硬预算则应明确保留，并记录不同的取消来源。

## 建议固定的重试策略

- 只启用一层可记录的网络重试，建议复用 AgentSession 外层：同一个失败请求最多重试 2 次，退避 2 秒、4 秒；provider/SDK 内部重试仍为零，避免次数相乘或费用不可见。
- 可重试连接超时、连接重置、临时限流和部分 5xx；认证、余额/配额不足、无效参数、用户取消与宿主主动停止不自动重试。
- 重试保留已执行工具结果，不重启整个任务，也不消耗“一次业务修复”额度。两组使用完全相同配置。
- 每次尝试都记入日志和成本审计。已返回用量全部累计；无用量标为 unknown，不能因字段初始化为零就按零收费。
- 新增最小诊断字段：请求开始/结束、收到响应头时间、异常类型与原始 cause code、取消来源、尝试编号、用量是否已知。不得写入 API key 或认证头。

以上是离线核实后的修改建议，本轮尚未改变运行策略或发起新对照。下一步应先用假模型/假网络验证有限重试、费用累加、主动取消不重试，以及 Planner 有进展超过 90 秒仍能继续。
