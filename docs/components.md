# Components

The bundle `@deepseek-ai/dsh-supervisor` ships six independently switchable component packages, one `cordis.patch.yml` row each. This page documents each component's purpose, tools, published service, and every `Config` field with its default, as declared in each package's `src/index.ts`.

Row ids and tool names are exact; a profile patch addresses a component only through its row id.

| Row id | Package | ctx service | Tools |
|---|---|---|---|
| `supervisor` | `@deepseek-ai/dsh-supervisor-core` | `ctx.supervisor` | 6 |
| `supervisor-tasks` | `@deepseek-ai/dsh-supervisor-tasks` | `ctx.supervisorTasks` | 4 |
| `supervisor-orchestration` | `@deepseek-ai/dsh-supervisor-orchestration` | — | 4 |
| `supervisor-ops` | `@deepseek-ai/dsh-supervisor-ops` | `ctx.supervisorOps` | 4 |
| `supervisor-pacing` | `@deepseek-ai/dsh-supervisor-pacing` | — | 0 |
| `supervisor-shutdown` | `@deepseek-ai/dsh-supervisor-shutdown` | — | 1 |

## `supervisor` — `@deepseek-ai/dsh-supervisor-core`

Hosts external CLI agents in terminal sessions, derives deterministic state marks and L1 rule hits from their output, and stores heartbeats, output logs, and task plans. It is the only required component: the other five read the state and paths it publishes.

**Service.** `ctx.supervisor` (`SupervisorRuntime`). It owns the supervised-session registry, the detection pipeline every terminal tool settles through, the heartbeat store, the spill log, the plan store, and the heartbeat watchdog.

**Tools.**

| Tool | What it does |
|---|---|
| `supervisor_agent_launch` | Launch a managed CLI agent (`claude-code`, `codex`, `kimi-code`, `qwen-code`, `trae`, `dsh`) inside an existing terminal session and hand it the task prompt. |
| `supervisor_terminal_send` | Send text to a supervised terminal and wait for the next settlement. |
| `supervisor_terminal_run` | Send one shell command and wait until it finishes, detected by a unique marker echoed afterwards. |
| `supervisor_terminal_read` | Read retained scrollback without sending anything, and scan it for L1 rule hits. |
| `supervisor_terminal_signal` | Send a signal (for example SIGINT) to a supervised terminal, optionally closing it afterwards. |
| `supervisor_status` | Report every watched terminal: heartbeat age, staleness, last status, and task subtask progress. |

**Config.**

| Field | Default | Meaning |
|---|---|---|
| `stateDir` | `.supervisor` | Directory holding plans, heartbeats, and spill logs. A relative path resolves against `workspaceDir`. |
| `workspaceDir` | process working directory | Working directory the state directory is resolved against. |
| `worktreeBase` | `.worktrees` | Directory worktrees are created under; a relative path resolves against `workspaceDir`. |
| `agents` | `{}` | Per-agent launch templates merged over the built-in defaults. Each entry takes `startCommand` (required, non-empty), `resumeCommand`, and `modelSwitchCommand`. |
| `defaultProfile` | `headless` | Profile substituted into `{profile}`; the built-in `dsh` template uses it. |
| `shellQuoting` | `powershell` on Windows, `posix` elsewhere | Shell dialect used to quote substituted launch values. Also accepts `none`. |
| `rules` | `[]` | L1 rule overrides; an entry names a built-in rule `id` (unknown ids throw at load) plus optional `enabled`, `severity` (`low`/`medium`/`high`/`critical`), and `keywords` (which replace the matcher of `goal-drift-signal`). |
| `detection.errorStreakThreshold` | `3` | Consecutive failed observations that raise `error-streak`. |
| `detection.repeatThreshold` | `3` | Repeated identical observations inside the window that raise `empty-loop`. |
| `detection.repeatWindowMin` | `5` | Window length in minutes for `empty-loop` and `error-streak`. |
| `detection.maxRestarts` | `3` | Non-zero exits inside the crash window that raise `crash-loop`. |
| `detection.crashWindowMin` | `10` | Crash window length in minutes. |
| `detection.contextBloatBytes` | `51200` (50 KiB) | Bytes in one settlement that raise `context-bloat`. |
| `detection.silenceThresholdSec` | `30` | Seconds without output after which a settlement is marked `silence`. |
| `breaker.noProgressLimit` | `2` | Consecutive identical settlements that move the progress breaker `closed` to `half-open`. |
| `breaker.openLimit` | `3` | Consecutive identical settlements that move it `half-open` to `open`; must be at least `noProgressLimit`. |
| `breaker.cooldownSec` | `300` | Seconds an open breaker waits before allowing one re-probe. |
| `limitResumeEnabled` | `true` | Whether a parsed usage-limit reset schedules an automatic resume from the watchdog. |
| `spillEnabled` | `true` | Append every observed settlement to a per-terminal log. |
| `spillMaxBytes` | `5368709120` (5 GiB) | Byte cap for one terminal's spill log. |
| `runTimeoutSec` | `600` | Default seconds `supervisor_terminal_run` waits for its completion marker. |
| `runPollIntervalMs` | `500` | Milliseconds between completion-marker polls. |
| `heartbeatTimeoutSec` | `300` | Seconds without output after which a heartbeat counts as stale. |
| `watchdogEnabled` | `true` | Start the watchdog that wakes an idle agent when a terminal goes quiet. |
| `watchdogIntervalSec` | `60` | Watchdog poll interval in seconds. |
| `watchdogCooldownSec` | `300` | Seconds between watchdog alerts for the same terminal. |

The built-in L1 rule ids an override may name are `api-disconnect`, `rate-limit`, `permission-prompt`, `model-switch-fail`, `goal-drift-signal`, `empty-loop`, `error-streak`, `crash-loop`, and `context-bloat`.

## `supervisor-tasks` — `@deepseek-ai/dsh-supervisor-tasks`

Plan authoring with subtask graphs, git checkpoints with retention, and review tickets that carry findings into a redo brief. It stores its records under the core's state directory; the core owns every shared path.

**Service.** `ctx.supervisorTasks` (`SupervisorTaskService`), holding the checkpoint store, the ticket store, and the git runner.

**Tools.**

| Tool | What it does |
|---|---|
| `supervisor_plan` | Persist, read, or update the plan for a task: decompose the goal into independently verifiable subtasks, then update subtask status. |
| `supervisor_checkpoint` | Create, list, or restore a task checkpoint pinning the git commit, terminal state, and output log. |
| `supervisor_review` | Assemble one review round's evidence: plan and acceptance criteria, checkpoints, and the task's diff. |
| `supervisor_issue` | Record a review round as an issue ticket and walk it through repair, escalating when the repair budget is spent. |

**Config.**

| Field | Default | Meaning |
|---|---|---|
| `checkpointBranchPrefix` | `supervisor/` | Prefix of the branch each checkpoint commits on. |
| `checkpointMaxPerTask` | `10` | Checkpoints kept per task; the oldest are removed first. |
| `checkpointMaxAgeDays` | `30` | Days a checkpoint is kept before retention removes it. |
| `maxRetriesPerIssue` | `2` | Repairs allowed per issue ticket before it escalates. |

## `supervisor-orchestration` — `@deepseek-ai/dsh-supervisor-orchestration`

Per-agent skill inventories with matching, phase-based model switching through the hosted CLI's own in-session command, worktree isolation for parallel subtasks, and bounded parallel dispatch.

**Service.** None. It registers four tools on `ctx.tools` and reads `ctx.supervisor` and `ctx.supervisorTasks`.

**Tools.**

| Tool | What it does |
|---|---|
| `supervisor_skills` | Scan the hosted CLIs for their loaded skills, cache the inventories, and rank them against a subtask. |
| `supervisor_agent_switch` | Switch a hosted CLI's model by sending its configured in-session switch command and checking the answer for a rejection. |
| `supervisor_worktree` | Give each subtask its own git worktree, and merge finished branches back in dependency order. |
| `supervisor_dispatch` | Report the next batch of subtasks to start: dependencies complete, capped by the configured concurrency and the subtasks already running. |

**Config.**

| Field | Default | Meaning |
|---|---|---|
| `modelRules` | `[]` | Phase-to-model rules. Each rule takes `model` (required) plus `fallbackModels` and the `phases` it claims, drawn from `planning`, `reasoning`, `verification`, `coding`, `execution`, and `retrieval`. An unknown phase, or a phase claimed twice, throws at load. |
| `skillRoots.homeDir` | the OS home directory | Operator home the per-agent skill roots resolve under. |
| `skillRoots.workspaceDir` | the core `workspaceDir` | Workspace the project-local skill roots resolve under. |
| `worktreeBranchPrefix` | `supervisor/` | Prefix of the branch each worktree checks out. |
| `maxConcurrency` | `4` | Terminals `supervisor_dispatch` may start at once. |

## `supervisor-ops` — `@deepseek-ai/dsh-supervisor-ops`

Usage budget accounting with a model price table and a downgrade-or-stop policy, delivery reports assembled from plans, checkpoints, and git statistics, chat notifications over a deployment-provided transport, and the shutdown gate. The gate never runs an OS command itself; it reports the operator's command and whether a trigger permits it.

**Service.** `ctx.supervisorOps` (`SupervisorOpsService`), holding the usage ledger, the report store, and the chat bridge seam. A deployment registers its chat transport through `useChatTransport`; without one, `supervisor_notify` reports that no transport is registered.

**Tools.**

| Tool | What it does |
|---|---|
| `supervisor_budget` | Record what one hosted agent reported spending and read the running totals against the task and daily budgets. |
| `supervisor_notify` | Push one notification to a chat conversation through the registered transport. |
| `supervisor_shutdown` | Report whether the machine may be shut down now, and which operator command would run. |
| `supervisor_report` | Render and store the delivery report for a finished task from the stored plan, checkpoints, and git statistics. |

**Config.**

| Field | Default | Meaning |
|---|---|---|
| `budget.taskBudgetUSD` | `5` | Dollars allowed for one task. |
| `budget.dailyBudgetUSD` | `20` | Dollars allowed per calendar day. |
| `budget.alertThresholdPct` | `80` | Percentage of a budget at which the caller is warned. |
| `budget.onExceed` | `downgrade-all` | Action the supervising model should take once a budget is exceeded; the other value is `stop-task`. |
| `modelPrices` | `[]` | Price table turning token counts into money. Each entry takes `model` (required, non-empty) and `usdPerMillionTokens` (required, positive). |
| `shutdown.enabled` | `false` | Whether shutdown is permitted at all. |
| `shutdown.command` | `""` | Operator-supplied command to run; empty means shutdown is not configured. |
| `shutdown.gracePeriodMin` | `5` | Minutes to wait after the last task finishes before shutting down. |

## `supervisor-pacing` — `@deepseek-ai/dsh-supervisor-pacing`

Automatic pacing for the supervising agent itself. When its own model request fails, this component waits out the stated reset or a bounded backoff, re-arms a goal the failure disarmed, and wakes the agent for one more turn, within a per-session budget and with a chat alert when it gives up. It never hooks `agent/request-error`; in-step retries belong to `dsh-llm-retry`.

**Service.** None, and it registers no tool. It observes `agent/error`, `agent/created`, `agent/disposed`, and `session/event`, and stores its fold state in a session projection.

**Config.**

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Whether automatic pacing runs at all. |
| `scope` | `roots` | Agents paced: the roots a human drives, or `all` agents including subagents. |
| `codes` | `["RATE_LIMIT", "SERVER", "TIMEOUT", "TRANSPORT", "EMPTY_RESPONSE", "INTERRUPTED"]` | Failure codes pacing resumes; any other code is reported and left alone. An empty list throws at load. |
| `initialDelayMs` | `1000` | First backoff delay for a failure that states no resume instant. |
| `maxDelayMs` | `10000` | Ceiling for a computed backoff delay; must be at least `initialDelayMs`. |
| `jitterRatio` | `0.1` | Fraction of a backoff delay applied as symmetric jitter. |
| `bufferMs` | `120000` | Wait added past a stated reset before resuming. |
| `maxResumeDelayMs` | `21600000` (6 h) | Longest resume delay honored; a later stated instant is clamped to it. |
| `minIntervalMs` | `60000` | Minimum spacing between two automatic resumes for one session. |
| `maxResumesPerSession` | `3` | Consecutive automatic resumes allowed before pacing gives up. |
| `resumeGoals` | `true` | Re-arm an active goal the failure disarmed, so its rounds continue. |
| `resumeOnRestart` | `false` | Resume a session whose last turn failed before this process started. |
| `notifyOnGiveUp` | `true` | Report a give-up to the chat transport, when one is registered. |
| `notifyChatId` | `""` | Conversation a give-up alert is sent to; empty disables the alert. |

## `supervisor-shutdown` — `@deepseek-ai/dsh-supervisor-shutdown`

Runs the operator's shutdown command once the run is over. It owns when an attempt is made (a wall clock, a countdown, every task plan finished, an idle timeout, or the supervising model asserting completion), the chat reminders before it fires, execution through `ctx.shell`, and the cancel path. It runs nothing the operator did not configure.

**Service.** None. It registers one tool on `ctx.tools` and reads the operations gate (`ctx.supervisorOps`) and the control plane's plans (`ctx.supervisor`).

**Tools.**

| Tool | What it does |
|---|---|
| `supervisor_power` | Report or change the pending automatic shutdown: `status`, `confirm` (fire after the grace period), `schedule` (countdown in `minutes`), or `cancel`. It never changes whether shutdown is enabled or which command runs. |

**Config.**

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `false` | Whether this component schedules and executes shutdowns at all. |
| `scheduleAt` | `""` | Local `HH:MM` wall clock the timed shutdown is armed for; empty disables it. A value that is not a clock throws at load. |
| `scheduleAfterMinutes` | `0` | Minutes from plugin load the timed shutdown is armed for; `0` disables it. |
| `scheduleAfterSeconds` | `0` | Seconds from plugin load; `0` disables it, and a configured value wins over the minutes one. |
| `watchPlans` | `false` | Fire once every stored task plan finished its subtasks. |
| `idleTimeoutMin` | `0` | Fire after this many minutes without a running agent; `0` disables it. |
| `remindAtMin` | `[10, 5, 1]` | Chat reminders, in minutes before the attempt fires. |
| `cancelCommand` | `""` | Operator command that cancels a shutdown the OS already scheduled; empty skips cancellation. |
| `notifyChatId` | `""` | Conversation reminders and reports are sent to; empty keeps them in the log. |
| `dryRun` | `false` | Report what would run instead of running it. |
| `pollIntervalSec` | `30` | Seconds between watcher passes. |
| `commandTimeoutSec` | `30` | Seconds one configured command may run before it is killed. |

## Cross-component prerequisites

Two settings are owned by one component and required by another; neither is implied by the other.

1. **`supervisor-ops` — `shutdown.enabled` and `shutdown.command`.** The shutdown gate refuses every trigger while `enabled` is `false` ("auto-shutdown is disabled") or `command` is empty ("no shutdown command is configured"). The operator owns both; `supervisor_shutdown` and `supervisor_power` only report the decision and the command.
2. **`supervisor-shutdown` — `enabled` and optional `cancelCommand`.** The scheduler arms nothing unless the component's own `enabled` is `true`, even when the operations gate permits shutdown. `cancelCommand` is the operator command that cancels a shutdown the OS already scheduled; it runs on a cancel even when this component armed nothing, because an earlier run may have left the OS with a pending shutdown of its own.
