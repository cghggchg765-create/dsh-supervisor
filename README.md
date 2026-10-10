# dsh-supervisor

English | [中文](README.zh.md)

## What this is

A supervised-terminal control plane for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`), packaged as an in-tree overlay.

The harness runs one supervising model in its own agent loop. This control plane lets that model host *other* CLI agents (Claude Code, Codex, dsh, and others) inside terminal sessions, derive deterministic stall evidence from their output, and keep plans, checkpoints, and reports durable across model turns.

The supervising model stays in the harness loop. These packages only host, scan, and persist: they own no intelligence and decide nothing about what any observation means.

This repository is the payload of `packages/supervisor/` extracted from the harness. It is meant to be copied into a harness checkout at the matching version, not installed from a registry: the `@deepseek-ai/dsh-*` packages it depends on are not published to npm yet, so a standalone `pnpm install` here cannot resolve them.

## Components

One bundle (`@deepseek-ai/dsh-supervisor`) plus six component packages, all under `packages/supervisor/`.

| Package | What it owns | ctx service | Tools |
|---|---|---|---|
| `@deepseek-ai/dsh-supervisor-core` | The supervised-session registry, the L1 detection pipeline, heartbeats, output logs, the task-plan store, and the heartbeat watchdog | `ctx.supervisor` | `supervisor_agent_launch`, `supervisor_terminal_send`, `supervisor_terminal_run`, `supervisor_terminal_read`, `supervisor_terminal_signal`, `supervisor_status` |
| `@deepseek-ai/dsh-supervisor-tasks` | Plan authoring with subtask graphs, git checkpoints with retention, and review tickets with their redo briefs | `ctx.supervisorTasks` | `supervisor_plan`, `supervisor_checkpoint`, `supervisor_review`, `supervisor_issue` |
| `@deepseek-ai/dsh-supervisor-orchestration` | Per-agent skill inventories, phase-based model switching, worktree isolation, and bounded parallel dispatch | — (registers on `ctx.tools`) | `supervisor_skills`, `supervisor_agent_switch`, `supervisor_worktree`, `supervisor_dispatch` |
| `@deepseek-ai/dsh-supervisor-ops` | The usage budget with its price table, delivery reports, chat notifications, and the shutdown gate | `ctx.supervisorOps` | `supervisor_budget`, `supervisor_notify`, `supervisor_shutdown`, `supervisor_report` |
| `@deepseek-ai/dsh-supervisor-pacing` | Automatic pacing for the supervising agent itself: it waits out a failed model request and wakes the agent for one more turn, within a bounded budget | — (registers no tools) | — |
| `@deepseek-ai/dsh-supervisor-shutdown` | Runs the operator's shutdown command once the run is over: wall clock or countdown, completed plans, idle timeout, chat reminders, cancel path, dry run | — (registers on `ctx.tools`) | `supervisor_power` |

`supervisor-core` is the only required component: it publishes `ctx.supervisor`, the shared state every other component reads. See [docs/components.md](docs/components.md) for each component's configuration fields and defaults.

## How it composes

`packages/supervisor/supervisor/cordis.patch.yml` is the whole composition: one bundle row per component, each with its own row id.

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

Layer order is bundle rows, then the profile patch, then the home patch, then command-line overlays. A profile patch addresses one component by its row id, so an operator configures or disables one component without restating the other five. Disabling a row removes exactly that component's tools from the next request.

The bundle never opens a terminal itself. A composition that mounts it needs a terminal backend (`@deepseek-ai/dsh-terminal`, a shell backend, and `@deepseek-ai/dsh-tool-terminal`); without one, the core component stays pending on the missing service and registers none of its tools.

## Requirements

- A DeepSeek Harness checkout at tag `dsh-v0.1.7-rc.1`.
- Node `^22.19 || >=24`.
- pnpm.

## Install

Copy `packages/supervisor/*` into the harness checkout and mount the bundle from a profile. The step-by-step commands, the profile patch, and how to switch a single component off are in [docs/install.md](docs/install.md).

There is no `pnpm-workspace.yaml` here on purpose. A standalone `pnpm install` in this repository cannot resolve the unpublished `@deepseek-ai/dsh-*` and `@deepseek-ai/cordis` dependencies; the payload is a workspace member inside a harness checkout, where those resolve through the harness workspace.

## Configuration

Every component owns its own `Config` schema; the core owns the paths and thresholds shared by more than one component (`stateDir`, `workspaceDir`, `worktreeBase`, the agent templates, the detection thresholds, the breaker limits, the spill and watchdog settings). A patch replaces the targeted row's whole `config` rather than merging into it, so restate every key you keep.

[docs/components.md](docs/components.md) lists each component's `Config` fields with their defaults and meaning, and the two cross-component prerequisites: `supervisor-ops`'s `shutdown.enabled` and `shutdown.command`, and `supervisor-shutdown`'s `enabled` and optional `cancelCommand`.

## Development

The packages are workspace members of a harness checkout, so their tests run from the checkout root:

```sh
pnpm exec vitest run packages/supervisor
```

Each component also carries a loader-composition test that mounts its real rows through the harness boot path. Integration in CI does the same thing end to end: clone the harness at the tag, copy the payload in, `pnpm install`, run `pnpm exec vitest run packages/supervisor`, then `pnpm run constraints` (see [.github/workflows/integration.yml](.github/workflows/integration.yml)).

## Compatibility

The payload targets harness `0.1.7-rc.1` (tag `dsh-v0.1.7-rc.1`). Every package under `packages/supervisor/` carries that same version and is released together, so a deployment cannot pin one component to a different generation than its siblings. When the harness moves to a new version, update the whole payload with it and re-run the integration workflow.

## Design notes

The three Agent Notes that record why the control plane is an opt-in bundle and how pacing and shutdown were added are kept in [docs/notes/](docs/notes/).

## License

MIT. The payload is derived from the MIT-licensed DeepSeek Harness; see [LICENSE](LICENSE).
