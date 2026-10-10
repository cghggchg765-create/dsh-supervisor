# dsh-supervisor

[English](README.md) | 中文

## 这个仓库是什么

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）的受监督终端控制平面，以 in-tree overlay 的形式发布。

Harness 让一个监督模型运行在自己的 agent loop 中。这套控制平面让该模型可以在终端会话里托管*其他* CLI agent（Claude Code、Codex、dsh 等），从它们的输出中得出确定性的停滞证据，并让计划、检查点和报告跨模型轮次保持持久。

监督模型始终留在 harness loop 内。这些包只负责托管、扫描和持久化：它们不具备智能，也不决定任何观测结果的含义。

本仓库是 harness 中 `packages/supervisor/` 这份 payload 的抽取，用来复制进匹配版本的 harness checkout，而不是从包仓库安装：它依赖的 `@deepseek-ai/dsh-*` 包尚未发布到 npm，因此在本仓库单独执行 `pnpm install` 无法解析这些依赖。

## 组件

一个 bundle（`@deepseek-ai/dsh-supervisor`）加六个组件包，全部位于 `packages/supervisor/` 下。

| 包 | 负责的内容 | ctx 服务 | 工具 |
|---|---|---|---|
| `@deepseek-ai/dsh-supervisor-core` | 受监督会话注册表、L1 检测流水线、心跳、输出日志、任务计划存储，以及心跳看门狗 | `ctx.supervisor` | `supervisor_agent_launch`、`supervisor_terminal_send`、`supervisor_terminal_run`、`supervisor_terminal_read`、`supervisor_terminal_signal`、`supervisor_status` |
| `@deepseek-ai/dsh-supervisor-tasks` | 带子任务图的计划编写、带保留策略的 git 检查点，以及带返工摘要的评审工单 | `ctx.supervisorTasks` | `supervisor_plan`、`supervisor_checkpoint`、`supervisor_review`、`supervisor_issue` |
| `@deepseek-ai/dsh-supervisor-orchestration` | 每个 agent 的技能清单、按阶段切换模型、worktree 隔离，以及有上限的并行派发 | —（注册在 `ctx.tools` 上） | `supervisor_skills`、`supervisor_agent_switch`、`supervisor_worktree`、`supervisor_dispatch` |
| `@deepseek-ai/dsh-supervisor-ops` | 带价格表的用量预算、交付报告、聊天通知，以及关机闸门 | `ctx.supervisorOps` | `supervisor_budget`、`supervisor_notify`、`supervisor_shutdown`、`supervisor_report` |
| `@deepseek-ai/dsh-supervisor-pacing` | 对监督 agent 自身的自动节奏控制：等待失败的模型请求恢复，并在有界预算内唤醒 agent 再跑一轮 | —（不注册工具） | — |
| `@deepseek-ai/dsh-supervisor-shutdown` | 运行结束后执行操作方配置的关机命令：挂钟或倒计时、计划全部完成、空闲超时、聊天提醒、取消路径、试运行 | —（注册在 `ctx.tools` 上） | `supervisor_power` |

`supervisor-core` 是唯一必需的组件：它发布 `ctx.supervisor`，即其他所有组件读取的共享状态。每个组件的配置字段与默认值见 [docs/components.md](docs/components.md)。

## 如何组合

`packages/supervisor/supervisor/cordis.patch.yml` 就是全部组合：每个组件一行 `insert`，各自拥有独立的行 id。

```yaml
- insert:
    - id: supervisor
      name: '@deepseek-ai/dsh-supervisor-core'
    - id: supervisor-tasks
      name: '@deepseek-ai/dsh-supervisor-tasks'
    - id: supervisor-orchestration
      name: '@deepseek-ai/dsh-supervisor-orchestration'
    - id: supervisor-ops
      name: '@deepseek-ai/dsh-supervisor-ops'
    - id: supervisor-pacing
      name: '@deepseek-ai/dsh-supervisor-pacing'
    - id: supervisor-shutdown
      name: '@deepseek-ai/dsh-supervisor-shutdown'
```

层次顺序是 bundle 行、profile patch、home patch、命令行 overlay。profile patch 通过行 id 定位单个组件，因此操作方可以配置或禁用某一个组件，而不必重述其余五个。禁用一行只会从下一个请求中移除该组件的工具。

bundle 自身从不打开终端。挂载它的组合还需要一个终端后端（`@deepseek-ai/dsh-terminal`、某个 shell 后端和 `@deepseek-ai/dsh-tool-terminal`）；缺少后端时，核心组件会停留在等待缺失服务的状态，且不注册任何工具。

## 环境要求

- 位于标签 `dsh-v0.1.7-rc.1` 的 DeepSeek Harness checkout。
- Node `^22.19 || >=24`。
- pnpm。

## 安装

把 `packages/supervisor/*` 复制进 harness checkout，并在某个 profile 中挂载 bundle。逐步命令、profile patch，以及如何单独关闭一个组件，见 [docs/install.md](docs/install.md)。

这里刻意不提供 `pnpm-workspace.yaml`。在本仓库单独执行 `pnpm install` 无法解析尚未发布的 `@deepseek-ai/dsh-*` 与 `@deepseek-ai/cordis` 依赖；这份 payload 是 harness checkout 内的工作区成员，在那里这些依赖通过 harness 工作区解析。

## 配置

每个组件拥有自己的 `Config` schema；核心组件拥有被多个组件共享的路径与阈值（`stateDir`、`workspaceDir`、`worktreeBase`、agent 模板、检测阈值、熔断上限、spill 与看门狗设置）。patch 会整体替换目标行的 `config` 而不是与其合并，因此请重述所有要保留的键。

[docs/components.md](docs/components.md) 列出每个组件的 `Config` 字段、默认值和含义，以及两个跨组件前置条件：`supervisor-ops` 的 `shutdown.enabled` 与 `shutdown.command`，以及 `supervisor-shutdown` 的 `enabled` 与可选的 `cancelCommand`。

## 开发

这些包是 harness checkout 的工作区成员，因此测试从 checkout 根目录运行：

```sh
pnpm exec vitest run packages/supervisor
```

每个组件还带有 loader 组合测试，通过 harness 的启动路径挂载其真实行。CI 中的集成检查端到端地做同样的事：克隆对应标签的 harness、复制 payload、`pnpm install`、运行 `pnpm exec vitest run packages/supervisor`，再运行 `pnpm run constraints`（见 [.github/workflows/integration.yml](.github/workflows/integration.yml)）。

## 兼容性

这份 payload 面向 harness `0.1.7-rc.1`（标签 `dsh-v0.1.7-rc.1`）。`packages/supervisor/` 下的每个包都携带同一版本并一同发布，因此部署无法把某个组件固定到与其同类不同的代次。harness 升到新版本时，请同步更新整份 payload 并重新运行集成工作流。

## 设计说明

记录控制平面为何是可选的 bundle、以及 pacing 与 shutdown 如何加入的三篇 Agent Note 保存在 [docs/notes/](docs/notes/)。

## 许可证

MIT。这份 payload 派生自 MIT 许可的 DeepSeek Harness；见 [LICENSE](LICENSE)。
