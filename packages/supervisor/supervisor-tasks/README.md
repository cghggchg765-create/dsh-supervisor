---
description: "Durable task state for supervised runs: plan authoring with subtask graphs, git checkpoints with retention and restartable branches, and review tickets that carry blocking findings into a redo brief."
kind: "package-reference"
---

# @deepseek-ai/dsh-supervisor-tasks

English | [中文](README.zh.md)

## Summary

`supervisor-tasks` is the durable-state component of the supervised-terminal bundle. It turns a reviewed plan into records an interrupted run can resume from: plan authoring that rejects subtask cycles, git checkpoints on a restartable branch, and review tickets whose findings become a redo brief for the responsible agent. It publishes the `supervisorTasks` service — checkpoints, tickets, and git operations — and registers four tools.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Install the bundle that carries it — [`@deepseek-ai/dsh-supervisor`](../supervisor/README.md) — from the Plugins page or with `dsh plugin --profile <name> add <spec>`. The component reads `stateDir` and `workspaceDir` from `ctx.supervisor.config`, so it has no path of its own; a profile that sets one state directory configures every component at once.

### Configuration

A profile patch targets the row id `supervisor-tasks` and replaces the whole `config`:

```yaml
- id: supervisor-tasks
  config:
    checkpointBranchPrefix: 'supervisor/'
    checkpointMaxPerTask: 10
    checkpointMaxAgeDays: 30
    maxRetriesPerIssue: 2
```

| Field | Default | Meaning |
|---|---|---|
| `checkpointBranchPrefix` | `supervisor/` | Prefix of the branch a checkpoint commits on. |
| `checkpointMaxPerTask` | `10` | Checkpoints kept per task; the oldest are removed first. |
| `checkpointMaxAgeDays` | `30` | Age after which a checkpoint is removed. |
| `maxRetriesPerIssue` | `2` | Repairs allowed per issue ticket before it escalates. |

### The working loop

Write the plan with `supervisor_plan`, take a checkpoint with `supervisor_checkpoint` at each meaningful step, and — when a round of work needs judgement — assemble the evidence with `supervisor_review`, record what the review found with `supervisor_issue`, and let the ticket drive the repair until it resolves or escalates. `supervisor_checkpoint action restore` returns the recorded terminal state so a resumed run knows which terminal and model a checkpoint came from.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### What this component owns, and what it borrows

The plan store, the supervised sessions, the output logs, and every shared path belong to the control plane (`ctx.supervisor`); this component reads them. It owns the checkpoint store (`checkpoints/<task>/<checkpointId>.json`), the review tickets (`tickets/<task>/<ticketId>.json`), their retention, and one `GitRunner` shared with the components that need git.

### Checkpoints commit code, not state

`supervisor_checkpoint` resolves the repository from the resolved `cwd`, moves the `<prefix><taskId>` branch, and stages with `git add -A`. The state directory and the worktree base are excluded whenever they sit inside that repository, because `restore` runs `git reset --hard`: a committed state directory would let an older checkpoint delete every newer plan, checkpoint, and ticket. A checkpoint taken outside a repository still records its task, step, and terminal state; only the git facts are absent.

### Review packets and the ticket lifecycle

`supervisor_review` assembles one Markdown packet from the plan with its acceptance criteria, the checkpoints taken, the diff of the task's commit range (`baseCommit` to `headCommit`, defaulting to the newest checkpoint commit), and a bounded tail of the supervised terminal's output log; a missing plan, diff, or log is named as such rather than omitted. The supervising model judges that packet and records findings with `supervisor_issue`. A ticket stores its findings, regression scope, and redo instructions, and moves through `open`, `in-redo`, `in-regression`, `resolved`, and `escalated`: `redo` and `regression-failed` each spend one repair from `maxRetriesPerIssue` and escalate the ticket once the budget is spent, `regression-passed` resolves it, and while the ticket is under repair the result carries a `redoBrief` rendered without code fences so it survives a paste into the responsible agent's terminal. Findings at `blocking` or `high` severity are the blocking set the result counts.

### Why no invariant companion is published

No invariant companion is published: the records this component writes are self-describing files, so a consumer re-derives their content from the same inputs and no independent observation exists to cross-check.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Supervised terminals bundle](../supervisor/README.md) — the six components and the profile rows that mount them.
- [Supervised terminal core](../supervisor-core/README.md) — the control plane that owns sessions, plans, and every shared path.
- [Supervised terminals subsystem](../../../docs/subsystems/supervisor.md) — the plan subtask, checkpoint, and ticket records a consumer reads.

-----

<a id="model-experience"></a>
## Model Experience

### Tool schemas

#### What the model sees

Four tools are registered while this component is loaded: `supervisor_plan`, `supervisor_checkpoint`, `supervisor_review`, and `supervisor_issue`. Their parameters and descriptions are listed in the generated [tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-supervisor-tasks). `supervisor_plan` and `supervisor_issue` carry the largest input schemas of the bundle, because the plan document and the finding list are nested objects.

#### Token effect

Fixed: the four schemas are present in every request while the component is loaded, whether or not the model calls them. Loading or unloading the component adds or replaces this block.

#### KV Cache effect

Append-only. Schema text is owner-stable, so it extends a reusable prefix rather than replacing earlier request tokens. Changing any tool description or parameter changes the request prefix and invalidates reuse from that point.

### Tool results

#### What the model sees

`supervisor_plan` returns the stored plan, the subtasks that can start now (`readyToStart`), and whether the dependency edges form a DAG (`cycleDetected`). `supervisor_checkpoint` reports `checkpointId` and `commitHash` as always-present strings, empty when the action has neither, plus the recorded terminal state on `restore`. `supervisor_review` returns the packet `markdown` with its checkpoint and criterion counts and whether the diff and output tail were included. `supervisor_issue` returns the ticket id, status, retry count against its budget, blocking-finding count, the findings, and — while the ticket is under repair — a `redoBrief`.

#### Token effect

Conditional: the model sees this block only when it calls one of these tools. A review packet inlines a bounded log tail in its Markdown, and a redo brief is meant to be pasted into a terminal rather than read as a result.

#### KV Cache effect

Append-only. Results are new trailing messages and never rewrite earlier request tokens, so they extend an already-reusable prefix rather than invalidating it.

### Redo brief

#### What the model sees

While a ticket is under repair, `supervisor_issue` returns the brief the responsible agent is meant to receive, rendered without code fences so that a paste into a terminal is not swallowed by them:

##### Verbatim text for this field, when needed

```markdown
Redo ticket <ticketId> for task <taskId>

Status: <status>; retry <retryCount> of <maxRetries>

Instructions:
<redoInstructions or "(none given)">

Findings to repair:
- [<severity>] <title>: <suggestedFix>

Regression checks that must pass:
- <check>
```

#### Token effect

Conditional: one brief per ticket that is in repair, and only while that ticket's retry budget is unspent.

#### KV Cache effect

Append-only. The brief is part of a new tool result, so it extends the reusable prefix rather than replacing earlier tokens.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Checkpoints commit the configured workspace** — the repository is resolved from the resolved `cwd` once per call, so a checkpoint taken against the wrong `workspaceDir` moves that repository's HEAD. The state directory and the worktree base are excluded from the commit whenever they sit inside it.
- **The plan store itself lives in the control plane** — `supervisor_plan` writes through `ctx.supervisor.plans`, so a composition that mounts this component without the control plane cannot load.
- **Tickets escalate rather than block** — a ticket that exhausts `maxRetriesPerIssue` reports `escalated`; nothing stops the run or removes the worktree of a failing subtask on its own.
- **Review evidence is bounded** — the packet carries a bounded tail of the output log and the diff of a commit range, so an external artifact or an older range must be read through its own tool.

-----

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

`record-file.ts` holds the shared read/write helpers for task-scoped JSON records; a new record type belongs beside `checkpoint.ts` and `review.ts` rather than inside the tool file. The git runner is shared with orchestration and operations through this component's service, so a new git operation is added here.

</details>
