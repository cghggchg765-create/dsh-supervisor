---
description: "受监督运行结束时关闭机器：武装墙钟、倒计时、计划完成监听或空闲超时，截止前在聊天中提醒，并执行运维配置的关机或取消命令。"
kind: "package-reference"
---

# @deepseek-ai/dsh-supervisor-shutdown

[English](README.md) | 中文

## 概述

`supervisor-shutdown` 按运维配置的方式结束一次受监督运行：等待某个已武装的条件，在截止前向聊天提醒，然后通过 shell 接缝执行运维自己的命令。适合通宵运行或无人值守的批处理——工作完成后应当释放机器；若有人盯着运行、会自己关闭机器，则不必启用。在运维于 `supervisor-ops` 中启用关机闸门并提供命令之前，什么都不会发生；`dryRun` 只报告将执行的内容而不执行。模型可以武装、查看与取消尝试，但永远无法启用闸门。

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

本组件作为受监督组合中的一行挂载；[`supervisor` bundle](../supervisor/README.zh.md) 以 `enabled: false` 插入它，profile 补丁再按部署需要打开它：

```yaml
- id: supervisor-shutdown
  config:
    enabled: true
    scheduleAfterMinutes: 90
    remindAtMin: [30, 10, 1]
    cancelCommand: 'shutdown /a'
    notifyChatId: 'oc_…'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `enabled` | `false` | 本组件是否调度并执行关机。 |
| `scheduleAt` | 空 | 定时尝试武装到的本地 `HH:MM` 墙钟；留空则关闭。 |
| `scheduleAfterMinutes` | `0` | 自插件加载起多少分钟后武装定时尝试；`0` 表示关闭。 |
| `scheduleAfterSeconds` | `0` | 自插件加载起的秒数；同时配置时优先于分钟值。 |
| `watchPlans` | `false` | 每个已存计划的子任务都完成时武装；工作重新打开时撤销该尝试。 |
| `idleTimeoutMin` | `0` | 多少分钟没有 Agent 运行后武装；`0` 表示关闭。 |
| `remindAtMin` | `[10, 5, 1]` | 尝试触发前多少分钟发出聊天提醒。 |
| `cancelCommand` | 空 | 取消操作系统已排定关机的运维命令；留空则跳过取消。 |
| `notifyChatId` | 空 | 提醒与报告发送到的会话；留空则只写入日志。 |
| `dryRun` | `false` | 只报告将执行的内容，不实际执行。 |
| `pollIntervalSec` | `30` | 监听轮询的间隔秒数。 |
| `commandTimeoutSec` | `30` | 一条命令在被杀死前允许运行的秒数。 |

### 闸门归运维所有

本组件绝不自行发明命令。`@deepseek-ai/dsh-supervisor-ops` 解析 `shutdown.enabled`、`shutdown.command` 与 `shutdown.gracePeriodMin`，本组件在已武装尝试触发时询问该闸门。未配置或已禁用的策略会拒绝每次尝试，并在日志中给出闸门的理由，什么都不会执行。

```yaml
- id: supervisor-ops
  config:
    shutdown:
      enabled: true
      command: 'shutdown /s /t 60'
      gracePeriodMin: 5
```

| 平台 | 关机命令 | 取消命令 |
|---|---|---|
| Windows | `shutdown /s /t 60` | `shutdown /a` |
| Linux | `systemctl poweroff` | — |
| macOS | `osascript -e 'tell app "System Events" to shut down'` | — |

### 何时选用

适合无人值守、工作结束后机器不应继续开着的运行：通宵编码会话、完成时间未知的批处理，或以计划作为完成信号的受监督运行。有人在实时看着运行时不必启用；调校排期时保持 `dryRun: true`，它会报告闸门将要执行的准确命令。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

### 闸门与执行

运维的策略与本组件的时机是两件事。`supervisor-ops` 拥有 `shutdown.enabled`、命令与宽限期；本组件拥有何时发起尝试、尝试前的提醒，以及取消路径。每次尝试都在触发时询问闸门，因此武装之后才被禁用的策略仍会拒绝，并在理由中说明原因。

### 四条武装路径

定时尝试来自 `scheduleAt`（在插件加载时解析出的该墙钟的下一次本地发生时刻）或 `scheduleAfterMinutes`/`scheduleAfterSeconds`，模型也可以通过 `supervisor_power schedule` 武装同一触发原因。启用 `watchPlans` 后，某次监听轮询会在每个已存计划的子任务均为 `completed` 或 `skipped` 时武装，并在工作重新打开时撤销该尝试。启用 `idleTimeoutMin` 后，某次轮询会在这么久没有 `agent/status` 转换报告 `running` 时武装。模型的 `confirm` 动作是第四条路径：它断言工作已完成并武装计划触发原因。计划与空闲触发原因还要等过运维的宽限期，宽限期从记录的完成时刻或最后一次运行中的 Agent 起算。

### 提醒与取消

每次尝试都记住武装时已处在哪些提醒阈值之内，因此六分钟后触发的一次性倒计时不会补报「十分钟」那一行；每个阈值在每次尝试中只报一次。取消会清除定时器并执行 `cancelCommand`，即使没有任何已武装尝试——早先的运行可能已让操作系统排定了它自己的关机。`dryRun` 把每次命令执行替换为一行报告。

### 为什么不发布不变量伴随模块

不发布不变量伴随模块：本组件不拥有任何服务、持久记录或第二种观测。它唯一的状态是私有定时器及围绕它的尝试记账，而运维通过本组件自己写出的同一批日志与聊天行观察它们，不存在会互相矛盾的第二种观测。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [受管终端 bundle](../supervisor/README.zh.md) —— 把本行与其他 supervisor 组件一起挂载的 profile 层。
- [运维](../../supervisor/supervisor-ops/README.zh.md) —— 拥有关机闸门、运维命令与聊天传输的组件。
- [任务计划](../supervisor-tasks/README.zh.md) —— 完成监听读取的已存计划。
- [受管终端核心](../supervisor-core/README.zh.md) —— 控制面，本组件的监听器通过它的 `ctx.supervisor` 读取已存计划。
- [Shell 可执行接缝](../../shell/shell/README.zh.md) —— 运维关机和取消命令经过的接缝。

-----

<a id="model-experience"></a>
## 模型体验

### 关机工具结果

#### What the model sees

每次 `supervisor_power` 调用一个文本块，由规范结果渲染而来，而不是原始对象：

##### Armed text

```markdown
shutdown armed ({detail}); fires at {firesAt}
```

##### Unarmed text

```markdown
no shutdown pending: {reason}
```

#### Token effect

条件性：每次 `supervisor_power` 调用至多一行短文本，且只在模型调用该工具或监工 Agent 请求检查时出现。

#### KV Cache effect

仅追加。结果是对话末尾的新 tool 角色消息；工具 schema 本身在各次调用之间保持稳定，因此更早的请求 token 仍可复用。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- **harness 无法阻止操作系统已在倒计时的机器** —— 运维命令一旦开始系统倒计时，只有运维的 `cancelCommand` 能取消它；本组件没有别的杠杆。
- **未配置的策略意味着什么都不会发生** —— 本组件绝不自行发明命令，因此只武装了尝试、却把 `supervisor-ops` 的 `shutdown.command` 留空的部署只会得到拒绝行，而不是关机。
- **模型可以武装尝试，但永远无法启用闸门** —— 是否启用关机、选择哪条命令与宽限期都属运维配置；`supervisor_power` 无法改变它们。
- **无头 harness 中不存在图形倒计时** —— 剩余时间只能通过 `supervisor_power status`、日志与配置的聊天会话看到，而不是浏览器或桌面上的倒计时。
- **尝试记账只存在于内存** —— 重启会忘记已消耗的条件、记录的完成时刻与空闲时钟，因此同一组已完成的计划在重启后可以再次武装新的尝试。
- **配置的墙钟只在插件加载时解析一次** —— `scheduleAt` 的尝试触发或被取消后不会再武装；长时间运行的进程只剩倒计时、计划与空闲三条路径。
- **空闲时间只看得见 harness 自身的 Agent** —— 机器上的其他进程对 `idleTimeoutMin` 不可见，harness 之外的工作不会推迟尝试。

-----

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

决策核心（`src/power.ts`）是纯函数——计划进度、下一次墙钟发生时刻与应付的提醒——因此时机可以脱离时钟测试。`src/index.ts` 中的调度器在 apply 时一次性解析服务，并由单个 interval 驱动；插件测试用 `dryRun: true` 在假时钟下覆盖这些时机。闸门本身位于 `@deepseek-ai/dsh-supervisor-ops` 的 `shutdown.ts`；新的拒绝理由应加在那里，而不是本包。

</details>
