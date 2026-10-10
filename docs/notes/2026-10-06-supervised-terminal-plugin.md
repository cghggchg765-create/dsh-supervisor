# Agent Note: Supervised terminals as a plugin, not as loop machinery

Status: implemented

English | [中文](2026-10-06-supervised-terminal-plugin.zh.md)

## Problem

A model that starts a long unattended run needs something that notices when the run stops making progress: an API connection drops, a rate limit parks the CLI, a confirmation dialog waits forever, or the agent repeats itself. The harness already persists the conversation and can host other CLIs in a PTY, but nothing watched those terminals, and nothing kept an unattended run's plan, resume point, and evidence durable enough to survive an interruption.

The tempting shape is loop machinery — a supervisor stage inside `agent-loop`, or a new guard that inspects every tool call. That would put a second decision-maker beside the model and make the harness own judgement it cannot ground.

## Decision

Ship the capability as one opt-in profile bundle, `@deepseek-ai/dsh-supervisor`, that hosts other CLI agents in terminals the harness already opens, produces deterministic evidence about them, and persists what an interrupted run needs. The supervising model stays in the harness loop and decides; no component judges, calls a model, or changes `agent-loop`.

`supervisor-core/src/index.ts` registers the core plugin and the watchdog; the components' `src/tools.ts` files own the nineteen model-facing tools; `supervisor-core/src/runtime.ts` holds the resolved configuration and the one settlement pipeline every terminal tool funnels through (`observe` for a settlement, `inspect` for a plain read, which must not advance the heartbeat or append to the output log).

## Six components behind one bundle

The capability covers concerns that do not share a lifecycle: a live control plane over terminals, durable task records, scheduling-shaped orchestration, cost- and human-facing operations, automatic pacing of the supervising agent's own failed requests, and automatic shutdown of the machine once the run is over. They ship as one installable unit because an operator wants the plane rather than a la carte plumbing, and they live in separate packages because each one is switchable, configurable, and presentable on its own: the plugin manager lists one bundle with six components, each with its own title, description, icon, and enable switch, and a profile patch configures or disables one row without restating its siblings.

The split is also a seam decision. `supervisor-core` publishes `ctx.supervisor` for sessions, detection output, heartbeats, output logs, and the plan store; `supervisor-tasks` publishes `ctx.supervisorTasks` for checkpoints, tickets, and git operations; `supervisor-ops` publishes `ctx.supervisorOps` for the budget ledger, the chat transport, and the shutdown gate. Planning, orchestration, operations, pacing, and shutdown consume those services instead of importing each other's modules, so one more component costs one package, one `insert` row in the bundle's `cordis.patch.yml`, and one `dependencies` entry. Configuration follows the same rule: a path or threshold two components read lives in the core and every component reads it from `ctx.supervisor.config`, while settings only one component reads stay in that component's own `Config` schema. That is why the profile's `- id: supervisor` block configures the shared state directory once, and why every other row loads with its defaults.

## Detection stays literal

L1 detection is a fixed table of literal matchers in `src/guard.ts` and `src/adapter.ts`. Configuration may disable a rule, change its severity, or supply literal keywords; it may never supply a regular expression, because an operator- or model-supplied pattern would reach every scan with its own cost. Per-agent output classification reads the same way: one literal pattern set per hosted CLI, with waiting outranking active, active outranking error, and completion last, so a live prompt is not read as a failure the transcript is already handling.

Two deterministic counters record what the model would otherwise have to remember: the per-session progress breaker over unchanged output, and the per-task budget ledger over recorded token spend. Neither acts. They are evidence attached to tool results, and every action stays with the supervising model.

The watchdog is the only path that reaches the model without a tool call: it steers the owning agent when a supervised terminal's heartbeat goes stale, and once when a parsed usage-limit reset comes due. Everything else waits for the model to ask.

## Durable records, and what a checkpoint excludes

One state directory holds self-describing JSON: task plans, checkpoints, review tickets, skill inventories, per-terminal output logs, heartbeats, and delivery reports. Every file is readable without the plugin, so a resumed run — or a human — can reconstruct the state.

`supervisor_checkpoint` commits code, not state. It moves the `supervisor/<taskId>` branch, stages with `git add -A`, and excludes the state directory and the worktree base whenever they sit inside the repository, because restore runs `git reset --hard`: a committed state directory would make an older checkpoint delete every newer plan, checkpoint, and ticket.

No invariant companion is published. Every claim the package makes is either a stored record or a value derived from one settlement, so a consumer re-derives it from the same inputs and no independent observation exists to cross-check; the package README records that reason.

## Isolation, review, and the chat seam

Parallel subtasks get one git worktree each, and integration merges their branches in dependency order, stopping at the first conflict; merges stay serialized rather than racing. Review is a packet the model judges — plan, acceptance criteria, checkpoints, diff, terminal tail — whose findings become one ticket with a retry budget that escalates on its own.

The chat surface is a seam with the plugin's own routing on top: a deployment supplies the wire (`ChatTransport`), and `useChatTransport` routes inbound messages without one — an escalation answer returns to the asking agent, anything else steers the distinct owners of supervised terminals. A deployment that needs different routing passes its handler and takes over both jobs.

## Alternatives considered

- **Supervise inside `agent-loop` or a new guard** — the loop would own judgement about another agent's health, and every deployment would carry it. A plugin keeps supervision opt-in and leaves the loop's contract untouched.
- **Let configuration supply L1 regular expressions** — the most flexible table, and a catastrophic-backtracking hazard on every scan of every settlement. Literal patterns plus configurable severity and keywords cover the same operator need.
- **Persist the sliding windows and breaker counters** — durable counts would let a resumed harness continue a stall streak, at the cost of a file written per settlement and a schema to migrate. The platform's own repeat-tool-reminder keeps its window in memory; this follows it, and a restart re-observes.
- **Commit the whole workspace, state directory included** — the resume state would travel with the branch. `git reset --hard` on restore then deletes newer records, so the state directory stays out of the commit and on disk.
- **Ship a Feishu transport in-tree** — one less deployment step, and the harness would own credentials for, and updates to, a specific vendor wire. The seam plus routing ships instead; a deployment that wants Feishu supplies the SDK.
- **Keep one monolithic package** — one row, one `Config` schema, one README, and no cross-package service surface. It also makes every component's tools unswitchable together, gives the plugin manager a single component that repeats the bundle's own name and description, and forces each future addition into the same package's coverage and review surface.
- **Publish an invariant companion** — it would have to restate stored records or derived values, which is what the stores and the settlement pipeline already check.

## Consequences

The plugin mounts beside a terminal backend and the tool runtime, and a composition without `terminal_open` cannot use it: it never opens a terminal itself, so one owner creates sessions. Nineteen tool schemas across the six components enter every request while they are loaded, which is the price of a self-contained control plane; because each component is its own row with its own tools, a deployment that wants fewer switches off the component that owns them.

What it buys is an unattended run that leaves evidence behind: marks, hits, classifications, breaker state, budgets, plans, tickets, and a git-pinned resume point, all readable by the model that decides — and by the human who comes back in the morning.
