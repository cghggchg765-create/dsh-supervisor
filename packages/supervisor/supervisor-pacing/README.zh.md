---
description: "让监工 Agent 扛过上游失败：按声明的重置时刻或有界退避等待、重新武装被解除的目标（goal）、再唤醒 Agent 继续一个回合——全程受每会话预算约束。"
kind: "package-reference"
---

# @deepseek-ai/dsh-supervisor-pacing

[English](README.md) | 中文

## 概述

`supervisor-pacing` 让 harness 自身的模型请求能继续下去。`dsh-llm-retry` 在失败的步骤内按 provider 策略重试；当该策略放弃时——`Retry-After` 超过它允许的时长，或 provider 持续拒绝——回合以 `error` 结束，而没有任何东西会再唤醒 Agent。本组件按声明的重置时刻（或有界退避）等待、重新武装被失败解除的目标（goal），再唤醒 Agent 继续一个回合。它不注册任何工具。

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

通过承载它的 bundle —— [`@deepseek-ai/dsh-supervisor`](../supervisor/README.zh.md) —— 安装：在插件页安装，或执行 `dsh plugin --profile <名称> add <spec>`。本组件不需要路径配置、也不需要工具；它通过 Agent 注册表与会话投影注册表观察 harness 自身的回合。

### 配置

profile 补丁按行 id `supervisor-pacing` 定位并**整份替换** `config`：

```yaml
- id: supervisor-pacing
  config:
    maxResumesPerSession: 3
    minIntervalMs: 60000
    resumeOnRestart: true
    notifyChatId: 'oc_…'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `enabled` | `true` | 是否启用自动起搏。 |
| `scope` | `roots` | 起搏范围：`roots` 覆盖人类驱动的会话，`all` 也覆盖子 Agent。 |
| `codes` | `RATE_LIMIT`、`SERVER`、`TIMEOUT`、`TRANSPORT`、`EMPTY_RESPONSE`、`INTERRUPTED` | 会被续跑的失败码；其他码只上报、不续跑。 |
| `initialDelayMs` | `1000` | 失败未声明恢复时刻时的首个退避延迟。 |
| `maxDelayMs` | `10000` | 退避延迟上限。 |
| `jitterRatio` | `0.1` | 退避延迟的对称抖动比例。 |
| `bufferMs` | `120000` | 在声明的重置时刻之后额外等待的时长，确保 provider 已恢复服务。 |
| `maxResumeDelayMs` | 6 小时 | 允许的最长续跑延迟；更晚的时刻会被截到该上限。 |
| `minIntervalMs` | `60000` | 同一会话两次自动续跑之间的最小间隔。 |
| `maxResumesPerSession` | `3` | 放弃前允许的连续自动续跑次数。 |
| `resumeGoals` | `true` | 重新武装被失败解除的活跃目标（goal），让它的轮次继续。 |
| `resumeOnRestart` | `false` | 进程重启后，对上一次以失败结束的会话安排续跑。 |
| `notifyOnGiveUp` | `true` | 已注册聊天通道时，上报放弃事件。 |
| `notifyChatId` | 空 | 放弃告警发送到的会话；留空则不发。 |

### 何时选用

适合必须扛过 provider 故障、且无人盯着的运行：通宵编码、反复触发限流的批处理，或者"监工 Agent 自己就是被拒绝的那一方"的受管运行。若每个回合都有人实时看着，则不必启用——人看到失败后直接发下一条消息即可。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

### 一次失败，一次决策

`agent/error` 提供失败事实（`code`、`status`、`providerRetryAfterMs`、`message`），`src/pacing.ts` 对其收窄并做计划：先用 provider 声明的延迟，其次用从消息里解析出的恢复时刻（provider 形态的解析放在 `@deepseek-ai/dsh-supervisor-core` 的 `parseProviderReset`，该词汇只有一个归属地），最后才是有界抖动退避。部署未列出的码、或用尽预算的会话，只上报、不续跑。

### 唤醒

待执行的唤醒是一个随 fiber 生命周期的定时器。触发时，组件通过 `runMaintenance` 抢占 Agent 的空闲相，重新武装被失败解除的活跃目标（`ctx.get('goals')`，可选的目标服务，因为它不在声明的注入里，所以这样读取），并入队一条 `followup` 消息。忙着的 Agent 会在下一次空闲转换后重试；若有人抢先开始了回合，待执行唤醒会被取消——人回来了，续跑就是多余的。

### 重启恢复

`src/projection.ts` 注册一个 `pacing` 会话投影，把每次 `turn/end` 折叠成"最近一次回合的结局与失败事实"。这是仓库认可的"重启后读取历史"的方式——同步事件读取已被弃用——因此 `resumeOnRestart` 只凭投影状态就能决策。崩溃遗留的回合会以 `interrupted` 到达，并按合成的 `INTERRUPTED` 失败处理。

### 明确不做的事

它绝不 hook `agent/request-error`：步骤内重试属于 `dsh-llm-retry`，第二个声明者只会与它抢跑。它不改动 `agent-loop`，也不新增会话事件类型。

### 为什么不发布不变量伴随模块

不发布不变量伴随模块：本组件唯一的持久产出是它从已提交事件折叠出的投影，消费者可以用同一份日志重新推导每一项结论，不存在会互相矛盾的第二种观测。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [受管终端 bundle](../supervisor/README.zh.md) —— 六个组件与挂载它们的 profile 行。
- [LLM 请求恢复](../../llm/llm-retry/README.zh.md) —— 本组件交接给它的步骤内重试策略。
- [目标轮次](../../goal/goal-round-driver/README.zh.md) —— 任何错误都会解除目标的轮次驱动，本组件负责重新武装。
- [定时提醒](../../schedule/schedule/README.zh.md) —— 本组件沿用的 `runMaintenance` + `followup` 唤醒范式。

-----

<a id="model-experience"></a>
## 模型体验

### 续跑通知

#### What the model sees

每次实际投递的续跑各一条 user 角色消息，作为下一个回合入队：

##### Verbatim text for this field, when needed

```markdown
[pacing] the previous turn failed. This is automatic resume {resume} of {max}: continue the work from where it stopped, and if it cannot continue, report what remains instead of retrying.
```

#### Token effect

条件性：每次自动续跑至多一条消息，受每会话 `maxResumesPerSession` 限制，且仅在某个回合已经失败之后发生。

#### KV Cache effect

仅追加。通知是对话末尾的新消息，因此扩展可复用前缀而不是替换更早的 token；它开启的那个回合再追加自己的请求 token。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- **通知以 user 角色消息到达** —— 为来源标注新增专用 source kind 属于会话格式变更，因此改由文本自报来源（`[pacing] …`），与 supervisor 的终端看门狗做法一致。
- **续跑预算只在内存中** —— 重启会重置预算，因此持续故障的 provider 在每次重启后还能再被续跑；`resumeOnRestart` 默认关闭，避免崩溃后静默重放失败的回合。
- **步骤内重试仍归 `dsh-llm-retry`** —— 本组件只在回合以 error 结束后行动，provider 策略已处理的失败不会到达这里。
- **未列出的失败只上报、不续跑** —— 运维会看到一行日志（以及每个冷却窗口至多一条聊天告警）并需要自己决定；起搏不会去猜 `AUTH` 或 `INVALID_REQUEST` 是否属于瞬时故障。
- **重新武装目标需要目标服务** —— 未挂载 `ctx.goals` 时，续跑仍会唤醒 Agent，但被解除的目标会保持解除状态。

-----

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

决策核心（`src/pacing.ts`）是纯函数，因此策略可以脱离 agent 循环测试；投影（`src/projection.ts`）是唯一的持久读取路径。面向 provider 的限流措辞归 `@deepseek-ai/dsh-supervisor-core` 的 `limit.ts`，新增形态请加在那里而不是本包。

</details>
