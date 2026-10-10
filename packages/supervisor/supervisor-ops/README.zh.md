---
description: "用量预算与按模型价格表及降级或停止策略、由计划、断点与 diff 汇总的交付报告、经部署提供传输的聊天通知，以及绝不自行执行命令的关机闸门。"
kind: "package-reference"
---

# @deepseek-ai/dsh-supervisor-ops

[English](README.md) | 中文

## 概述

当受监督运行必须守住花费上限、汇报交付内容，或需要触达人类时，挂载 `dsh-supervisor-ops`。它发布 `ctx.supervisorOps`：用量账本，按配置的价格表把 token 数折算为金额，针对任务与当日预算报告 `alert` 与 `exceeded`，并在受监督终端切换到另一任务时重开任务窗口；共享状态目录下的交付报告存储；向终端所有者转发 steer 的聊天桥；以及只报告运维配置命令、绝不执行它的关机决策。4 个工具只记录模型报告的内容；在部署提供传输之前，`supervisor_notify` 会报告没有已注册的传输。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

只要监督模型需要跟踪花费、撰写交付报告、触达人类，或判断机器可以断电，就在控制平面与任务状态组件旁边挂载它。

### 何时选择它

当一次运行带有金额上限、完成的任务需要由计划、断点和 diff 汇总出的持久报告、运维希望把完成或预算事件推送到聊天会话，或机器只能在所有任务完成后断电时，选择本组件，并搭配 `@deepseek-ai/dsh-supervisor-core` 与 `@deepseek-ai/dsh-supervisor-tasks`。单个短任务，以及在别处已经核算花费的组合，可以跳过它：同包其余 5 个组件不依赖它也能工作，而本包自身不观察任何供应商计费。

### 最小配置

```yaml
- id: supervisor
  name: '@deepseek-ai/dsh-supervisor-core'
  config:
    stateDir: ./state
- id: supervisor-tasks
  name: '@deepseek-ai/dsh-supervisor-tasks'
- id: supervisor-ops
  name: '@deepseek-ai/dsh-supervisor-ops'
  config:
    modelPrices:
      - model: standard
        usdPerMillionTokens: 0.6
```

本组件从 `ctx.supervisor.config` 读取 `stateDir`，因此没有自己的路径，报告写入共享状态目录。每个字段都是生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-supervisor-ops)的子集。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `budget.taskBudgetUSD` | `5` | 单个任务允许的美元数。 |
| `budget.dailyBudgetUSD` | `20` | 每个本地自然日允许的美元数。 |
| `budget.alertThresholdPct` | `80` | 任一预算达到该百分比时账本报告 `alert`。 |
| `budget.onExceed` | `downgrade-all` | 预算超限后报告的动作；`downgrade-all` 或 `stop-task`。 |
| `modelPrices` | `[]` | `{ model, usdPerMillionTokens }` 条目，记录的 token 数按它计价。 |
| `shutdown.enabled` | `false` | 是否可能允许关机。 |
| `shutdown.command` | `''` | 允许关机时报告的运维提供命令。 |
| `shutdown.gracePeriodMin` | `5` | `all-tasks-completed` 需在记录的最后任务完成时间之后经过的分钟数。 |

### 四个工具

| 工具 | 作用 | 结果字段 |
|---|---|---|
| `supervisor_budget` | 记录一次用量观察（`record`）或读取累计总额（`status`） | `recorded`、`tokens`、`taskUSD`、`dailyUSD`、`alert`、`exceeded`、`onExceed`、`entries` |
| `supervisor_notify` | 渲染一条事件通知，经已注册传输推送到会话 | `delivered`、`text`、`reason` |
| `supervisor_shutdown` | 检查已存计划与宽限期后，判断配置命令是否可因某个触发原因执行 | `allowed`、`command`、`reason` |
| `supervisor_report` | 由已存计划、断点与 git 统计渲染交付报告，并写到状态目录下 | `path`、`markdown`、`filesAdded`、`filesModified`、`filesDeleted`、`linesInserted`、`linesDeleted` |

### 聊天传输

`useChatTransport(transport, handler?)` 注册部署的通信线路。插件持有默认路由：入站消息以 `[chat] <发送者>: <文本>` 作为 steer 送达每个拥有受监督终端的不同 agent，因此人类可以从聊天中询问状态或改变运行方向。提供 `handler` 的部署会接管该职责；返回的 disposer 只在它仍是最新传输时退订并遗忘它。`chat` 暴露已注册的 `ChatBridge`。

### 预算策略

费用按顺序解析：调用上的显式 `costUSD`、命名 `model` 在配置 `modelPrices` 中的条目，否则为零。`alertThresholdPct` 设置 `alert` 标志，两个预算设置 `exceeded`，`onExceed` 是预算超限后告知模型应执行的动作；账本自身从不停止或降级任何东西。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

### 本组件拥有什么，借用什么

计划、受监督会话、输出日志、断点与 git 属于控制平面与任务状态组件；本组件通过 `ctx.supervisor` 与 `ctx.supervisorTasks` 读取它们，并把两者连同 `tools` 一起声明在 `inject` 中。它拥有内存中的用量账本、聊天桥、预算、价格与关机配置、4 个工具，以及一个持久报告目录：共享状态目录下的 `deliverables/<taskId>/report.md`。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | `supervisorOps` 服务：已解析配置、账本、报告、聊天桥与工具注册 |
| [`src/tools.ts`](src/tools.ts) | 4 个工具的 schema、渲染、执行器与计划完成度检查 |
| [`src/budget.ts`](src/budget.ts) | `UsageLedger`、价格表查找、用量解析与费用估算 |
| [`src/feishu.ts`](src/feishu.ts) | 聊天传输接口面、命令解析与通知渲染 |
| [`src/report.ts`](src/report.ts) | Markdown 报告渲染与按任务划分的报告存储 |
| [`src/shutdown.ts`](src/shutdown.ts) | 关机策略与允许或拒绝的决策 |

### 用量账本

`UsageLedger` 按顺序保存每次观察及其在记录时刻计价出的金额，因此之后修改价格表不会改写已经报告过的总额。`status(now)` 把当前任务起点及之后的条目累加为 `taskUSD`，把同一本地自然日的条目累加为 `dailyUSD`；`resetTask()` 丢弃任务花费而保留当日花费。服务持有该窗口：在记录或报告之前，它读取所有绑定任务的受监督终端一致同意的任务 id，当该 id 与窗口的任务不同时调用 `resetTask()`，而在终端未命名任务或意见不一致时保持窗口不变——因此终端被遗忘之后写出的报告仍显示已完成任务的花费。构造函数会重新校验策略，因此手工构造的账本不可能持有永远无法触发的预算。

### 交付报告

`renderReport` 由已存事实——带验收标准的计划、断点、diff 统计、账本状态——加上模型提供的审查摘要、后续建议与回滚方式，组装出一份 Markdown 文档。`supervisor_report` 读取计划与最新断点，仅当该断点固定了仓库且调用提供了 `baseCommit` 时，才向任务状态组件的 git 运行器索取 `diffStat`，并通过原子写入器按任务一个目录写入报告。

### 聊天路由

`ChatBridge.start()` 订阅传输并解析每条入站消息；`notify` 把被拒绝的发送变成 `false`，因此断开的传输不会让只想通知的步骤失败。默认路由向不同的终端所有者发送 steer；已销毁或正忙的 agent 拒绝 steer 会被丢弃，因为传输已经向发送者确认了该消息。

### 关机闸门

`shutdownDecision` 在 `enabled` 为 false 时拒绝，在去除空白后的 `command` 为空时拒绝，并对 `all-tasks-completed` 强制检查自记录完成时间起的宽限期。工具在该决策之前还会多做一项检查：每个已存计划都不能有既非 `completed` 也非 `skipped` 的子任务。该决策只报告运维命令；本包没有任何代码会执行它。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [受监督终端包](../supervisor/README.zh.md)——6 个组件行与挂载它们的 profile。
- [受监督终端核心](../supervisor-core/README.zh.md)——拥有会话、计划与所有共享路径的控制平面。
- [任务状态组件](../supervisor-tasks/README.zh.md)——交付报告所汇总的断点与 git 运行器。
- [受监督终端子系统](../../../docs/subsystems/supervisor.zh.md)——消费者读取的持久记录与检测事实。
- [工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-supervisor-ops)——4 个工具生成的 schema 与结果字段。
- [配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-supervisor-ops)——每个可接受字段的穷尽式真源。
- [受监督终端插件 Agent Note](../../../.agents/notes/implemented/architecture/2026-10-06-supervised-terminal-plugin.zh.md)——为什么监督是可选包而不是循环机制。

-----

<a id="model-experience"></a>
## 模型体验

### `supervisor_budget`

#### 模型看到什么

schema 携带描述“Record what one hosted agent reported spending and read the running totals against the task and daily budgets. Record after every settlement that names a token count, and check the status before starting another expensive step.”以及参数 `action`（`record` 或 `status`）、`text`、`tokens`、`model` 与 `costUSD`，[工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-supervisor-ops)逐字列出它们。结果携带 `recorded`、`taskUSD`、`dailyUSD`、`alert`、`exceeded`、`onExceed` 与 `entries`，当调用命名或解析出 token 数时还有 `tokens`，并渲染为 `task $0.0000 / day $0.0000 (0 record(s))`，账本报告时附加 `near limit` 或 `EXCEEDED`。

#### Token 影响

组件加载期间每次请求都有固定 schema 成本，外加每次调用一个很小的结果；渲染行保留 4 位小数，因此不足 1 分的花费不会被报告为 `$0.00`。

#### KV Cache 影响

仅追加。schema 文本不变时会延长可复用前缀，每个结果都是新的尾部消息。

### `supervisor_notify`

#### 模型看到什么

schema 携带描述“Push one notification to a chat conversation through the transport the deployment registered. Use it for completion, abnormal endings, budget alerts, and to ask a human a question the run cannot answer itself.”以及参数 `chatId`、`event`（`task-completed`、`task-abnormal`、`budget-alert`、`checkpoint-taken`、`limit-paused` 之一）、`taskId` 与 `detail`。结果携带 `delivered`、渲染后的 `text`，未送达时还有 `reason`，并渲染为 `sent: <文本>` 或 `not sent: <原因>`。

#### Token 影响

组件加载期间有固定 schema 成本，外加每次调用一个很短的结果；通知文本本身与传输发送的文本一致。

#### KV Cache 影响

仅追加，且以模型调用该工具为条件；结果从不改写先前的请求 token。

### `supervisor_shutdown`

#### 模型看到什么

schema 携带描述“Decide whether the machine may be shut down now. The plugin never runs the command itself: it reports the operator-configured command and whether this trigger permits it, so a deployment decides what to execute.”以及参数 `trigger`（`all-tasks-completed`、`scheduled-time`、`idle-timeout` 之一）与 `lastTaskFinishedAt`。结果携带 `allowed`、仅在允许时出现的 `command`，以及供审计追踪的 `reason` 句子，并渲染为 `shutdown allowed: <命令>` 或 `shutdown refused: <原因>`。

#### Token 影响

组件加载期间有固定 schema 成本，外加每次调用一个很短的结果；原因句子是围绕配置的宽限期与任务 id 的固定模板。

#### KV Cache 影响

仅追加，且以模型调用该工具为条件。

### `supervisor_report`

#### 模型看到什么

schema 携带描述“Render and store the delivery report for a finished task. The deterministic sections come from the stored plan, checkpoints, and git statistics; supply the review summary and follow-ups yourself.”以及参数 `taskId`、`title`、`outcome`（`completed`、`partial` 或 `aborted`）、`startedAt`、`baseCommit`、`reviewSummary`、`followUps` 与 `rollback`。结果携带 `path`、完整 `markdown`，以及 diff 总计 `filesAdded`、`filesModified`、`filesDeleted`、`linesInserted` 与 `linesDeleted`，并渲染为 `report written to <路径>` 加上行数与文件数总计。报告正文由本包用中文生成；其章节标题与字段标签是稳定的：

##### 报告标题与标签原文

```markdown
# 任务交付报告：<title>

## 任务概述
- 任务 ID：<taskId>
- 目标：<goal 或 "(未记录计划)">
- 结果：<✅ 已完成 | ⚠️ 部分完成 | ⛔ 已终止>
- 完成时间：<ISO 时间戳>

## 子任务完成情况
| 子任务 | 建议 Agent | 状态 | 依赖 |

## 变更摘要
- 新增文件：<n> 个
- 修改文件：<n> 个
- 删除文件：<n> 个
- 代码行数：+<n> / -<n>

## 审查结果
## 验收标准对照
## 费用统计
## 断点与回滚
## 后续建议
```

#### Token 影响

条件性，且是 4 个工具中最大的结果：`markdown` 是完整渲染的报告——计划目标、子任务表、变更摘要、审查文本、验收标准表、花费、断点与后续建议——因此会保留在会话历史中直到压缩。

#### KV Cache 影响

仅追加；报告是新的尾部消息，从不改写请求前缀，但其体量使它成为 4 个结果中携带成本最高的一个。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些是当前包约束，不是任务积压。

- **用量账本保存在内存中**——花费不写入状态目录，因此进程重启后从零开始，`dailyUSD` 取决于模型是否重新记录它仍知道的结算。
- **不附带聊天通信线路**——`useChatTransport` 是接口面，在部署注册传输之前，`supervisor_notify` 返回 `delivered: false` 与 `no chat transport is registered in this deployment`。
- **关机命令只被报告，绝不执行**——`supervisor_shutdown` 只回答运维配置的命令是否可执行；仍需部署去执行它，而在 `enabled: false` 或命令为空时它总是拒绝。
- **只汇总最新断点**——变更摘要比较 `baseCommit` 与最新断点的提交，因此该断点之后提交的工作只能通过更晚的断点进入报告。
- **花费的准确度取决于模型记录的内容**——没有任何东西观察供应商计费，且价格表中没有匹配条目的 token 数按零计入。

-----

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

保持 4 个工具的确定性。新的运维行为属于本服务及其中的某个 schema 家族，而不是 agent 循环；任何必须决定运行下一步做什么的东西都属于监督模型，任何持久化的东西都属于控制平面或任务状态组件。`src/index.ts` 中的聊天路由是聊天连接器挂载所经的文档化扩展点，因此部署特有的通信线路是传给 `useChatTransport` 的传输，绝不是这里新增的 import。

</details>

**运行时不变式：** 不发布伴生入口。4 个工具只记录模型提供的事实，或渲染已组合存储本来就持有的事实，因此不存在可供第二次观察反驳的所属关系。
