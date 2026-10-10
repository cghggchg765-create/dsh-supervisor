---
description: "Keep supervised runs moving: per-agent skill inventories with matching, phase-based model switching through the hosted CLI, git worktrees that isolate parallel subtasks, and bounded parallel dispatch."
kind: "package-reference"
---

# @deepseek-ai/dsh-supervisor-orchestration

English | [中文](README.zh.md)

## Summary

`supervisor-orchestration` is the scheduling-shaped component of the supervised-terminal bundle. It scans the hosted CLIs' own skill roots, switches a hosted CLI's model by task phase through that CLI's in-session command, gives each parallel subtask its own git worktree, and reports the next batch the configured concurrency allows. It publishes no service: it registers four tools against `ctx.supervisor` (the control plane) and `ctx.supervisorTasks` (git operations).

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

Install the bundle that carries it — [`@deepseek-ai/dsh-supervisor`](../supervisor/README.md) — from the Plugins page or with `dsh plugin --profile <name> add <spec>`. The component mounts on top of the control plane and the task services, and it reads `stateDir`, `workspaceDir`, and `worktreeBase` from `ctx.supervisor.config`, so it has no path of its own to configure.

### Configuration

A profile patch targets the row id `supervisor-orchestration` and replaces the whole `config`:

```yaml
- id: supervisor-orchestration
  config:
    modelRules:
      - phases: [planning, reasoning]
        model: opus
        fallbackModels: [sonnet]
    skillRoots:
      homeDir: '/home/operator'
      workspaceDir: '/path/to/workspace'
    maxConcurrency: 4
```

| Field | Default | Meaning |
|---|---|---|
| `modelRules` | none | Phase-to-model rules for `supervisor_agent_switch`; each rule names the phases it covers, the model, and optional `fallbackModels`. An unknown phase, a phase claimed by two rules, or a blank model refuses the load. |
| `skillRoots.homeDir` | OS home directory | Directory each agent's home skill root resolves under. |
| `skillRoots.workspaceDir` | the control plane's `workspaceDir` | Directory each agent's project-local skill root resolves under. |
| `worktreeBranchPrefix` | `supervisor/` | Prefix of the branch each worktree checks out. |
| `maxConcurrency` | `4` | Subtasks `supervisor_dispatch` may report as startable at once. |

### Skill roots per agent kind

`supervisor_skills` reads each kind's own layout rather than one shared directory: `<home>/.claude/skills` and `<workspace>/.claude/skills` for Claude Code, the same two under `.codex` for Codex, `<home>/.<kind>/skills` for `kimi-code`, `qwen-code`, and `trae`, and `<workspace>/.agents/skills` plus the `@deepseek-ai/dsh-skill-<name>` packages declared in `<workspace>/cordis.yml` for `dsh`. A missing or unreadable root is skipped, and an agent with no readable root reports `available: false` instead of failing the scan.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Model switching by phase

`switch.ts` validates `modelRules` at load and resolves each phase to its candidate models, most preferred first. `switchCommands` renders the hosted CLI's `modelSwitchCommand` once per candidate — `{model}` is the only placeholder, internal whitespace is collapsed, and blank or duplicate commands are dropped — and the tool sends each candidate in turn, advancing only when the settlement carries a `model-switch-fail` L1 hit. An empty or missing template yields no commands, and the result then says the CLI must be relaunched with the candidate model instead.

### Skill inventories

`skills.ts` reads the roots listed above, treats one directory name as one skill (a `.md` file's basename for every kind but `dsh`), and caches one inventory per agent kind under `skills/<agentKind>.json` in the control plane's state directory, which is what `action: list` reads. When `requiredSkills` is given, the result ranks each agent kind by how many of those skills its inventory holds (`matched` and `missing`), and the best match adds a `brief` block to paste into the launch prompt.

### Worktrees, dispatch, and integration

`WorktreeManager` records only worktrees below the configured base directory, so a listing never claims a worktree this component did not create, and the branch repeats the sanitized ids so it always names the worktree path git was handed. `supervisor_dispatch` reports the next batch: pending subtasks whose dependencies are complete, minus the ids passed in `active`, capped by `remaining` concurrency slots, plus the pending and blocked counts. `integrate` reads the stored plan, merges every subtask branch in dependency order with `git merge --no-ff` under a fixed committer identity, and stops at the first failure: `merged` lists the subtasks that landed and `failed` names the one whose merge stopped the run. `integrationOrder` sorts dependencies-first and throws on a dependency cycle.

### Why no invariant companion is published

No invariant companion is published: every claim this component makes is either a record owned by another component or a value derived from one scan or one settlement, so a consumer re-derives it from the same inputs and no independent observation exists to cross-check.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Supervised terminals bundle](../supervisor/README.md) — the six components and the profile rows that mount them.
- [Supervised terminal core](../supervisor-core/README.md) — the control plane this component reads sessions, plans, and paths from.
- [Supervised terminals subsystem](../../../docs/subsystems/supervisor.md) — the marks, rule hits, plan subtasks, and stored records a consumer reads.
- [Terminal tool](../../terminal/tool-terminal/README.md) — `terminal_open`, the only owner of session creation.

-----

<a id="model-experience"></a>
## Model Experience

### Tool schemas

#### What the model sees

Four tools are registered while this component is loaded: `supervisor_skills`, `supervisor_agent_switch`, `supervisor_worktree`, and `supervisor_dispatch`. Their parameters and descriptions are listed in the generated [tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-supervisor-orchestration).

#### Token effect

Fixed: the four schemas are present in every request while the component is loaded, whether or not the model calls them. The `supervisor_worktree` schema is the largest, because it enumerates the create/list/remove/integrate actions with their arguments. Loading or unloading the component adds or replaces this block.

#### KV Cache effect

Append-only. Schema text is owner-stable, so it extends a reusable prefix rather than replacing earlier request tokens. Changing any tool description or parameter changes the request prefix and invalidates reuse from that point.

### Tool results

#### What the model sees

`supervisor_skills` returns the per-agent inventories and, for `requiredSkills`, the ranked `matched` and `missing` skills plus a launch-prompt `brief`. `supervisor_agent_switch` returns `switched`, the accepted command in `model`, every command tried in `attempted`, and a `reason` when nothing switched, beside the last settlement's fields. `supervisor_worktree` returns worktree paths and branches, the `merged` subtasks, and the subtask named in `failed` that stopped integration. `supervisor_dispatch` returns the ready `batch`, the pending and blocked counts, and the configured concurrency. The `brief` is generated by this package in Chinese, one line per matched skill:

##### Verbatim text of the launch-prompt brief

```markdown
请使用以下技能完成：
- <skill>
```

#### Token effect

Conditional: the model sees this block only when it calls one of these tools. Skill briefs and worktree listings are bounded by the plan and by the number of worktrees this component created.

#### KV Cache effect

Append-only. Results are new trailing messages and never rewrite earlier request tokens, so they extend an already-reusable prefix rather than invalidating it.

### Model-switch rejection evidence

#### What the model sees

Every candidate command that the hosted CLI rejects contributes a `model-switch-fail` L1 hit to the settlement the tool reports, so the model can see which model names the CLI refused:

##### Verbatim result text for this field, when needed

```markdown
switched to <model> via <candidate -> candidate>
not switched: every candidate model was rejected by the hosted CLI
```

#### Token effect

Conditional and bounded by the number of candidates in the rule: one settlement per candidate, and only when the model asks for a switch.

#### KV Cache effect

Append-only. Each rejected candidate adds a new trailing tool result instead of rewriting the previous one.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **No scheduler** — nothing starts a task on a clock; `supervisor_dispatch` reports what may start next, and the supervising model or the operator issues the launches.
- **A CLI without an in-session switch command must be relaunched** — `supervisor_agent_switch` can only send the configured `modelSwitchCommand`, so a CLI whose template has none is reported as needing a relaunch with the chosen model.
- **Worktree merges are serialized and stop at the first failure** — integration merges one subtask branch at a time in dependency order, so a conflict leaves every later branch unmerged and the run needs a manual resolution before integration is retried.
- **Skill inventories reflect the roots that existed at scan time** — `action: list` reads the cache, so a skill installed after a scan is invisible until the next `action: scan`.

-----

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This component owns no durable record of its own: the skill cache is the one exception, and it is a cache, not a source of truth. Its git operations come from `ctx.supervisorTasks.git` so that worktrees, checkpoints, and review diffs share one runner.

</details>
