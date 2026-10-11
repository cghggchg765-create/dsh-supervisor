---
description: "Host CLI agents in harness terminals and turn their output into deterministic evidence: one session registry, the L1 detection pipeline, heartbeats, output logs, the task-plan store, and the stale-terminal watchdog."
kind: "package-reference"
---

# @deepseek-ai/dsh-supervisor-core

English | [中文](README.zh.md)

## Summary

`supervisor-core` is the control plane of the supervised-terminal bundle: it hosts external CLI agents in terminals the harness already opens, runs every settlement through one detection pipeline, and keeps the durable records an interrupted run resumes from. It publishes the `supervisor` service for its sibling components and registers six model-facing tools. It judges nothing: the supervising model reads the evidence and decides.

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

Install the bundle that carries it — [`@deepseek-ai/dsh-supervisor`](../supervisor/README.md) — from the Plugins page or with `dsh plugin --profile <name> add <spec>`. A composition that mounts this component needs a terminal backend as well, because it drives terminals but never opens one: open a terminal with the harness `terminal_open` tool, then call `supervisor_agent_launch` with that session id to put a hosted agent in it.

### Configuration

A profile patch targets the row id `supervisor` and replaces the whole `config`, so every key kept must be restated together:

```yaml
- id: supervisor
  config:
    stateDir: '/absolute/path/to/state'
    workspaceDir: '/absolute/path/to/workspace'
```

| Field | Default | Meaning |
|---|---|---|
| `stateDir` | `.supervisor` | Directory holding heartbeats, output logs, and plans; a relative path resolves against `workspaceDir`. |
| `workspaceDir` | `process.cwd()` | Directory the state directory and the default worktree base resolve against. |
| `worktreeBase` | `.worktrees` | Directory per-subtask worktrees are created under; a relative path resolves against `workspaceDir`. Read by the orchestration component. |
| `agents` | built-in templates | Per-agent-kind `startCommand`, `resumeCommand`, and `modelSwitchCommand`, merged over the defaults for `claude-code`, `codex`, `kimi-code`, `qwen-code`, `trae`, and `dsh`. |
| `defaultProfile` | `headless` | Value substituted for `{profile}`, which the `dsh` template uses. |
| `shellQuoting` | `posix` (`powershell` on Windows) | Dialect used to quote substituted `{model}`, `{prompt}`, and `{profile}` values and extra arguments. |
| `rules` | every built-in rule | Per-rule `enabled`, `severity`, and — for `goal-drift-signal` — literal `keywords`. |
| `detection` | see below | Thresholds for the window rules and for the `contextBloatBytes` bound on `context-bloat`. |
| `breaker` | `noProgressLimit` 2, `openLimit` 3, `cooldownSec` 300 | Per-session progress-breaker limits; `openLimit` must be at least `noProgressLimit`. |
| `limitResumeEnabled` | `true` | Schedule a resume when a settlement's usage-limit message names a parseable reset time. |
| `spillEnabled` | `true` | Append every observed settlement to a per-terminal output log. |
| `spillMaxBytes` | 5 GiB | Byte cap for one output log; once reached, the log stops recording and reports the cap. |
| `runTimeoutSec` | `600` | Default seconds `supervisor_terminal_run` waits for its completion marker. |
| `runPollIntervalMs` | `500` | Milliseconds between completion-marker polls of retained scrollback. |
| `heartbeatTimeoutSec` | `300` | Silence after which a terminal's heartbeat counts as stale. |
| `watchdogEnabled` | `true` | Wake an idle agent when a supervised terminal goes stale. |
| `watchdogIntervalSec` | `60` | Watchdog poll interval. |
| `watchdogCooldownSec` | `300` | Minimum interval between two watchdog notices for the same terminal. |

Detection thresholds default to `errorStreakThreshold` 3, `repeatThreshold` 3, `repeatWindowMin` 5, `maxRestarts` 3, `crashWindowMin` 10, `contextBloatBytes` 50 KiB, and `silenceThresholdSec` 30.

### When to choose it

Choose it when a task will run longer than one model turn and someone must notice when the hosted agent stops making progress. Inside a supervised terminal, `supervisor_terminal_run` is the reliable way to wait for one command to finish: it wraps the command with a unique `DONE_<random>` completion marker, assembles it in the shell so the echoed command cannot match it, and polls retained scrollback until the marker line appears or the timeout expires. `supervisor_terminal_send` waits only for the next quiet settlement, so it cannot tell a finished command from a paused one.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### The settlement pipeline

Every tool that produces a settlement — `supervisor_agent_launch`, `supervisor_terminal_send`, and `supervisor_terminal_run` — funnels it through `SupervisorRuntime.observe`, which is why they report identical marks, hits, and heartbeats for the same terminal. It touches the heartbeat, appends the output to the spill log, scans it with the stateless L1 rules, feeds the normalized text into the per-session sliding windows, classifies it against the hosted agent's characteristics, advances the progress breaker, and derives the state marks.

`supervisor_terminal_read` settles nothing, so it calls `SupervisorRuntime.inspect` instead: it scans retained scrollback and classifies it, but neither advances the heartbeat nor appends to the output log, because a poll of a stuck terminal must not pass for progress.

### Output classification

`adapter.ts` holds one literal pattern set per hosted CLI, grouped into waiting, active, error, and completion patterns, and reports exactly one `outputClass`: `waiting-input`, `working`, `error`, `completed`, or `unknown`. Waiting outranks active, active outranks error, and completion comes last, so a live prompt is not read as a failure the transcript is already handling. A terminal whose CLI was never declared is classified against the union of every waiting pattern only.

### L1 rules

| Rule | Mechanism | Default severity |
|---|---|---|
| `api-disconnect` | Transport errno names, HTTP 5xx codes, and disconnect phrases | high |
| `rate-limit` | `429`, rate-limit wording, quota wording | medium |
| `permission-prompt` | `(y/n)`, `Allow …?`, `Do you want to`, `Press Enter`, numbered menus | high |
| `model-switch-fail` | `invalid model`, `unknown model`, `model not found/available` | medium |
| `goal-drift-signal` | Configured literal keywords; disabled until keywords are set | medium |
| `empty-loop` | The same output repeats at least `repeatThreshold` times inside `repeatWindowMin`, annotated `identical` or `changing` | high |
| `error-streak` | `errorStreakThreshold` consecutive failed observations | high |
| `crash-loop` | `maxRestarts` non-zero exits inside `crashWindowMin` | critical |
| `context-bloat` | One settlement at or above `contextBloatBytes` | medium |

Rule matchers are literals in `guard.ts`. Configuration can disable a rule, change its severity, or supply literal keywords, but never supplies a regular expression: an arbitrary pattern would reach every scan with its own cost.

### Progress breaker and state marks

Each supervised terminal keeps one progress breaker. Identical settlements after normalization count as no progress; `noProgressLimit` moves it to `half-open` and `openLimit` to `open`, with `cooldownSec` bounding how long an open breaker waits before one re-probe. Settlement results and status rows report `breaker` and `breakerNoProgress`, and nothing acts on the state.

`prompt-idle`, `waiting-input`, `working`, `silence`, `exit-ok`, `exit-bad`, and `heartbeat-stale` describe what the terminal did, not whether it is healthy. `silence` means only that the wait timed out with no prompt.

### Records and the watchdog

`stateDir` holds `heartbeat/<terminal>.json`, `spill/<task>/<terminal>.log`, and `plans/<task>.json`; the sibling components add their own directories beside them. Every file is readable without the plugin.

The watchdog is the only path that reaches the model without a tool call: it steers the owning agent once when a terminal's heartbeat goes stale (repeating no more often than `watchdogCooldownSec`), and once when a parsed usage-limit reset comes due. Both notices are delivered as user-role messages, and the usage-limit schedule is cleared only after the steer lands, so a rejected steer is retried on the next sweep.

No invariant companion is published: every claim here is either a stored self-describing record or a value derived from one settlement, so a consumer can re-derive any of it from the same inputs.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Supervised terminals bundle](../supervisor/README.md) — the six components and the profile rows that mount them.
- [Terminal sessions](../../terminal/terminal/README.md) — the PTY service this package drives, and the only owner of session creation.
- [Terminal tool](../../terminal/tool-terminal/README.md) — `terminal_open`, `terminal_list`, and the rest of the harness-owned terminal surface.
- [Supervised terminals subsystem](../../../docs/subsystems/supervisor.md) — the marks, rule hits, plan subtasks, and stored records a consumer reads.

-----

<a id="model-experience"></a>
## Model Experience

### Tool schemas

#### What the model sees

Six tools are registered while this component is loaded: `supervisor_agent_launch`, `supervisor_terminal_send`, `supervisor_terminal_run`, `supervisor_terminal_read`, `supervisor_terminal_signal`, and `supervisor_status`. Their parameters and descriptions are listed in the generated [tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-supervisor-core).

#### Token effect

Fixed: the six schemas are present in every request while the component is loaded, whether or not the model calls them. Loading or unloading the component replaces this block.

#### KV Cache effect

Append-only. Schema text is owner-stable, so it extends a reusable prefix rather than replacing earlier request tokens. Changing any tool description or parameter changes the request prefix and invalidates reuse from that point.

### Terminal tool results

#### What the model sees

A settlement-producing tool returns the settlement's bounded output, its wait reason, the derived state marks (including `working` when the output carried an activity marker), the `outputClass`, the L1 hits with their `convergence` hints, the progress-breaker state (`breaker` and `breakerNoProgress`), the spill log path when one exists, `spillCapped`, and `sessionStatus`; `supervisor_terminal_run` adds `matched`, `timedOut`, `exitCode`, `marker`, and `truncated`. `supervisor_terminal_read` returns the inspected text with `outputClass`, `heartbeatAgeSec`, and `heartbeatStale` instead of settlement fields, because a read settles nothing. `supervisor_status` returns one row per supervised terminal with its heartbeat age, staleness, output class, last wait reason, and breaker state, and one row per task with its subtask counts.

#### Token effect

Conditional and capped by the terminal service's own result bound; the model sees this block only when it calls one of these tools. The spill path, not the result, carries the complete output.

#### KV Cache effect

Append-only. Results are new trailing messages and never rewrite earlier request tokens, so they extend an already-reusable prefix rather than invalidating it.

### Stale-heartbeat notice

#### What the model sees

The watchdog delivers one user-role message per stale terminal, repeating no more often than `watchdogCooldownSec`:

##### Verbatim text for this field, when needed

```markdown
[supervisor] terminal <sessionId> produced no output for <ageSec>s (timeout <heartbeatTimeoutSec>s, last wait reason "<lastWaitReason>"[, task <taskId>]). Read it with supervisor_terminal_read and decide whether to answer a prompt, interrupt it, or take a checkpoint.
```

##### Appended sentence while that terminal's progress breaker is open

```markdown
Its progress breaker is OPEN after <n> identical settlements (open for <s>s): the terminal is repeating itself, so consider a different instruction, a fresh terminal, or a human decision.
```

#### Token effect

Conditional: one message per stale terminal per cooldown, plus the breaker sentence while the breaker is open, and only when the watchdog is enabled.

#### KV Cache effect

Append-only. The notice is delivered as a new message, so it extends the reusable prefix; the interrupt it may cause at a step boundary ends that prefix for later requests rather than replacing tokens already sent.

### Usage-limit resume notice

#### What the model sees

When a settlement's output carried a usage limit with a parseable reset time, the watchdog delivers one user-role message at the scheduled instant and clears the schedule:

##### Verbatim text when a scheduled limit resume comes due

```markdown
[supervisor] terminal <sessionId> hit a usage limit that should have reset by now. Send a follow-up instruction to resume the task, or read the terminal first if the CLI left a dialog open.
```

#### Token effect

Conditional: one message per parsed limit reset, delivered once because the schedule is cleared when it fires, and only while `limitResumeEnabled` is set (the default) and the watchdog is running.

#### KV Cache effect

Append-only. The notice is delivered as a new message, so it extends the reusable prefix rather than replacing tokens already sent.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **No terminal creation** — the component drives terminals through `ctx.terminals` but never opens one, so a deployment must expose the harness `terminal_open` tool; without it there is no way to obtain the session id `supervisor_agent_launch` requires.
- **Spill logs hold observed settlements, not the raw stream** — the terminal service returns a bounded viewport per settlement, so the log is complete relative to what the supervisor observed, not relative to the child's stdout.
- **The progress breaker reports but never intervenes** — an open breaker stops nothing; it is a deterministic counter the supervising model must read and act on.
- **`empty-loop`, `error-streak`, and breaker counts are in memory only** — a restarted harness re-observes instead of resuming them, because the counters are not persisted.
- **The watchdog depends on the agent being steerable** — a disposed agent or one already driving rejects the steer; the notice is then retried on the next sweep rather than queued.

-----

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This package owns the vocabulary (`types.ts`) and the shared tool helpers (`tool-support.ts`) the five sibling components import. Behavior changes belong in the component that owns the affected tool; a change to `observe` or `inspect` changes what every terminal tool reports, so it is a cross-component change.

</details>
