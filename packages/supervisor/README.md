---
description: "The supervisor group map: hosting external CLI agents in terminals, deriving deterministic stall evidence, and keeping plans and checkpoints durable — for users and maintainers navigating the group."
kind: "package-group"
---

# supervisor/ — supervised-terminal capability family

English | [中文](README.zh.md)

## Summary

An agent that runs unattended for hours supervises work it does not perform itself. This group hosts other CLI agents in terminals, watches their output, and keeps enough durable state that an interrupted run resumes instead of restarting. The supervising model stays in the harness loop; these packages only host, scan, and persist. The capability ships as one bundle of six switchable components, and the core component publishes the shared state that planning, orchestration, operations, and shutdown read.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

| Package | Role | ctx key |
|---|---|---|
| [`supervisor`](supervisor/README.md) | The installable bundle: six independently switchable components, and the rule for adding another | — (`dsh.bundle.patch`) |
| [`supervisor-core`](supervisor-core/README.md) | Hosts CLI agents in terminals, derives deterministic state marks and L1 rule hits, and stores heartbeats, output logs, and task plans | `ctx.supervisor` |
| [`supervisor-tasks`](supervisor-tasks/README.md) | Plan authoring with subtask graphs, git checkpoints with retention, and review tickets with redo briefs | `ctx.supervisorTasks` |
| [`supervisor-orchestration`](supervisor-orchestration/README.md) | Skill inventories, phase-based model switching, worktree isolation, and bounded parallel dispatch | registers on `ctx.tools` |
| [`supervisor-ops`](supervisor-ops/README.md) | Usage budget, delivery reports, chat notifications, and the shutdown gate | `ctx.supervisorOps` |
| [`supervisor-pacing`](supervisor-pacing/README.md) | Automatic pacing for the supervising agent itself: cross-turn resume after a failed model request, with a bounded budget | registers on `ctx.tools` |
| [`supervisor-shutdown`](supervisor-shutdown/README.md) | Runs the operator's shutdown command once the run is over: wall clock or countdown, completed task plans, an idle timeout, chat reminders, and a cancel path | registers on `ctx.tools` |

-----

<a id="related-documentation"></a>
## Related documentation

- [Supervised terminals subsystem](../../docs/subsystems/supervisor.md) — the marks, rule hits, plan subtasks, and stored records a consumer reads.
- [Terminal sessions subsystem](../../docs/subsystems/terminal.md) — the PTY service these packages drive, and the only owner of session creation.
- [Supervised terminals as a plugin Agent Note](../../.agents/notes/implemented/architecture/2026-10-06-supervised-terminal-plugin.md) — why supervision is an opt-in plugin rather than loop machinery.

-----

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
