---
description: "受管运行的可持久任务状态：带子任务图的计划编写、带保留策略与可重启分支的 git 断点，以及把阻塞性发现推进成返工说明的评审工单。"
kind: "package-reference"
---

# @deepseek-ai/dsh-supervisor-tasks

[English](README.md) | 中文

## 概述

`supervisor-tasks` 是受管终端 bundle 中负责持久状态的组件。它把评审过的计划变成被中断的运行可以续跑的记录：拒绝子任务环依赖的计划编写、可重启分支上的 git 断点，以及把发现变成返工说明的评审工单。它发布 `supervisorTasks` 服务——断点、工单与 git 操作——并注册四个工具。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

通过承载它的 bundle —— [`@deepseek-ai/dsh-supervisor`](../supervisor/README.zh.md) —— 安装：在插件页安装，或执行 `dsh plugin --profile <名称> add <spec>`。本组件从 `ctx.supervisor.config` 读取 `stateDir` 与 `workspaceDir`，自身没有路径配置项；profile 里设置一次状态目录就同时配置了所有组件。

### 配置

profile 补丁按行 id `supervisor-tasks` 定位并**整份替换** `config`：

```yaml
- id: supervisor-tasks
  config:
    checkpointBranchPrefix: 'supervisor/'
    checkpointMaxPerTask: 10
    checkpointMaxAgeDays: 30
    maxRetriesPerIssue: 2
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `checkpointBranchPrefix` | `supervisor/` | 断点提交所在分支的前缀。 |
| `checkpointMaxPerTask` | `10` | 每个任务保留的断点数；超出时先删除最旧的。 |
| `checkpointMaxAgeDays` | `30` | 断点保留天数，超过即删除。 |
| `maxRetriesPerIssue` | `2` | 每张工单在升级前允许的返工次数。 |

### 工作循环

用 `supervisor_plan` 写下计划，在每个有意义的步骤用 `supervisor_checkpoint` 取一次断点；当某一轮工作需要判断时，用 `supervisor_review` 汇总证据、用 `supervisor_issue` 记录评审发现，然后让工单驱动返工，直到它解决或升级。`supervisor_checkpoint action restore` 会返回记录下来的终端状态，让续跑知道这个断点来自哪个终端与模型。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

### 本组件拥有什么、借用什么

计划存储、受管会话、输出日志与所有共享路径都属于控制面（`ctx.supervisor`），本组件只读取它们。它自己拥有断点存储（`checkpoints/<task>/<checkpointId>.json`）、评审工单（`tickets/<task>/<ticketId>.json`）、它们的保留策略，以及与需要 git 的组件共用的一个 `GitRunner`。

### 断点提交的是代码，不是状态

`supervisor_checkpoint` 从解析后的 `cwd` 解析仓库、移动 `<prefix><taskId>` 分支，并用 `git add -A` 暂存。当状态目录与 worktree 根目录位于该仓库内部时会被排除，因为 `restore` 会执行 `git reset --hard`：一旦状态目录进了提交，用较旧的断点恢复就会删除所有更新的计划、断点与工单。在仓库之外取的断点仍然记录任务、步骤与终端状态，只是没有 git 事实。

### 评审包与工单生命周期

`supervisor_review` 从四类证据组装一份 Markdown 材料包：带验收标准的计划、已取的断点、任务提交区间（`baseCommit` 到 `headCommit`，默认取最新断点的提交）的 diff，以及受管终端输出日志的一段有界尾部；缺失的计划、diff 或日志会被点名说明，而不是被略过。监工模型判断这份材料包，并用 `supervisor_issue` 记录发现。工单保存发现、回归范围与返工指示，并在 `open`、`in-redo`、`in-regression`、`resolved`、`escalated` 之间流转：`redo` 与 `regression-failed` 各消耗一次 `maxRetriesPerIssue` 配额，配额用尽即升级；`regression-passed` 使其解决；工单处于返工状态时结果会带一段 `redoBrief`，它不含代码围栏，因此粘进负责方 agent 的终端时不会被吞掉。严重度为 `blocking` 或 `high` 的发现就是结果里统计的阻塞集合。

### 为什么不发布不变量伴随模块

不发布不变量伴随模块：本组件写下的记录都是自描述文件，消费者可以用同样的输入重新推导其内容，不存在会互相矛盾的第二种观测。
</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [受管终端 bundle](../supervisor/README.zh.md) —— 六个组件与挂载它们的 profile 行。
- [受管终端核心](../supervisor-core/README.zh.md) —— 拥有会话、计划与全部共享路径的控制面。
- [受管终端子系统](../../../docs/subsystems/supervisor.zh.md) —— 消费者需要读取的计划子任务、断点与工单记录。

-----

<a id="model-experience"></a>
## 模型体验

### 工具 schema

#### What the model sees

本组件加载期间注册四个工具：`supervisor_plan`、`supervisor_checkpoint`、`supervisor_review`、`supervisor_issue`。它们的参数与说明列在生成的[工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-supervisor-tasks)中。`supervisor_plan` 与 `supervisor_issue` 的输入 schema 是整个 bundle 里最大的两个，因为计划文档与发现列表都是嵌套对象。

#### Token effect

固定开销：只要组件处于加载状态，这四个 schema 就出现在每个请求里，无论模型是否调用它们。加载或卸载该组件会新增或替换这一块。

#### KV Cache effect

仅追加。schema 文本由属主稳定维护，因此扩展的是可复用前缀，而不是替换更早的请求 token。改动任一工具说明或参数都会改变请求前缀，并从该点起使复用失效。

### 工具结果

#### What the model sees

`supervisor_plan` 返回已存计划、当前可启动的子任务（`readyToStart`），以及依赖边是否构成 DAG（`cycleDetected`）。`supervisor_checkpoint` 始终以字符串形式返回 `checkpointId` 与 `commitHash`（该动作没有对应值时为空串），`restore` 时另附记录下来的终端状态。`supervisor_review` 返回材料包的 `markdown`，以及断点数与验收标准数、diff 与输出尾部是否被包含。`supervisor_issue` 返回工单 id、状态、相对配额的重试次数、阻塞性发现数量、发现列表，以及工单处于返工状态时的 `redoBrief`。

#### Token effect

条件性：只有模型调用这些工具时才会看到这一块。评审包把一段有界日志尾部内联进 Markdown，而返工说明的用途是粘进终端，不是作为结果阅读。

#### KV Cache effect

仅追加。结果是新的尾部消息，从不重写更早的请求 token，因此扩展的是已可复用的前缀，而不是使其失效。

### 返工说明

#### What the model sees

工单处于返工状态时，`supervisor_issue` 返回一段给负责方 agent 的说明，它不含代码围栏，因此粘进终端时不会被围栏吞掉：

##### Verbatim text for this field, when needed

```markdown
Redo ticket <ticketId> for task <taskId>

Status: <status>; retry <retryCount> of <maxRetries>

Instructions:
<redoInstructions or "(none given)">

Findings to repair:
- [<severity>] <title>: <suggestedFix>

Regression checks that must pass:
- <check>
```

#### Token effect

条件性：每张处于返工状态且重试配额尚未用尽的工单一段说明。

#### KV Cache effect

仅追加。说明是新的工具结果的一部分，因此扩展可复用前缀，而不是替换更早的 token。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- **断点提交的是配置好的工作区** —— 仓库在每次调用时从解析后的 `cwd` 解析一次，因此对着错误 `workspaceDir` 取断点会移动那个仓库的 HEAD。状态目录与 worktree 根目录位于其中时会被排除在提交之外。
- **计划存储本身在控制面** —— `supervisor_plan` 通过 `ctx.supervisor.plans` 写入，因此只挂载本组件而不挂控制面的组装无法加载。
- **工单会升级而不是阻塞** —— 用尽 `maxRetriesPerIssue` 的工单只报告 `escalated`；没有任何东西会自行停止运行或删除失败子任务的 worktree。
- **评审证据是有界的** —— 材料包只带输出日志的一段有界尾部与某个提交区间的 diff，因此更早的区间或外部产物需要通过各自的工具去读。

-----

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

`record-file.ts` 保存按任务分文件的 JSON 记录读写助手；新增记录类型应放在 `checkpoint.ts` 与 `review.ts` 旁边，而不是塞进工具文件。git 执行器通过本组件的服务与编排、运维组件共用，因此新增 git 操作加在这里。

</details>
