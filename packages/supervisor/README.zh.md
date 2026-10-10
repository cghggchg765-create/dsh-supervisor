---
description: "supervisor 分组导航：在终端里托管外部 CLI Agent、产出确定性的停滞证据，并让任务计划与断点持久可恢复。"
kind: "package-group"
---

# supervisor/ —— 受管终端能力系列

[English](README.md) | 中文

## 概述

无人值守运行数小时的 Agent，要监工的是它自己并不执行的工作。本分组在终端里托管其他 CLI Agent、观察其输出，并保留足够持久状态，使被中断的运行可以续跑而不是从头再来。监工模型始终留在 harness 的对话循环内；这些包只负责托管、扫描与持久化。该能力以一个 bundle 的形式交付，由六个可开关的组件组成，核心组件发布计划、编排、运维与关机组件读取的共享状态。

## 目录

- [包一览](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包一览

| 包 | 角色 | ctx 键 |
|---|---|---|
| [`supervisor`](supervisor/README.zh.md) | 可安装的 bundle：六个可独立开关的组件，以及新增组件的规则 | —（`dsh.bundle.patch`） |
| [`supervisor-core`](supervisor-core/README.zh.md) | 在终端里托管 CLI Agent，产出确定性状态标记与 L1 规则命中，并存放心跳、输出日志与任务计划 | `ctx.supervisor` |
| [`supervisor-tasks`](supervisor-tasks/README.zh.md) | 带子任务图的计划编写、带保留策略的 git 断点，以及带返工说明的评审工单 | `ctx.supervisorTasks` |
| [`supervisor-orchestration`](supervisor-orchestration/README.zh.md) | 技能清单、按阶段切换模型、worktree 隔离与有上限的并行派发 | 注册到 `ctx.tools` |
| [`supervisor-ops`](supervisor-ops/README.zh.md) | 用量预算、交付报告、聊天通知，以及关停闸门 | `ctx.supervisorOps` |
| [`supervisor-pacing`](supervisor-pacing/README.zh.md) | 监工 Agent 自身的自动起搏：模型请求失败后的跨回合续跑，受每会话预算约束 | 注册到 `ctx.tools` |
| [`supervisor-shutdown`](supervisor-shutdown/README.zh.md) | 运行结束后执行运维方配置的关机命令：墙钟或倒计时、任务计划全部完成、空闲超时、聊天提醒，以及取消路径 | 注册到 `ctx.tools` |

-----

<a id="related-documentation"></a>
## 相关文档

- [受管终端子系统](../../docs/subsystems/supervisor.zh.md) —— 消费者需要读取的标记、规则命中、计划子任务与持久记录。
- [终端会话子系统](../../docs/subsystems/terminal.zh.md) —— 这些包驱动的 PTY 服务，也是会话创建的唯一归属者。
- [把监工做成插件的 Agent Note](../../.agents/notes/implemented/architecture/2026-10-06-supervised-terminal-plugin.zh.md) —— 为什么监工是可选插件而不是循环机制。

-----

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

None.

</details>
