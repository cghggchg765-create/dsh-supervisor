---
description: "Power the machine off when a supervised run is over: arm a wall clock, a countdown, a completed-plan watcher, or an idle timeout, remind the chat before the deadline, and run the operator's shutdown or cancel command."
kind: "package-reference"
---

# @deepseek-ai/dsh-supervisor-shutdown

English | [中文](README.zh.md)

## Summary

`supervisor-shutdown` ends a supervised run the way the operator configured: it waits for one armed condition, reminds the chat before the deadline, then runs the operator's own command through the shell seam. Use it for an overnight or batch run that should release the machine once the work is done; leave it off when a person closes the machine themselves. Nothing happens until an operator enables the shutdown gate in `supervisor-ops` and supplies a command, and `dryRun` reports what would run without running it. The model can arm, inspect, and cancel attempts, but never enable the gate.

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

The component mounts as a row in a supervised composition; the [`supervisor` bundle](../supervisor/README.md) inserts it with `enabled: false`, and a profile patch turns it on with the fields this deployment needs:

```yaml
- id: supervisor-shutdown
  config:
    enabled: true
    scheduleAfterMinutes: 90
    remindAtMin: [30, 10, 1]
    cancelCommand: 'shutdown /a'
    notifyChatId: 'oc_…'
```

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `false` | Whether this component schedules and executes shutdowns at all. |
| `scheduleAt` | empty | Local `HH:MM` wall clock the timed attempt is armed for; empty disables it. |
| `scheduleAfterMinutes` | `0` | Minutes from plugin load the timed attempt is armed for; `0` disables it. |
| `scheduleAfterSeconds` | `0` | Seconds from plugin load; a configured value wins over the minutes one. |
| `watchPlans` | `false` | Arm once every stored task plan finished its subtasks, and drop the attempt when work reopens. |
| `idleTimeoutMin` | `0` | Arm after this many minutes without a running agent; `0` disables it. |
| `remindAtMin` | `[10, 5, 1]` | Chat reminders, in minutes before the attempt fires. |
| `cancelCommand` | empty | Operator command that cancels a shutdown the OS already scheduled; empty skips cancellation. |
| `notifyChatId` | empty | Conversation reminders and reports are sent to; empty keeps them in the log. |
| `dryRun` | `false` | Report what would run instead of running it. |
| `pollIntervalSec` | `30` | Seconds between watcher passes. |
| `commandTimeoutSec` | `30` | Seconds one configured command may run before it is killed. |

### The operator owns the gate

The component never invents a command. `@deepseek-ai/dsh-supervisor-ops` resolves `shutdown.enabled`, `shutdown.command`, and `shutdown.gracePeriodMin`, and this component asks that gate when an armed attempt fires. An unconfigured or disabled policy refuses every attempt with the gate's reason in the log, and nothing runs.

```yaml
- id: supervisor-ops
  config:
    shutdown:
      enabled: true
      command: 'shutdown /s /t 60'
      gracePeriodMin: 5
```

| Platform | Shutdown command | Cancel command |
|---|---|---|
| Windows | `shutdown /s /t 60` | `shutdown /a` |
| Linux | `systemctl poweroff` | — |
| macOS | `osascript -e 'tell app "System Events" to shut down'` | — |

### When to choose it

Choose it for an unattended run whose machine should not stay awake after the work: an overnight coding session, a batch job that finishes at an unknown time, or a supervised run whose plans are the completion signal. Leave it off when someone is watching the run, and keep `dryRun: true` while tuning a schedule — it reports the exact command the gate would run.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Gate and execution

The operator's policy and this component's timing are separate concerns. `supervisor-ops` owns `shutdown.enabled`, the command, and the grace period; this component owns when an attempt is made, the reminders before it, and the cancel path. Every attempt asks the gate at fire time, so a policy disabled after arming still refuses, and the refusal names its reason.

### The four arming paths

A timed attempt comes from `scheduleAt` (the next local occurrence of that clock, resolved at plugin load) or from `scheduleAfterMinutes`/`scheduleAfterSeconds`, and the model can arm the same trigger through `supervisor_power schedule`. With `watchPlans`, a watcher pass arms once every stored plan's subtasks are `completed` or `skipped`, and drops the attempt again when work reopens. With `idleTimeoutMin`, a pass arms once no `agent/status` transition has reported `running` for that long. The model's `confirm` action is the fourth path: it asserts the work is done and arms the plan trigger. The plan and idle triggers additionally wait out the operator's grace period, which is measured from the recorded completion instant or the last running agent.

### Reminders and cancellation

Each attempt remembers the reminder thresholds it was already inside when armed, so a countdown armed six minutes out never back-reports the ten-minute line, and every threshold fires once per attempt. Cancellation clears the timer and runs `cancelCommand` even when nothing was armed, because an earlier run may have left the operating system with a pending shutdown of its own. `dryRun` replaces every command execution with a report line.

### Why no invariant companion is published

No invariant companion is published: the component owns no service, no durable record, and no second observer. Its only state is a private timer and the attempt bookkeeping around it, which the operator observes through the same log and chat lines the component writes, so no independent observation exists to cross-check.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Supervised terminals bundle](../supervisor/README.md) — the profile layer that mounts this row beside the other supervisor components.
- [Operations](../supervisor-ops/README.md) — the component that owns the shutdown gate, the operator command, and the chat transport.
- [Task plans](../supervisor-tasks/README.md) — the stored plans the completion watcher reads.
- [Supervised terminal core](../supervisor-core/README.md) — the control plane whose `ctx.supervisor` supplies the stored plans this component's watcher reads.
- [Shell executables](../../shell/shell/README.md) — the seam the operator's shutdown and cancel commands run through.

-----

<a id="model-experience"></a>
## Model Experience

### The power tool result

#### What the model sees

One text block per `supervisor_power` call, rendered from the canonical result instead of the raw object:

##### Armed text

```markdown
shutdown armed ({detail}); fires at {firesAt}
```

##### Unarmed text

```markdown
no shutdown pending: {reason}
```

#### Token effect

Conditional: at most one short line per `supervisor_power` call, and only when the model invokes the tool or the supervising agent asks it to check.

#### KV Cache effect

Append-only. The result is a new tool-role message at the end of the conversation; the tool schema itself is stable across calls, so earlier request tokens stay reusable.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **The harness cannot stop a machine whose OS already started counting down** — once the operator's command begins a system countdown, only the operator's `cancelCommand` can call it off; this component has no other lever.
- **An unconfigured policy means nothing happens** — the component never invents a command, so a deployment that arms an attempt but leaves `supervisor-ops`'s `shutdown.command` empty gets refusal lines instead of a power-off.
- **The model can arm an attempt but never enable the gate** — enabling shutdown, choosing the command, and the grace period are operator configuration; `supervisor_power` cannot change them.
- **No GUI countdown exists in a headless harness** — the remaining time is visible through `supervisor_power status`, the log, and the configured chat conversation, not as a browser or desktop countdown.
- **The attempt bookkeeping lives in memory** — a restart forgets a spent condition, the recorded completion instant, and the idle clock, so a completed plan set can arm a fresh attempt after a restart.
- **A configured wall clock is resolved once at plugin load** — `scheduleAt` is not re-armed after its attempt fires or is cancelled; a long-running process keeps only the countdown, plan, and idle paths.
- **Idle time only sees the harness's own agents** — any other process on the machine is invisible to `idleTimeoutMin`, so work outside the harness does not postpone the attempt.

-----

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The decision core (`src/power.ts`) is pure — plan progress, the next wall-clock instant, and the owed reminders — so the timing is testable without a clock. The scheduler in `src/index.ts` resolves its services once at apply and drives them from one interval, and the plugin test covers the timing under a fake clock with `dryRun: true`. The gate itself lives in `@deepseek-ai/dsh-supervisor-ops`'s `shutdown.ts`; new refusal reasons belong there, not here.

</details>
