---
description: "在 harness 终端里托管 CLI Agent，并把其输出变成确定性证据：会话登记表、L1 检测管线、心跳、输出日志、任务计划存储与终端静默看门狗。"
kind: "package-reference"
---

# @deepseek-ai/dsh-supervisor-core

[English](README.md) | 中文

## 概述

`supervisor-core` 是受管终端 bundle 的控制面：它在 harness 已经打开的终端里托管外部 CLI Agent，让每一次结算都经过同一条检测管线，并保存被中断的运行所需持久记录。它向兄弟组件发布 `supervisor` 服务，并注册六个面向模型的工具。它自身不做判断：监工模型读取证据并作出决定。

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

通过承载它的 bundle —— [`@deepseek-ai/dsh-supervisor`](../supervisor/README.zh.md) —— 安装：在插件页安装，或执行 `dsh plugin --profile <名称> add <spec>`。挂载本组件的组装还必须挂载终端后端，因为它驱动终端却从不自己打开终端：先用 harness 的 `terminal_open` 打开终端，再用该会话 id 调用 `supervisor_agent_launch`，把受管 Agent 放进去。

### 配置

profile 补丁按行 id `supervisor` 定位并**整份替换** `config`，因此要保留的键必须一起重述：

```yaml
- id: supervisor
  config:
    stateDir: '/absolute/path/to/state'
    workspaceDir: '/absolute/path/to/workspace'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `stateDir` | `.supervisor` | 存放心跳、输出日志与计划的目录；相对路径相对 `workspaceDir` 解析。 |
| `workspaceDir` | `process.cwd()` | 状态目录与默认 worktree 根目录所相对解析的目录。 |
| `worktreeBase` | `.worktrees` | 各子任务 worktree 的创建位置；相对路径相对 `workspaceDir` 解析。编排组件会读取它。 |
| `agents` | 内置模板 | 各 Agent 类型的 `startCommand`、`resumeCommand` 与 `modelSwitchCommand`，在 `claude-code`、`codex`、`kimi-code`、`qwen-code`、`trae`、`dsh` 的默认值之上合并。 |
| `defaultProfile` | `headless` | 替换 `{profile}` 的值，`dsh` 模板会用到。 |
| `shellQuoting` | `posix`（Windows 上为 `powershell`） | 用于引用被替换的 `{prompt}` 与额外参数的方言。 |
| `rules` | 全部内置规则 | 每条规则的 `enabled`、`severity`，以及 `goal-drift-signal` 的字面量 `keywords`。 |
| `detection` | 见下 | 窗口规则的阈值，以及 `context-bloat` 的 `contextBloatBytes` 上界。 |
| `breaker` | `noProgressLimit` 2、`openLimit` 3、`cooldownSec` 300 | 每会话的进度熔断上限；`openLimit` 不得小于 `noProgressLimit`。 |
| `limitResumeEnabled` | `true` | 当结算输出中的限流消息带有可解析的重置时刻时，安排一次续跑。 |
| `spillEnabled` | `true` | 把每次观察到的结算追加到按终端区分的输出日志。 |
| `spillMaxBytes` | 5 GiB | 单个输出日志的字节上限；达到后停止记录并在结果中报告已达上限。 |
| `runTimeoutSec` | `600` | `supervisor_terminal_run` 等待完成标记的默认秒数。 |
| `runPollIntervalMs` | `500` | 轮询保留回滚缓冲中完成标记的毫秒间隔。 |
| `heartbeatTimeoutSec` | `300` | 终端静默多久后其心跳算作过期。 |
| `watchdogEnabled` | `true` | 受管终端过期时唤醒空闲 Agent。 |
| `watchdogIntervalSec` | `60` | 看门狗轮询间隔。 |
| `watchdogCooldownSec` | `300` | 同一终端两次看门狗通知之间的最短间隔。 |

检测阈值默认为 `errorStreakThreshold` 3、`repeatThreshold` 3、`repeatWindowMin` 5、`maxRestarts` 3、`crashWindowMin` 10、`contextBloatBytes` 50 KiB、`silenceThresholdSec` 30。

### 何时选用

当任务会跨越多个模型回合、且必须有人察觉被托管 Agent 何时停止推进时选它。在受管终端内，等待单条命令结束的可靠方式是 `supervisor_terminal_run`：它用唯一的 `DONE_<random>` 完成标记包裹命令，在 shell 内部组装该标记，使回显的命令本身无法匹配，然后轮询保留的回滚缓冲，直到标记行出现或超时。`supervisor_terminal_send` 只等待下一次安静的结算，因此无法区分"命令已完成"与"命令已暂停"。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

### 结算管线

所有产生结算的工具——`supervisor_agent_launch`、`supervisor_terminal_send` 与 `supervisor_terminal_run`——都把结算汇入 `SupervisorRuntime.observe`，这就是它们对同一终端报告一致标记、命中与心跳的原因。它更新心跳、把输出追加进 spill 日志、用无状态 L1 规则扫描文本、把归一化文本喂给按会话的滑动窗口、按被托管 Agent 的特征分类输出、推进进度熔断器，并推导状态标记。

`supervisor_terminal_read` 不产生结算，因此走 `SupervisorRuntime.inspect`：它扫描保留的回滚缓冲并分类，但既不推进心跳也不追加输出日志，因为对卡住终端的轮询绝不能算作进展。

### 输出分类

`adapter.ts` 为每种被托管 CLI 保存一套字面量模式，分为 waiting、active、error、completion 四组，并只报告一个 `outputClass`：`waiting-input`、`working`、`error`、`completed` 或 `unknown`。waiting 优先于 active，active 优先于 error，completion 排最后，因此活跃的提示符不会被误读成对话本来就在处理的失败。未声明 CLI 的终端只按所有 waiting 模式的并集分类。

### L1 规则

| 规则 | 机制 | 默认严重度 |
|---|---|---|
| `api-disconnect` | 传输层 errno 名称、HTTP 5xx 码与断开短语 | high |
| `rate-limit` | `429`、限流措辞、配额措辞 | medium |
| `permission-prompt` | `(y/n)`、`Allow …?`、`Do you want to`、`Press Enter`、带选择光标的编号菜单 | high |
| `model-switch-fail` | `invalid model`、`unknown model`、`model not found/available` | medium |
| `goal-drift-signal` | 配置的字面量关键词；未配置时停用 | medium |
| `empty-loop` | 相同输出在 `repeatWindowMin` 内至少重复 `repeatThreshold` 次，并标注 `identical` 或 `changing` | high |
| `error-streak` | 连续 `errorStreakThreshold` 次失败观察 | high |
| `crash-loop` | `crashWindowMin` 内 `maxRestarts` 次非零退出 | critical |
| `context-bloat` | 单次结算达到或超过 `contextBloatBytes` | medium |

规则匹配器是 `guard.ts` 中的字面量。配置可以停用某条规则、改严重度或提供字面量关键词，但永远不能提供正则表达式：任意模式会带着自己的开销进入每一次扫描。

### 进度熔断器与状态标记

每个受管终端保持一个进度熔断器。归一化后相同的结算计为无进展；`noProgressLimit` 把它推进到 `half-open`，`openLimit` 推进到 `open`，`cooldownSec` 限定 open 状态在允许一次重探前等待多久。结算结果与状态行都会报告 `breaker` 与 `breakerNoProgress`，但没有任何东西会因该状态采取行动。

`prompt-idle`、`waiting-input`、`working`、`silence`、`exit-ok`、`exit-bad`、`heartbeat-stale` 描述的是终端做了什么，而不是它是否健康。`silence` 只意味着等待超时且没有提示符。

### 记录与看门狗

`stateDir` 下保存 `heartbeat/<terminal>.json`、`spill/<task>/<terminal>.log` 与 `plans/<task>.json`；兄弟组件在它们旁边添加各自的目录。每个文件脱离插件也能读。

看门狗是唯一不经工具调用就能触达模型的路径：终端心跳过期时它 steer 持有者一次（重复频率不高于 `watchdogCooldownSec`），解析出的限流恢复时刻到点时再 steer 一次。两条通知都以 user 角色消息投递；限流计划只有在 steer 成功落地后才清除，因此被拒绝的 steer 会在下一轮扫描中重试。

不发布 invariant 伴随包：这里给出的每一项结论，要么是状态目录下一份自描述的记录，要么是由一次结算推导出的值，消费者可以用同样的输入重新推导。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [受管终端 bundle](../supervisor/README.zh.md) —— 六个组件与挂载它们的 profile 行。
- [终端会话](../../terminal/terminal/README.zh.md) —— 本包驱动的 PTY 服务，也是会话创建的唯一归属者。
- [终端工具](../../terminal/tool-terminal/README.zh.md) —— `terminal_open`、`terminal_list` 等 harness 管辖的终端接口。
- [受管终端子系统](../../../docs/subsystems/supervisor.zh.md) —— 消费者需要读取的标记、规则命中、计划子任务与持久记录。

-----

<a id="model-experience"></a>
## 模型体验

### 工具 schema

#### What the model sees

本组件加载期间注册六个工具：`supervisor_agent_launch`、`supervisor_terminal_send`、`supervisor_terminal_run`、`supervisor_terminal_read`、`supervisor_terminal_signal`、`supervisor_status`。它们的参数与说明列在生成的[工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-supervisor-core)中。

#### Token effect

固定开销：只要组件处于加载状态，这六个 schema 就出现在每个请求里，无论模型是否调用它们。加载或卸载该组件会替换这一块。

#### KV Cache effect

仅追加。schema 文本由属主稳定维护，因此它扩展的是可复用前缀，而不是替换更早的请求 token。改动任一工具说明或参数都会改变请求前缀，并从该点起使复用失效。

### 终端工具结果

#### What the model sees

产生结算的工具返回本次结算的有界输出、等待原因、推导出的状态标记（输出带活动标记时含 `working`）、`outputClass`、带 `convergence` 提示的 L1 命中、进度熔断器状态（`breaker` 与 `breakerNoProgress`）、存在时的 spill 日志路径、`spillCapped` 与 `sessionStatus`；`supervisor_terminal_run` 另外返回 `matched`、`timedOut`、`exitCode`、`marker` 与 `truncated`。`supervisor_terminal_read` 返回被检查的文本以及 `outputClass`、`heartbeatAgeSec`、`heartbeatStale`，而不是结算字段，因为读取不产生结算。`supervisor_status` 每个受管终端返回一行，含心跳年龄、是否过期、输出类别、最近等待原因与熔断器状态；每个任务返回一行，含子任务计数。

#### Token effect

条件性，并由终端服务自身的结果上界限制；只有模型调用这些工具时才会看到这一块。完整输出在 spill 路径上，而不在结果里。

#### KV Cache effect

仅追加。结果是新的尾部消息，从不重写更早的请求 token，因此扩展的是已可复用的前缀，而不是使其失效。

### 心跳过期通知

#### What the model sees

看门狗对每个过期终端投递一条 user 角色消息，重复频率不高于 `watchdogCooldownSec`：

##### Verbatim text for this field, when needed

```markdown
[supervisor] terminal <sessionId> produced no output for <ageSec>s (timeout <heartbeatTimeoutSec>s, last wait reason "<lastWaitReason>"[, task <taskId>]). Read it with supervisor_terminal_read and decide whether to answer a prompt, interrupt it, or take a checkpoint.
```

##### Appended sentence while that terminal's progress breaker is open

```markdown
Its progress breaker is OPEN after <n> identical settlements (open for <s>s): the terminal is repeating itself, so consider a different instruction, a fresh terminal, or a human decision.
```

#### Token effect

条件性：每个过期终端在每个冷却窗口内一条消息，熔断器处于 open 时再加一句；仅在启用看门狗时发生。

#### KV Cache effect

仅追加。通知作为新消息投递，因此扩展可复用前缀；它在步骤边界可能引起的中断会结束该前缀以供后续请求使用，而不是替换已发送的 token。

### 限流恢复通知

#### What the model sees

当某次结算的输出带有可解析重置时刻的限流时，看门狗在计划时刻投递一条 user 角色消息并清除该计划：

##### Verbatim text when a scheduled limit resume comes due

```markdown
[supervisor] terminal <sessionId> hit a usage limit that should have reset by now. Send a follow-up instruction to resume the task, or read the terminal first if the CLI left a dialog open.
```

#### Token effect

条件性：每个解析出的限流重置一条消息，且因触发时清除计划而只投递一次；仅在 `limitResumeEnabled`（默认开启）且看门狗运行时发生。

#### KV Cache effect

仅追加。通知作为新消息投递，因此扩展可复用前缀，而不是替换已发送的 token。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- **不创建终端** —— 组件通过 `ctx.terminals` 驱动终端却从不打开终端，因此部署必须暴露 harness 的 `terminal_open` 工具；没有它就无法得到 `supervisor_agent_launch` 所需的会话 id。
- **spill 日志保存的是被观察到的结算，而不是原始流** —— 终端服务每次结算只返回有界视口，因此相对"监工观察到的内容"是完整的，相对子进程 stdout 则不是。
- **进度熔断器只报告、不干预** —— open 状态不会阻止任何事；它是一枚确定性计数器，必须由监工模型读取并采取行动。
- **`empty-loop`、`error-streak` 与熔断计数只在内存中** —— 计数器不持久化，因此重启后的 harness 会重新观察而不是接着计数。
- **看门狗依赖 Agent 可被 steer** —— 已释放或正在驱动中的 Agent 会拒绝 steer；此时通知会在下一轮扫描重试，而不是排队。

-----

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本包拥有五个兄弟组件共同导入的词汇表（`types.ts`）与共享工具助手（`tool-support.ts`）。行为改动属于拥有受影响工具的那个组件；对 `observe` 或 `inspect` 的改动会改变所有终端工具报告的内容，因此属于跨组件改动。

</details>
