---
description: "Install the supervised-terminal control plane as six independently switchable components."
kind: "package-bundle"
---

# @deepseek-ai/dsh-supervisor

English | [中文](README.zh.md)

## Summary

This optional bundle supervises unattended long tasks: it hosts external CLI agents in terminals, turns their output into deterministic stall evidence, and keeps plans, checkpoints, and reports durable across model turns. Six components ship together, and each one can be switched off on its own. Shipped profiles leave the bundle disabled.

## Table of Contents

- [Use this bundle](#use-this-bundle)
- [Components](#components)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-bundle"></a>
## Use this bundle

Install it into a profile from the running application's **Plugins** page (Add plugin, then the absolute directory or the registry name), or from the command line: `dsh plugin --profile <name> add <spec>`. Installation adds a `link:` dependency, appends the bundle to `dsh.profile.bundles`, and enables it. The Plugins page then lists one entry — Supervised terminals — with six components under it. The Electron desktop profile is managed exclusively by the desktop application, so install there from its Plugins page rather than from the CLI.

A composition that mounts this bundle needs a terminal backend as well, because the bundle hosts CLI agents but never opens a terminal itself. A host-plane profile keeps its own rows:

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

Without those rows the core component stays pending on a missing service and registers none of its tools; only the boot log carries the warning.

Record paths belong in the profile patch, because the six rows share one state directory:

```yaml
- id: supervisor
  config:
    stateDir: '/absolute/path/to/state'
    workspaceDir: '/absolute/path/to/workspace'
```

Set both to absolute paths. Left unset, `stateDir` resolves to `.supervisor` under the process working directory — for the desktop application that is the profile directory — and a checkpoint would then commit whatever repository contains the profile.

Two rules apply to every row: a patch replaces the targeted row's whole `config` rather than merging into it, so restate every key you keep, and the row ids above are the only handles a profile patch has on the components.

Disabling one component in the Plugins page removes exactly its tools from the next request while the other five keep working; disabling the bundle row itself leaves nothing mounted.

When a task will run longer than one model turn and someone must notice when the hosted agent stops making progress — an overnight coding run, a batch that keeps hitting rate limits, or work that needs a durable resume point — use the bundle. Skip it for a single short command: the `bash` tool already runs those and returns their output.

-----

<a id="components"></a>
## Components

| Row id | Package | What it owns | Tools |
|---|---|---|---|
| `supervisor` | `@deepseek-ai/dsh-supervisor-core` | The supervised-session registry, the deterministic L1 detection pipeline, heartbeats, output logs, the task-plan store, and the heartbeat watchdog | `supervisor_agent_launch`, `supervisor_terminal_send`, `supervisor_terminal_run`, `supervisor_terminal_read`, `supervisor_terminal_signal`, `supervisor_status` |
| `supervisor-tasks` | `@deepseek-ai/dsh-supervisor-tasks` | Plan authoring with subtask graphs, git checkpoints with retention, and review tickets with their redo briefs | `supervisor_plan`, `supervisor_checkpoint`, `supervisor_review`, `supervisor_issue` |
| `supervisor-orchestration` | `@deepseek-ai/dsh-supervisor-orchestration` | Per-agent skill inventories, phase-based model switching, worktree isolation, and bounded parallel dispatch | `supervisor_skills`, `supervisor_agent_switch`, `supervisor_worktree`, `supervisor_dispatch` |
| `supervisor-ops` | `@deepseek-ai/dsh-supervisor-ops` | The usage budget, delivery reports, chat notifications, and the shutdown gate | `supervisor_budget`, `supervisor_notify`, `supervisor_shutdown`, `supervisor_report` |
| `supervisor-pacing` | `@deepseek-ai/dsh-supervisor-pacing` | Automatic pacing for the supervising agent itself: after its own model request fails it waits out the stated reset or a bounded backoff, re-arms a goal the failure disarmed, and wakes the agent for one more turn | *(registers no tools)* |
| `supervisor-shutdown` | `@deepseek-ai/dsh-supervisor-shutdown` | Runs the operator's shutdown command once the run is over: a wall clock or countdown, completed task plans, an idle timeout, chat reminders, a cancel path, and a dry run | `supervisor_power` |

The core component is the only required one: it publishes `ctx.supervisor` and registers the six terminal tools. `supervisor-tasks` publishes `ctx.supervisorTasks` for the same reason, and `supervisor-ops` publishes `ctx.supervisorOps`. Pacing and shutdown publish no service: `supervisor-pacing` watches the harness's own turns and registers no tool of its own, and `supervisor-shutdown` reads the operations gate and the control plane's plans and runs the operator's command through `ctx.shell`.

### Adding another component

A new capability is one package under `packages/supervisor/`, one `insert` row in this bundle's `cordis.patch.yml`, and one entry in this package's `dependencies`. The Plugins page then renders it as one more component with its own title, description, icon, and switch, because a component row inherits the display metadata of the package it names: the `meta.title` and `meta.description` of its `locale/en.json` and `locale/zh.json`, and its top-level `icon`.

A new component reads shared state through the published services instead of importing another component's modules: `ctx.supervisor` for sessions, detection, heartbeats, output logs, and plans; `ctx.supervisorTasks` for checkpoints, tickets, and git operations; `ctx.supervisorOps` for the budget ledger and the chat transport. Declare the ones it needs in `inject`. Keep a `Config` schema for the settings only that component reads, and take `stateDir`, `workspaceDir`, and `worktreeBase` from `ctx.supervisor.config` so one state directory stays authoritative.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Composition

`cordis.patch.yml` inserts the six rows in the order listed above. Layer order is bundle rows, then the profile patch, then the home patch, then command-line overlays, so a profile can configure or disable any single component by row id without restating its siblings. Each component is an ordinary Cordis plugin: the core, planning, and operations components default-export a service class, and orchestration, pacing, and shutdown are function plugins.

### Configuration ownership

The components split configuration the way they split state. The core owns every path and every threshold shared by more than one component — `stateDir`, `workspaceDir`, `worktreeBase`, the agent templates, the detection thresholds, the breaker limits, the spill and watchdog settings. Planning owns checkpoint retention and the per-ticket repair budget; orchestration owns the model rules, the skill roots, the worktree branch prefix, and the dispatch concurrency; operations owns the budget, the price table, and the shutdown policy. Two rules follow from that split: a setting read by two components lives in the core and is read from `ctx.supervisor.config`, and each component's own `Config` schema is the only place its private settings appear.

### Why no invariant companion is published

No invariant companion is published: every claim these components make is either a self-describing record under the state directory or a value derived from one settlement, so a consumer can re-derive it from the same inputs and no second observation can disagree.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Supervised terminals subsystem](../../../docs/subsystems/supervisor.md) — the marks, rule hits, plan subtasks, and stored records a consumer reads.
- [Terminal sessions subsystem](../../../docs/subsystems/terminal.md) — the PTY service every component drives, and the only owner of session creation.
- [Supervised terminals as a plugin Agent Note](../../../.agents/notes/implemented/architecture/2026-10-06-supervised-terminal-plugin.md) — why supervision is an opt-in bundle rather than loop machinery.
- [Terminal tool](../../terminal/tool-terminal/README.md) — `terminal_open`, `terminal_list`, and the rest of the harness-owned terminal surface the core component requires.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the six component packages that own every tool schema, tool result, and prompt contribution.

#### KV Cache effect

No direct effect; each component owns its own request contributions and names the conditions that invalidate reuse.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **The bundle never opens a terminal** — it drives terminals through `ctx.terminals`, so a composition without a terminal backend keeps the core component pending and registers none of its tools; the Plugins page reports that row as not running rather than failing the load loudly.
- **All six components load together by default** — an operator who wants only the core turns the other five off per profile; the bundle expresses no partial default of its own.
- **The chat provider is not shipped** — `ctx.supervisorOps` publishes the transport seam and owns the inbound routing, but registers no transport, so `supervisor_notify` reports that none is registered until a deployment supplies the wire.
- **The components share one version** — they are released together from this repository, so a deployment cannot pin one component to a different generation than its siblings.

-----

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Maintainer details — click to expand</summary>

Each component's README documents its own service, configuration, and tools; this page owns the composition, the row ids, and the rule for adding a component.

</details>
