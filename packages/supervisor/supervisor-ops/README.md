---
description: "Usage budgets with per-model price tables and a downgrade-or-stop policy, delivery reports assembled from plans, checkpoints and diffs, chat notifications over a deployment-supplied transport, and a shutdown gate that never runs the command itself."
kind: "package-reference"
---

# @deepseek-ai/dsh-supervisor-ops

English | [中文](README.zh.md)

## Summary

Mount `dsh-supervisor-ops` when a supervised run must stay inside a spend limit, report what it delivered, or reach a human. It publishes `ctx.supervisorOps`: a ledger that prices token counts from the configured table, reports `alert` and `exceeded` against the task and daily budgets, and restarts its task window when the supervised terminals switch tasks; a delivery-report store under the shared state directory; a chat bridge that steers terminal owners; and a shutdown decision that reports an operator command without running it. The four tools only record what the model reports; `supervisor_notify` reports that no transport is registered.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount it beside the control plane and the task-state component whenever the supervising model must track spend, write a delivery report, reach a human, or decide that the machine may power off.

### When to choose it

Choose this component with `@deepseek-ai/dsh-supervisor-core` and `@deepseek-ai/dsh-supervisor-tasks` when a run has a dollar ceiling, when a finished task needs a durable report assembled from the plan, the checkpoints, and the diff, when an operator wants completion or budget events pushed to a chat conversation, or when the machine should only power off after every task finished. Skip it for a single short task and for compositions that already account for spend elsewhere: the bundle's other five components keep working without it, and nothing in this package observes provider billing on its own.

### Minimal configuration

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

The component reads `stateDir` from `ctx.supervisor.config`, so it has no path of its own and writes reports under the shared state directory. Every field is a subset of the generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-supervisor-ops).

| Field | Default | Meaning |
|---|---|---|
| `budget.taskBudgetUSD` | `5` | Dollars allowed for one task. |
| `budget.dailyBudgetUSD` | `20` | Dollars allowed per local calendar day. |
| `budget.alertThresholdPct` | `80` | Percentage of either budget at which the ledger reports `alert`. |
| `budget.onExceed` | `downgrade-all` | Action reported once a budget is exceeded; `downgrade-all` or `stop-task`. |
| `modelPrices` | `[]` | Entries of `{ model, usdPerMillionTokens }` that a recorded token count is priced against. |
| `shutdown.enabled` | `false` | Whether a shutdown may ever be allowed. |
| `shutdown.command` | `''` | Operator-supplied command reported when a shutdown is allowed. |
| `shutdown.gracePeriodMin` | `5` | Minutes that must elapse after the recorded last task finish for `all-tasks-completed`. |

### The four tools

| Tool | What it does | Result fields |
|---|---|---|
| `supervisor_budget` | Records one usage observation (`record`) or reads the running totals (`status`) | `recorded`, `tokens`, `taskUSD`, `dailyUSD`, `alert`, `exceeded`, `onExceed`, `entries` |
| `supervisor_notify` | Renders one event notification and pushes it to a conversation through the registered transport | `delivered`, `text`, `reason` |
| `supervisor_shutdown` | Decides whether the configured command may run for one trigger, after checking the stored plans and the grace period | `allowed`, `command`, `reason` |
| `supervisor_report` | Renders the delivery report from the stored plan, the checkpoints, and git statistics, and writes it under the state directory | `path`, `markdown`, `filesAdded`, `filesModified`, `filesDeleted`, `linesInserted`, `linesDeleted` |

### Chat transport

`useChatTransport(transport, handler?)` registers the deployment's wire. The plugin owns the default routing: an inbound message reaches every distinct agent that owns a supervised terminal as a `[chat] <sender>: <text>` steer, so a human can ask for status or redirect the run from the chat. A deployment that supplies `handler` takes over that job; the returned disposer unsubscribes and forgets the transport only while it is still the newest one. `chat` exposes the registered `ChatBridge`.

### Budget policy

Cost resolves in order: an explicit `costUSD` on the call, the configured `modelPrices` entry for the named `model`, otherwise zero. `alertThresholdPct` sets the `alert` flag, the two budgets set `exceeded`, and `onExceed` is the action the model is told to apply once a budget is exceeded; the ledger itself never stops or downgrades anything.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### What this component owns, and what it borrows

Plans, supervised sessions, output logs, checkpoints, and git belong to the control plane and the task-state component; this component reads them through `ctx.supervisor` and `ctx.supervisorTasks` and declares both in `inject` beside `tools`. It owns the in-memory usage ledger, the chat bridge, the budget, price, and shutdown configuration, the four tools, and one directory of durable reports: `deliverables/<taskId>/report.md` under the shared state directory.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | The `supervisorOps` service: resolved configuration, ledger, reports, chat bridge, and tool registration |
| [`src/tools.ts`](src/tools.ts) | The four tool schemas, renders, executors, and the plan-completeness check |
| [`src/budget.ts`](src/budget.ts) | `UsageLedger`, the price-table lookup, usage parsing, and cost estimation |
| [`src/feishu.ts`](src/feishu.ts) | The chat transport seam, command parsing, and notification rendering |
| [`src/report.ts`](src/report.ts) | Markdown report rendering and the per-task report store |
| [`src/shutdown.ts`](src/shutdown.ts) | The shutdown policy and the allowed-or-refused decision |

### The budget ledger

`UsageLedger` keeps every observation in order with the dollars it was priced at record time, so a later price-table edit cannot rewrite an already reported total. `status(now)` sums the entries at or after the current task start into `taskUSD` and every entry on the same local calendar day into `dailyUSD`; `resetTask()` drops the task's spend while keeping the day's. The service owns the window: before it records or reports, it reads the task id every task-bound supervised terminal agrees on, calls `resetTask()` when that id differs from the window's task, and leaves the window alone while the terminals name no task or disagree — so a report written after the terminals were forgotten still shows the finished task's spend. The constructor re-validates the policy, so a hand-built ledger cannot hold a budget that could never trigger.

### Delivery reports

`renderReport` assembles one Markdown document from stored facts — the plan with its acceptance criteria, the checkpoints, the diff statistics, the ledger status — plus the review summary, follow-ups, and rollback the model supplies. `supervisor_report` reads the plan and the newest checkpoint, asks the task-state component's git runner for `diffStat` only when that checkpoint pinned a repository and a `baseCommit` was supplied, and writes the report through the atomic writer, one directory per task.

### Chat routing

`ChatBridge.start()` subscribes to the transport and parses every inbound message; `notify` turns a rejected send into `false` so a disconnected transport cannot fail a step that only wanted to notify. The default routing steers the distinct terminal owners, and a disposed or busy agent's rejected steer is dropped because the transport already acknowledged the message to its sender.

### The shutdown gate

`shutdownDecision` refuses while `enabled` is false, refuses an empty trimmed `command`, and for `all-tasks-completed` enforces the grace period since the recorded finish time. The tool adds one check before that decision: every stored plan must have no subtask that is neither `completed` nor `skipped`. The decision reports the operator's command; nothing in this package executes it.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Supervised terminals bundle](../supervisor/README.md) — the six component rows and the profile that mounts them.
- [Supervised terminal core](../supervisor-core/README.md) — the control plane that owns sessions, plans, and every shared path this component reads.
- [Task-state component](../supervisor-tasks/README.md) — the checkpoints and git runner the delivery report summarizes.
- [Supervised terminals subsystem](../../../docs/subsystems/supervisor.md) — the stored records and detection facts a consumer reads.
- [Tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-supervisor-ops) — the generated schemas and result fields of the four tools.
- [Configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-supervisor-ops) — the exhaustive source for every accepted field.
- [Supervised terminals as a plugin Agent Note](../../../.agents/notes/implemented/architecture/2026-10-06-supervised-terminal-plugin.md) — why supervision is an opt-in bundle rather than loop machinery.

-----

<a id="model-experience"></a>
## Model Experience

### `supervisor_budget`

#### What the model sees

The schema carries the description "Record what one hosted agent reported spending and read the running totals against the task and daily budgets. Record after every settlement that names a token count, and check the status before starting another expensive step." and the parameters `action` (`record` or `status`), `text`, `tokens`, `model`, and `costUSD`, quoted verbatim in the [tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-supervisor-ops). The result carries `recorded`, `taskUSD`, `dailyUSD`, `alert`, `exceeded`, `onExceed`, and `entries`, plus `tokens` when the call named or parsed one, and renders as `task $0.0000 / day $0.0000 (0 record(s))` with `near limit` or `EXCEEDED` added when the ledger reports it.

#### Token effect

Fixed schema cost on every request while the component is loaded, plus one small result per call; the rendered line carries four decimals so a sub-cent settlement is not reported as `$0.00`.

#### KV Cache effect

Append-only. The schema text extends a reusable prefix while it is unchanged, and each result is a new trailing message.

### `supervisor_notify`

#### What the model sees

The schema carries the description "Push one notification to a chat conversation through the transport the deployment registered. Use it for completion, abnormal endings, budget alerts, and to ask a human a question the run cannot answer itself." and the parameters `chatId`, `event` (one of `task-completed`, `task-abnormal`, `budget-alert`, `checkpoint-taken`, `limit-paused`), `taskId`, and `detail`. The result carries `delivered`, the rendered `text`, and a `reason` when nothing was delivered, and renders as `sent: <text>` or `not sent: <reason>`.

#### Token effect

Fixed schema cost while the component is loaded, plus one short result per call; the notification text itself is the same text the transport sends.

#### KV Cache effect

Append-only, and conditional on the model calling the tool; a result never rewrites earlier request tokens.

### `supervisor_shutdown`

#### What the model sees

The schema carries the description "Decide whether the machine may be shut down now. The plugin never runs the command itself: it reports the operator-configured command and whether this trigger permits it, so a deployment decides what to execute." and the parameters `trigger` (one of `all-tasks-completed`, `scheduled-time`, `idle-timeout`) and `lastTaskFinishedAt`. The result carries `allowed`, `command` only when allowed, and a `reason` sentence for the audit trail, and renders as `shutdown allowed: <command>` or `shutdown refused: <reason>`.

#### Token effect

Fixed schema cost while the component is loaded, plus one short result per call; the reason sentence is a fixed template over the configured grace period and task ids.

#### KV Cache effect

Append-only, and conditional on the model calling the tool.

### `supervisor_report`

#### What the model sees

The schema carries the description "Render and store the delivery report for a finished task. The deterministic sections come from the stored plan, checkpoints, and git statistics; supply the review summary and follow-ups yourself." and the parameters `taskId`, `title`, `outcome` (`completed`, `partial`, or `aborted`), `startedAt`, `baseCommit`, `reviewSummary`, `followUps`, and `rollback`. The result carries `path`, the full `markdown`, and the diff totals `filesAdded`, `filesModified`, `filesDeleted`, `linesInserted`, and `linesDeleted`, and renders as `report written to <path>` plus the line and file totals. The report body is generated by this package in Chinese; its section headings and field labels are stable:

##### Verbatim report headings and labels

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

#### Token effect

Conditional and the largest result of the four: `markdown` is the complete rendered report — plan goal, subtask table, change summary, review text, acceptance-criteria table, spend, checkpoints, and follow-ups — so it stays in session history until compaction.

#### KV Cache effect

Append-only; the report is a new trailing message and never rewrites the request prefix, but its size makes it the most expensive of the four results to carry.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These are current package constraints, not a task backlog.

- **The usage ledger is in memory** — spend is not written to the state directory, so a restarted process starts from zero and `dailyUSD` depends on the model re-recording settlements it still knows about.
- **No chat wire is shipped** — `useChatTransport` is a seam, and until a deployment registers a transport `supervisor_notify` returns `delivered: false` with `no chat transport is registered in this deployment`.
- **The shutdown command is reported, never executed** — `supervisor_shutdown` only answers whether the operator-configured command may run; a deployment must still run it, and with `enabled: false` or an empty command it always refuses.
- **Only the newest checkpoint is summarized** — the change summary diffs `baseCommit` against the newest checkpoint's commit, so work committed after that checkpoint enters the report only through a later checkpoint.
- **Spend is only as accurate as what the model records** — nothing observes provider billing, and a token count with no matching price-table entry contributes zero.

-----

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Keep the four tools deterministic. A new operations behavior belongs on this service and one of these schema families, not on the agent loop; anything that must decide what the run does next belongs to the supervising model, and anything durable belongs to the control plane or the task-state component. The chat routing in `src/index.ts` is the documented extension point a chat connector mounts through, so a deployment-specific wire is a transport passed to `useChatTransport`, never a new import here.

</details>

**Runtime invariant:** No companion is published. The four tools only record or render facts the model supplies or the composed stores already hold, so no owned relationship exists for a second observation to contradict.
