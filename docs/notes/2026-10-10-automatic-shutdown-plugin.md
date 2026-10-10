# Agent Note: Automatic shutdown as the supervisor bundle's sixth component

Status: implemented

English | [中文](2026-10-10-automatic-shutdown-plugin.zh.md)

## Problem

The operations component shipped the shutdown gate — the operator's `enabled`, `command`, and `gracePeriodMin`, and `supervisor_shutdown`, which decides whether a trigger permits the configured command — with nothing that acts on an allowed decision. A run that finished at 03:00 left the machine running until a human returned, because the only component that knew the work was over could answer a question and no more.

## Decision

Ship `@deepseek-ai/dsh-supervisor-shutdown` as the bundle's sixth component: a function plugin that registers `supervisor_power`, injects `ctx.shell` beside the supervisor services, and owns execution while `supervisor-ops` keeps owning the gate.

The split is deliberate. A deployment may want the usage budget, delivery reports, and a shutdown decision without giving any plugin the power to switch the machine off, and the policy belongs where the operator's configuration already lives; re-declaring `enabled`, `command`, and `gracePeriodMin` beside the executor would give one operator setting two owners. The component never invents an OS command: it runs the command the gate returns, through `ctx.shell`, under the configured `commandTimeoutSec`, and a refusal carries no command at all. It arms that command on four configured paths — a `scheduleAt` wall clock, a `scheduleAfterMinutes` or `scheduleAfterSeconds` countdown, a `watchPlans` watcher that fires when every stored plan's subtasks are `completed` or `skipped`, and an `idleTimeoutMin` stretch — plus the model's own `supervisor_power` request.

The gate is consulted when an attempt fires, not when the attempt is armed. Asking at arming time would turn "still inside the grace period" into a refusal, so a plan set that completed just now could never arm at all; asked at fire time, the same state is a not-yet.

Two more rules make the execution safe to leave running. `cancelCommand` runs even when this component armed nothing, because an earlier run may have left the OS with a shutdown timer of its own, and only the operator's cancel command stops a machine already counting down. And a fired attempt spends its condition — the plan watcher will not re-arm the same completed plan set until work reopens, and an idle attempt restarts the idle clock — so the shutdown command cannot repeat for the condition that already fired it.

## Alternatives considered

- **Execution inside `supervisor-ops`.** One package instead of two, and the gate could run its own command directly. It would also make every operations deployment — budget, reports, chat — able to power the machine off, and it would merge the component that answers with the component that acts.
- **A plugin-chosen platform power command.** It would work with no operator configuration, and it would hardcode a `shutdown` invocation that guesses the platform, the privileges, and the operator's intent; the whole safety model rests on the operator naming the command.
- **Asking the gate when arming.** An attempt would know immediately whether it can ever fire. It would also make an attempt armed inside the grace period impossible, treating a not-yet as a refusal.
- **Cancelling only when locally armed.** Simpler, and it would leave an OS timer a previous run started with no lever in this component to stop it; the operator's cancel command is the only way to stop a machine already counting down.
- **Porting the reference app's GUI countdown overlay, tray reminders, and single-instance mutex.** Those parts serve a desktop shell: a window a human watches, an icon they can click, a check against a second copy of the app. The runs this component exists for are unattended, and the chat reminders already put the deadline where a human is; the instant to schedule does not change with a window displaying it.

## Consequences

An unattended run can now end with the machine off instead of waiting for a human to come back. The cost is operator commands running with harness privileges: bounded by the double opt-in (the component's `enabled` and the gate's `enabled` and command), the fire-time gate, the dry run that reports without executing, and the per-command timeout at which the shell kills the command.
