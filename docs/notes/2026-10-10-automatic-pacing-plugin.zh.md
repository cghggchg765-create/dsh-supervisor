# Agent Note: 把自动起搏做成 supervisor bundle 的第 5 个组件

Status: implemented

[English](2026-10-10-automatic-pacing-plugin.md) | 中文

## Problem

停摆的监工什么都监不了。harness 已经在看它托管的那批 CLI Agent——心跳、L1 检测、终端静默看门狗——但它**自己**的模型请求会以同样的方式失败：限流、上游拒绝、连接中断。步骤内有界重试由 `dsh-llm-retry` 负责：provider 的 `Retry-After` 落在它的策略内就照做，否则放手，回合以 `error` 结束。此后没有任何东西再驱动这个 Agent。

由此有两个具体缺口。超过 provider 策略上限的 `Retry-After` 会让运行停在原地、无人看管。而 `dsh-goal-round-driver` 有意在**任何** `agent/error`（包括瞬时的 `RATE_LIMIT`）时解除自动续跑，于是一个已武装的长任务会停到人工 resume 为止——这恰好与无人值守的需求相反。

## Decision

把 `@deepseek-ai/dsh-supervisor-pacing` 做成 bundle 的第 5 个组件：一个函数插件，不注册工具、不发布服务，靠 bundle patch 里新增的一行挂载。

它观察 `agent/error` 取失败事实，并在一个纯函数决策核心里计划续跑时刻：先用 provider 声明的延迟，其次用从失败消息解析出的时刻，最后才是有界抖动退避。面向 provider 的限流措辞加在 `@deepseek-ai/dsh-supervisor-core` 的 `limit.ts`（`parseProviderReset`、`isProviderLimit`），让这套词汇只有一个归属地，而不是在旁边长出第二个解析器。

投递完全照 `schedule` 的范式：用 `runMaintenance` 抢占 Agent 的空闲相，重新武装被失败解除的活跃目标（`ctx.goals.resume`，与轮次驱动 `pause` 的对称操作），再入队一条 `followup` 消息。忙着的 Agent 在下一次空闲转换时重试；若有人抢先开了回合，待执行的唤醒会被取消——人回来了，续跑就是多余的。

重启恢复读取一个 `pacing` 会话投影，它把每次 `turn/end` 折叠成最近一次回合的结局与失败事实。同步读取会话历史已被弃用，因此在重启后了解某会话最后一次回合的官方方式就是投影；崩溃遗留的回合以 `interrupted` 到达，按合成的 `INTERRUPTED` 失败处理，而默认失败码列表已包含它。

三条边界防止它长成循环机制：绝不 hook `agent/request-error`（步骤内重试归 `dsh-llm-retry`，第二个声明者只会抢跑）；不新增会话事件类型（改由通知文本自报来源）；不改动任何 `agent-loop` 代码。

## Alternatives considered

- **hook `agent/request-error`，在失败的步骤内重试。** 只用一套机制、失败也不进对话记录。但它会与 `dsh-llm-retry` 争同一个决策、把步骤在整个冷却期内挂住，并让一次很长的 provider 等待看起来像卡死的步骤。
- **给 `dsh-llm-retry` 加一个跨回合模式。** 包更少，但那个插件的契约是按尝试重试 + 按步骤计数，且其 README 承诺"没有任何模型可见内容"；跨回合起搏对模型可见、且意图是持久的，应当独立。
- **为通知新增专用 message source kind。** 来源更干净，代价是为一个细节改动会话格式；supervisor 的终端看门狗已经做过同样的取舍，而文本本身自报来源。
- **持久化续跑预算。** 需要新的会话事件类型、迁移与格式确认，只为换一个重启后可以合理重置的计数器；改为记录在案"仅在内存"。
- **让重启恢复默认开启。** 无需配置即可救回崩溃的运行，也会重放一个人类可能已经决定放弃的失败回合（含副作用）。因此保持可选。
- **什么都不做，靠运维。** 有人盯着的受管会话确实如此；而这个功能存在的理由恰恰是没人盯着的那些。

## Consequences

无人值守的运行现在能在预算内扛过一次故障：等过失败、让已武装的目标继续它的轮次，并用一条模型可据以行动的消息告知发生了什么。代价是这个组件可能重跑失败的回合——由失败码白名单、每会话预算、最小间隔与"重启恢复默认关闭"共同约束——以及插件页上多出一行，有人盯着时可以关掉。
