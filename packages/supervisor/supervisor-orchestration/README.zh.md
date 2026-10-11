---
description: "让受管长任务持续推进：按 Agent 类型的技能清单与匹配、通过被托管 CLI 按阶段切换模型、用 git worktree 隔离并行子任务，以及有并发上限的并行派发。"
kind: "package-reference"
---

# @deepseek-ai/dsh-supervisor-orchestration

[English](README.md) | 中文

## 概述

`supervisor-orchestration` 是受管终端 bundle 中偏调度形态的组件。它扫描各被托管 CLI 自己的技能根目录、通过该 CLI 的会话内命令按任务阶段切换模型、为每个并行子任务分配独立 git worktree，并报告当前并发上限允许启动的下一批子任务。它不发布服务：它针对 `ctx.supervisor`（控制面）与 `ctx.supervisorTasks`（git 操作）注册四个工具。

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

通过承载它的 bundle —— [`@deepseek-ai/dsh-supervisor`](../supervisor/README.zh.md) —— 安装：在插件页安装，或执行 `dsh plugin --profile <名称> add <spec>`。本组件挂载在控制面与任务服务之上，并从 `ctx.supervisor.config` 读取 `stateDir`、`workspaceDir` 与 `worktreeBase`，因此它本身没有需要配置的路径。

### 配置

profile 补丁按行 id `supervisor-orchestration` 定位并**整份替换** `config`：

```yaml
- id: supervisor-orchestration
  config:
    modelRules:
      - phases: [planning, reasoning]
        model: opus
        fallbackModels: [sonnet]
    skillRoots:
      homeDir: '/home/operator'
      workspaceDir: '/path/to/workspace'
    maxConcurrency: 4
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `modelRules` | 无 | 供 `supervisor_agent_switch` 使用的阶段到模型规则；每条规则列出它覆盖的阶段、模型与可选 `fallbackModels`。出现未知阶段、同一阶段被两条规则占用或模型为空都会拒绝加载。 |
| `skillRoots.homeDir` | 操作系统主目录 | 各 agent 的"主目录技能根"所相对解析的目录。 |
| `skillRoots.workspaceDir` | 控制面的 `workspaceDir` | 各 agent 的"项目本地技能根"所相对解析的目录。 |
| `worktreeBranchPrefix` | `supervisor/` | 每个 worktree 检出的分支前缀。 |
| `maxConcurrency` | `4` | `supervisor_dispatch` 可一次报告为可启动的子任务数上限。 |

### 各 Agent 类型的技能根

`supervisor_skills` 读取各类型自己的目录布局，而不是一个共用目录：Claude Code 用 `<home>/.claude/skills` 与 `<workspace>/.claude/skills`，Codex 用 `.codex` 下的同样两个，`kimi-code`、`qwen-code`、`trae` 用 `<home>/.<kind>/skills`，`dsh` 用 `<workspace>/.agents/skills` 以及 `<workspace>/cordis.yml` 中声明的 `@deepseek-ai/dsh-skill-<name>` 包。缺失或不可读的根会被跳过；某个 agent 没有任何可读根时报告 `available: false`，而不是让扫描失败。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

### 按阶段切换模型

`switch.ts` 在加载时校验 `modelRules`，并把每个阶段解析为候选模型列表（最优先在前）。`switchCommands` 为每个候选渲染一次被托管 CLI 的 `modelSwitchCommand`——`{model}` 是唯一占位符，内部空白会被折叠，空白或含控制字符的候选会被跳过，重复的命令会被丢弃——工具按顺序发送每个候选，只有结算带有 `model-switch-fail` L1 命中时才继续下一个。模板为空或缺失时不产生任何命令，此时结果会说明必须用候选模型重新启动该 CLI。

### 技能清单

`skills.ts` 读取上面列出的根目录，把一个目录名视为一个技能（除 `dsh` 外，各类型也把一个 `.md` 文件的主文件名视为一个技能），并把每种 agent 类型一份清单缓存在控制面状态目录的 `skills/<agentKind>.json` 下，`action: list` 读的就是它。给出 `requiredSkills` 时，结果按各 agent 类型命中这些技能的数量排序（`matched` 与 `missing`），最佳匹配会附带一段可粘进启动提示的 `brief`。

### worktree、派发与集成

`WorktreeManager` 只登记配置根目录之下的 worktree，因此列表不会声称存在本组件未创建的 worktree；分支名重复被脱敏的 id，因此它始终指向交给 git 的那个路径。`supervisor_dispatch` 报告下一批：依赖已完成的待办子任务，减去 `active` 中传入的 id，受剩余并发槽位限制，并附上待办与阻塞计数。`integrate` 读取已存计划，按依赖顺序用 `git merge --no-ff` 在固定提交者身份下合并每个子任务分支，并在第一次失败处停止：`merged` 列出已落地的子任务，`failed` 指出让合并停止的那个。`integrationOrder` 按依赖优先排序，并在存在依赖环时抛错。

### 为什么不发布不变量伴随模块

不发布不变量伴随模块：本组件给出的每一项结论，要么是另一个组件拥有的记录，要么是由一次扫描或一次结算推导出的值，消费者可以用同样的输入重新推导，不存在会互相矛盾的第二种观测。
</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [受管终端 bundle](../supervisor/README.zh.md) —— 六个组件与挂载它们的 profile 行。
- [受管终端核心](../supervisor-core/README.zh.md) —— 本组件读取会话、计划与路径的控制面。
- [受管终端子系统](../../../docs/subsystems/supervisor.zh.md) —— 消费者需要读取的标记、规则命中、计划子任务与持久记录。
- [终端工具](../../terminal/tool-terminal/README.zh.md) —— `terminal_open`，会话创建的唯一归属者。

-----

<a id="model-experience"></a>
## 模型体验

### 工具 schema

#### What the model sees

本组件加载期间注册四个工具：`supervisor_skills`、`supervisor_agent_switch`、`supervisor_worktree`、`supervisor_dispatch`。它们的参数与说明列在生成的[工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-supervisor-orchestration)中。

#### Token effect

固定开销：只要组件处于加载状态，这四个 schema 就出现在每个请求里，无论模型是否调用它们。`supervisor_worktree` 的 schema 最大，因为它枚举 create/list/remove/integrate 四个动作及其参数。加载或卸载该组件会新增或替换这一块。

#### KV Cache effect

仅追加。schema 文本由属主稳定维护，因此扩展的是可复用前缀，而不是替换更早的请求 token。改动任一工具说明或参数都会改变请求前缀，并从该点起使复用失效。

### 工具结果

#### What the model sees

`supervisor_skills` 返回各 agent 类型的清单；给出 `requiredSkills` 时另附排序后的 `matched` 与 `missing`，以及一段启动提示用的 `brief`。`supervisor_agent_switch` 在最近一次结算字段之外返回 `switched`、被接受的命令 `model`、尝试过的全部命令 `attempted`，以及未切换时的 `reason`。`supervisor_worktree` 返回 worktree 路径与分支、已合并的 `merged` 子任务，以及让集成停止（`failed`）的那个子任务。`supervisor_dispatch` 返回可启动的 `batch`、待办与阻塞计数，以及配置的并发上限。`brief` 由本包用中文生成，每个命中的技能一行：

##### 启动提示 brief 的原文

```markdown
请使用以下技能完成：
- <skill>
```

#### Token effect

条件性：只有模型调用这些工具时才会看到这一块。技能 brief 受计划规模限制，worktree 列表受本组件创建的数量限制。

#### KV Cache effect

仅追加。结果是新的尾部消息，从不重写更早的请求 token，因此扩展的是已可复用的前缀，而不是使其失效。

### 模型切换被拒的证据

#### What the model sees

被托管 CLI 拒绝的每个候选命令都会向工具报告的结算贡献一条 `model-switch-fail` L1 命中，因此模型能看到 CLI 拒绝了哪些模型名：

##### Verbatim result text for this field, when needed

```markdown
switched to <model> via <candidate -> candidate>
not switched: every candidate model was rejected by the hosted CLI
```

#### Token effect

条件性，并受规则中候选数量限制：每个候选一次结算，且仅在模型请求切换时发生。

#### KV Cache effect

仅追加。每个被拒候选都会新增一条尾部工具结果，而不是重写上一条。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- **没有调度器** —— 没有任何东西按时钟启动任务；`supervisor_dispatch` 只报告下一步可以启动什么，由监工模型或操作者发起启动。
- **没有会话内切换命令的 CLI 必须重启** —— `supervisor_agent_switch` 只能发送配置好的 `modelSwitchCommand`，因此模板中没有该命令的 CLI 会被报告为需要用所选模型重新启动。
- **worktree 合并是串行的，并在第一次失败处停止** —— 集成按依赖顺序一次合并一个子任务分支，因此一次冲突会让其后所有分支保持未合并，重试集成前需要人工解决。
- **技能清单反映扫描时刻存在的根目录** —— `action: list` 读的是缓存，因此扫描之后安装的技能在下一次 `action: scan` 之前不可见。

-----

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本组件不拥有自己的持久记录：技能缓存是唯一例外，而它是缓存，不是事实来源。它的 git 操作来自 `ctx.supervisorTasks.git`，使 worktree、断点与评审 diff 共用同一个执行器。

</details>
