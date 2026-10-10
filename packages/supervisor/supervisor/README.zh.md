---
description: "把受管终端控制面作为六个可独立开关的组件安装。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-supervisor

[English](README.md) | 中文

## 概述

这个可选 bundle 监管无人值守的长任务：把外部 CLI Agent 托管进终端，把其输出变成确定性的停滞证据，并让计划、断点与报告跨模型回合持久留存。六个组件一起交付，且每个都可以单独关停。发行版 profile 默认不启用它。

## 目录

- [使用本 bundle](#use-this-bundle)
- [组件](#components)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-bundle"></a>
## 使用本 bundle

在运行中应用的**插件（Plugins）页**安装（Add plugin，然后填绝对目录或包名），或从命令行安装：`dsh plugin --profile <名称> add <spec>`。安装会写入一个 `link:` 依赖、把本 bundle 追加进 `dsh.profile.bundles` 并启用它。此后插件页只列出一个条目——受管终端——其下是六个组件。Electron 桌面端 profile 由桌面应用独占管理，请在它的插件页里安装，不要用命令行。

挂载本 bundle 的组装还必须挂载宿主层的终端栈，因为 bundle 只托管 CLI Agent，自己从不打开终端：

```yaml
- insert:
    - id: pty
      name: '@deepseek-ai/dsh-terminal'
    - id: terminal-bash
      name: '@deepseek-ai/dsh-terminal-bash'
      config:
        shellDialect: pwsh
    - id: tool-terminal
      name: '@deepseek-ai/dsh-tool-terminal'
```

缺少这些行时，核心组件会因缺少服务一直停在 pending，一个工具都不会注册；除启动日志里的一条告警外没有任何其他提示。

记录路径写在 profile 补丁里，因为六个行共用同一个状态目录：

```yaml
- id: supervisor
  config:
    stateDir: '/absolute/path/to/state'
    workspaceDir: '/absolute/path/to/workspace'
```

两个路径都请写绝对路径。不写时 `stateDir` 会解析为进程工作目录下的 `.supervisor`——对桌面应用而言就是 profile 目录本身——在那里取断点会提交包含该 profile 的仓库。

每一行都适用两条规则：补丁会**整份替换**目标行的 `config` 而非合并，所以要保留的键必须一起重述；上面的行 id 是 profile 补丁能触及组件的唯一句柄。

在插件页关掉某个组件，只会在下一次请求里移除它的工具，另外五个照常工作；关掉 bundle 本身那一行则什么都不挂载。

当任务会跨越多个模型回合、且必须有人察觉被托管 Agent 何时停止推进时——通宵编码、反复触发限流的批处理，或需要可靠续跑点的工作——就用这个 bundle。单条短命令不必用它：`bash` 工具已经能执行并返回输出。

-----

<a id="components"></a>
## 组件

| 行 id | 包 | 它负责的内容 | 工具 |
|---|---|---|---|
| `supervisor` | `@deepseek-ai/dsh-supervisor-core` | 受管会话登记表、确定性的 L1 检测管线、心跳、输出日志、任务计划存储与心跳看门狗 | `supervisor_agent_launch`、`supervisor_terminal_send`、`supervisor_terminal_run`、`supervisor_terminal_read`、`supervisor_terminal_signal`、`supervisor_status` |
| `supervisor-tasks` | `@deepseek-ai/dsh-supervisor-tasks` | 带子任务图的计划编写、带保留策略的 git 断点，以及带返工说明的评审工单 | `supervisor_plan`、`supervisor_checkpoint`、`supervisor_review`、`supervisor_issue` |
| `supervisor-orchestration` | `@deepseek-ai/dsh-supervisor-orchestration` | 按 Agent 类型的技能清单、按阶段切换模型、worktree 隔离与有上限的并行派发 | `supervisor_skills`、`supervisor_agent_switch`、`supervisor_worktree`、`supervisor_dispatch` |
| `supervisor-ops` | `@deepseek-ai/dsh-supervisor-ops` | 用量预算、交付报告、聊天通知，以及关停闸门 | `supervisor_budget`、`supervisor_notify`、`supervisor_shutdown`、`supervisor_report` |
| `supervisor-pacing` | `@deepseek-ai/dsh-supervisor-pacing` | 监工 Agent 自身的自动起搏：自身模型请求失败后按声明的重置时刻或有界退避等待，重新武装被失败解除的目标（goal），再唤醒 Agent 继续一个回合 | *（不注册工具）* |
| `supervisor-shutdown` | `@deepseek-ai/dsh-supervisor-shutdown` | 运行结束后执行操作者配置的关机命令：墙钟或倒计时定时、所有任务计划完成即触发、空闲超时、截止前的聊天提醒、取消路径，以及只报告将执行什么的干跑模式 | `supervisor_power` |

核心组件是唯一必需的一个：它发布 `ctx.supervisor` 并注册六个终端工具。`supervisor-tasks` 出于同样理由发布 `ctx.supervisorTasks`，`supervisor-ops` 发布 `ctx.supervisorOps`。起搏与关机不发布任何服务：`supervisor-pacing` 观察 harness 自身的回合，不注册自己的工具；`supervisor-shutdown` 读取运维门禁与控制面的计划，并通过 `ctx.shell` 执行操作者的命令。

### 再添加一个组件

新增一项能力等于：在 `packages/supervisor/` 下新建一个包、在本 bundle 的 `cordis.patch.yml` 里加一行 `insert`、并在本包的 `dependencies` 里加一条。之后插件页就会把它当作又一个组件渲染，带着它自己的标题、简介、图标和开关——组件行继承的是它所指名的包自己的展示元数据：`locale/en.json` 与 `locale/zh.json` 的 `meta.title` / `meta.description`，以及包顶层的 `icon`。

新组件通过已发布的服务读取共享状态，而不是导入另一个组件的模块：`ctx.supervisor` 提供会话、检测、心跳、输出日志与计划；`ctx.supervisorTasks` 提供断点、工单与 git 操作；`ctx.supervisorOps` 提供预算账本与聊天通道。需要哪些就写进 `inject`。只由该组件读取的设置留在它自己的 `Config` 模式里，而 `stateDir`、`workspaceDir`、`worktreeBase` 一律取自 `ctx.supervisor.config`，让状态目录始终只有一个权威来源。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>维护者细节——点击展开</summary>

### 组装

`cordis.patch.yml` 按上表顺序插入六行。层序为 bundle 行、profile 补丁、home 补丁、命令行 overlay，因此 profile 可以按行 id 配置或关闭任一组件，而不必重述它的兄弟行。每个组件都是普通的 Cordis 插件：核心、计划与运维组件默认导出服务类，编排、起搏与关机是函数插件。

### 配置归属

组件按它们划分状态的方式划分配置。核心拥有被一个以上组件共用的每一条路径与每一个阈值——`stateDir`、`workspaceDir`、`worktreeBase`、各 Agent 模板、检测阈值、熔断上限、spill 与看门狗设置。计划组件拥有断点保留策略与每张工单的返工预算；编排组件拥有模型规则、技能根目录、worktree 分支前缀与派发并发；运维组件拥有预算、价格表与关停策略。由此得出两条规则：被两个组件读取的设置放在核心并从 `ctx.supervisor.config` 读取；每个组件自己的 `Config` 模式是它私有设置出现的唯一位置。

### 为什么不发布不变量伴随模块

不发布不变量伴随模块：这些组件给出的每一项结论，要么是状态目录下一份自描述的记录，要么是由一次结算推导出的值，消费者可以用同样的输入重新推导，不存在会互相矛盾的第二种观测。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [受管终端子系统](../../../docs/subsystems/supervisor.zh.md) — 消费者会读到的标记、规则命中、计划子任务与存储记录。
- [终端会话子系统](../../../docs/subsystems/terminal.zh.md) — 每个组件都要驱动的 PTY 服务，也是会话创建的唯一所有者。
- [受管终端作为插件的 Agent Note](../../../.agents/notes/implemented/architecture/2026-10-06-supervised-terminal-plugin.zh.md) — 为什么监管是可选插件而不是 agent 循环机制。
- [终端工具](../../terminal/tool-terminal/README.zh.md) — 核心组件依赖的 `terminal_open`、`terminal_list` 等 harness 管辖的终端接口。

-----

<a id="model-experience"></a>
## 模型体验

Indirectly, through the six component packages that own every tool schema, tool result, and prompt contribution.

#### KV Cache effect

No direct effect; each component owns its own request contributions and names the conditions that invalidate reuse.

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- **bundle 从不打开终端** — 它通过 `ctx.terminals` 驱动终端，因此没有终端后端的组装会让核心组件停在 pending、一个工具都不注册；插件页会把该行显示为未运行，而不是让加载显式报错。
- **六个组件默认一起加载** — 只想要核心的操作者按 profile 关掉另外五个；bundle 本身不表达"部分默认"。
- **不发聊天通道提供方** — `ctx.supervisorOps` 发布通道接缝并拥有入站路由，但不注册任何通道，因此在部署方自己接上链路之前，`supervisor_notify` 会报告未注册。
- **六个组件共用一个版本号** — 它们从本仓库一起发布，因此部署方无法把某个组件固定到与其兄弟不同的代次。

-----

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者细节——点击展开</summary>

每个组件的 README 记录它自己的服务、配置与工具；本页只负责组装方式、行 id，以及新增组件的规则。

</details>
