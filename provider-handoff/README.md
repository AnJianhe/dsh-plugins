# dsh-provider-handoff

从**宽上下文模型**（DeepSeek，100 万窗口）切到**窄上下文模型**（ChatGPT / `openai-codex`）时，
先把对话压缩进目标模型的上限，再把压缩后的上下文发过去。

不装这个插件时，切换后发出的第一条请求会带着原本喂给 100 万窗口的完整历史，
撞上 ChatGPT 的窗口上限——轻则报错，重则整轮对话卡死。

## 它怎么工作

1. 在 `agent/pre-step` 里读会话的目标路由（`session.requestContext()`）。
2. 与**上一次真正发出去的请求**路由（`agent/request` 记录）比较窗口大小。
   只有"切到更小的窗口"才接手；同模型继续、或换到更大窗口一律不干预。
3. 用 `ctx.llm.resolveModelInfo()` 取目标模型窗口，扣掉输出预留和 `headroomTokens` 得到预算。
4. 用 `ctx.tokenMeter.measure(session, header)` 把当前对话按**目标模型**计价。
5. 超预算时，从最老的一端选一段可安全切割的区间（不切断 tool-call / tool-result），
   交给 `ctx.compaction.compactRegion()` 压成一条摘要；最近 `retainNodes` 条原样保留。
6. 压缩写回会话日志后，本次请求才继续组装——所以 ChatGPT 拿到的是压缩后的历史。
7. 一直压到进入预算为止，最多 `maxCompactionsPerRequest` 轮。
8. **压不下去就阻断请求**（`blockOnFailure: true`），绝不把原始长对话直接发过去。

摘要由压缩后端生成。本插件的 patch 把 `compaction-basic` 的
`summarizationProvider` / `summarizationModel` 固定为 `deepseek-account` / `deepseek-flash`，
也就是**用 DeepSeek 压缩**，而不是让即将接收对话的 ChatGPT 自己压自己。

## 安装时一并做的两件事

当前 profile 里 `@deepseek-ai/dsh-compaction-basic` 原本是**关闭**的（`enabled: false`），
所以 patch 里显式 `disabled: false` 把它打开，并提供 DeepSeek 摘要目标。
`dsh-token-meter`、`dsh-session`、`dsh-llm` 本来就是 active，无需改动。

## 配置

在 `cordis.patch.yml` 的 `provider-handoff` 行里改：

| 字段 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | 关掉后只判断、不压缩也不拦截 |
| `headroomTokens` | `8192` | 输出预留之外的安全余量，吸收估算误差 |
| `retainNodes` | `6` | 最近多少条原样保留 |
| `maxCompactionsPerRequest` | `2` | 一次请求前最多连续压几轮 |
| `blockOnFailure` | `true` | 压缩失败时阻断，而不是照发原对话 |

## 怎么确认它真的生效了

Host 日志里会出现：

```text
[provider-handoff] 切到 openai-codex/gpt-6-astra 前已压缩：…（原约 512340 tokens，预算 190000）
[provider-handoff] 已进入目标预算：约 183200 / 190000 tokens
```

失败时：

```text
[provider-handoff] 约 512340 tokens 超出目标窗口预算 190000，但找不到可安全压缩的区间（最近 6 条需原样保留）
```

## 已知限制

- **估算器是启发式的**：`tokenMeter` 不是目标模型的 tokenizer，中文和 JSON 会被低估，
  所以默认留 8192 余量；窗口特别小的模型建议加大。
- **系统提示词和工具定义压不掉**：它们不是 surface 节点，预算里已经扣过，但如果它们本身
  就超过目标窗口，任何压缩都救不回来，此时会明确报错而不是硬发。
- **必须存在可切割的区间**：最近 `retainNodes` 条要原样保留；如果超出的量全部集中在这几条里，
  压缩无法完成（同样会报错）。
- 只处理"切到更小窗口"。切回更大窗口、或同一模型内部接近上限，由 `compaction-basic`
  自己的压力/溢出策略负责。
- 预检读的是会话记录的目标路由。如果某次切换后该记录尚未刷新（少见的时序），
  这一轮会漏检；此时仍不会静默失败——`compaction-basic` 的 `CONTEXT_WINDOW_EXCEEDED`
  恢复会在收到确认的溢出错误后压缩并重试一次。也就是说：最坏情况是多一次重试，而不是崩溃。
- 压缩是**永久改写会话历史**（原始事件仍在日志里，可回放）。这是把长对话交给小窗口模型的代价。

## 测试

`budget.js` 是纯函数，不依赖 Cordis：

```powershell
node --test budget.test.js
```
