/**
 * Automatic shutdown: the component that powers the machine off. The operations
 * component owns the gate — an operator enables shutdown, supplies the command,
 * and `supervisor_shutdown` reports whether a trigger permits it. This component
 * owns everything around that gate: when an attempt is made (a wall clock, a
 * countdown, every task plan finished, an idle timeout, or the supervising model
 * asserting completion), the chat reminders before it fires, execution through
 * `ctx.shell`, and the cancel path. It runs nothing an operator did not
 * configure.
 * @module @deepseek-ai/dsh-supervisor-shutdown
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-shell'
import { requireAgent } from '@deepseek-ai/dsh-supervisor-core'
import { shutdownDecision, type ShutdownDecision, type ShutdownTrigger } from '@deepseek-ai/dsh-supervisor-ops'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { MINUTE_MS, allPlansComplete, dueReminders, nextClockInstant, planProgress, planWatchAction } from './power.ts'

/** Cordis plugin name. */
export const name = 'supervisor-shutdown'

/** Services this component registers a tool on, executes through, and reads state from. */
export const inject = ['tools', 'shell', 'supervisor', 'supervisorOps']

/** Plugin configuration schema. */
export const Config: z<ShutdownConfig> = z.object({
  enabled: z.boolean().default(false),
  scheduleAt: z.string().default(''),
  scheduleAfterMinutes: z.number().step(1).min(0).default(0),
  scheduleAfterSeconds: z.number().step(1).min(0).default(0),
  watchPlans: z.boolean().default(false),
  idleTimeoutMin: z.number().step(1).min(0).default(0),
  remindAtMin: z.array(z.number().step(1).min(1)).default([10, 5, 1]),
  cancelCommand: z.string().default(''),
  notifyChatId: z.string().default(''),
  dryRun: z.boolean().default(false),
  pollIntervalSec: z.number().step(1).min(1).default(30),
  commandTimeoutSec: z.number().step(1).min(1).default(30),
})

/** Plugin configuration as authored in cordis.yml. */
export interface ShutdownConfig {
  /** Whether this component schedules and executes shutdowns at all. */
  enabled?: boolean
  /** Local `HH:MM` wall clock the timed shutdown is armed for; empty disables it. */
  scheduleAt?: string
  /** Minutes from plugin load the timed shutdown is armed for; 0 disables it. */
  scheduleAfterMinutes?: number
  /** Seconds from plugin load the timed shutdown is armed for; 0 disables it, and a configured value wins over the minutes one. */
  scheduleAfterSeconds?: number
  /** Fire once every stored task plan finished its subtasks. */
  watchPlans?: boolean
  /** Fire after this many minutes without a running agent; 0 disables it. */
  idleTimeoutMin?: number
  /** Chat reminders, in minutes before the attempt fires. */
  remindAtMin?: number[]
  /** Operator command that cancels a shutdown the OS already scheduled; empty skips cancellation. */
  cancelCommand?: string
  /** Conversation reminders and reports are sent to; empty keeps them in the log. */
  notifyChatId?: string
  /** Report what would run instead of running it. */
  dryRun?: boolean
  /** Seconds between watcher passes. */
  pollIntervalSec?: number
  /** Seconds one configured command may run before it is killed. */
  commandTimeoutSec?: number
}

/** Settings the scheduler reads after the schema filled every default. */
export interface ShutdownSettings {
  /** Whether the component acts. */
  readonly enabled: boolean
  /** Instant the timed shutdown is armed for at load, when one is configured. */
  readonly scheduledAt: number | undefined
  /** Whether completed plans arm an attempt. */
  readonly watchPlans: boolean
  /** Idle timeout in milliseconds; 0 disables it. */
  readonly idleTimeoutMs: number
  /** Reminder thresholds in minutes. */
  readonly remindAtMin: readonly number[]
  /** Operator cancellation command. */
  readonly cancelCommand: string
  /** Conversation reminders and reports are sent to. */
  readonly notifyChatId: string
  /** Whether commands are reported instead of run. */
  readonly dryRun: boolean
  /** Watcher pass interval in milliseconds. */
  readonly pollIntervalMs: number
  /** One command's execution bound in milliseconds. */
  readonly commandTimeoutMs: number
}

/** One armed shutdown attempt. */
interface PendingShutdown {
  /** Trigger the gate is asked about when the attempt fires. */
  readonly trigger: ShutdownTrigger
  /** Epoch milliseconds the attempt fires at. */
  readonly firesAt: number
  /** What armed it, for the reminder and report text. */
  readonly detail: string
  /** Epoch milliseconds the work it waits on finished, for the grace period. */
  readonly since?: number
  /** Reminder thresholds already announced for this attempt. */
  readonly announced: number[]
}

/** What one command execution reported. */
interface CommandReport {
  /** Exit code, or null when the process died from a signal or never started. */
  readonly exitCode: number | null
  /** Whether the executor's own timeout cut the command short. */
  readonly timedOut: boolean
}

/**
 * Register the shutdown scheduler, its watchers, and the `supervisor_power` tool.
 * @param ctx - plugin context with tools, a shell executor, and the supervisor services.
 * @param config - validated plugin configuration.
 * @throws TypeError when a clock, interval, or threshold is unusable.
 */
export function apply(ctx: Context, config: ShutdownConfig = {}): void {
  const settings = resolveSettings(config)
  // Resolved once: a watcher pass or command that outlives disposal still
  // settles against these instances instead of re-entering the context, which
  // is inactive by then.
  const logger = ctx.logger
  const shell = ctx.shell
  const supervisor = ctx.supervisor
  const supervisorOps = ctx.supervisorOps
  let pending: PendingShutdown | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let completedAt: number | undefined
  let lastRunningAt = Date.now()
  // One attempt per condition: once an attempt fires, the same completed plan set
  // must not arm again. The flag clears when work reopens, so a later completion
  // still counts.
  let plansSpent = false

  /** The operator's shutdown gate, owned by the operations component. */
  const policy = () => supervisorOps.config.shutdown

  /** Cancel the armed attempt's timer. */
  const clearTimer = (): void => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
  }

  /** Log one line and, when a conversation is configured, report it there. */
  const announce = (text: string): void => {
    logger.info(`supervisor-shutdown: ${text}`)
    if (settings.notifyChatId === '') return
    const chat = supervisorOps.chat
    // The bridge already reports a rejected send as false rather than throwing.
    if (chat === undefined) return
    void chat.notify(settings.notifyChatId, `[shutdown] ${text}`)
  }

  /** Run one operator-configured command through the shell seam. */
  const runCommand = async (command: string, label: string): Promise<CommandReport | undefined> => {
    if (settings.dryRun) {
      announce(`dry run: would ${label}: ${command}`)
      return undefined
    }
    try {
      const execution = await shell.execute(shell.resolve({
        command,
        timeoutMs: settings.commandTimeoutMs,
        onExpiry: 'kill',
      }))
      const result = await execution.result()
      announce(`${label} finished with exit code ${result.exitCode === null ? 'none' : String(result.exitCode)}`
        + `${result.timedOut ? ' (timed out)' : ''}: ${command}`)
      return { exitCode: result.exitCode, timedOut: result.timedOut }
    } catch (error: unknown) {
      announce(`could not ${label}: ${String(error)}`)
      return undefined
    }
  }

  /** Ask the gate about one attempt and, when it allows, run the command. */
  const attempt = async (armed: PendingShutdown): Promise<void> => {
    const decision = shutdownDecision(policy(), armed.trigger, Date.now(), armed.since)
    if (!decision.allowed) {
      announce(`attempt refused (${armed.detail}): ${decision.reason}`)
      return
    }
    announce(`shutting down (${armed.detail}): ${decision.reason}`)
    // The condition is spent once an attempt has been decided on: a fired
    // attempt must not repeat on the next watcher pass, and an idle stretch
    // restarts instead of firing again immediately.
    if (armed.trigger === 'all-tasks-completed') plansSpent = true
    if (armed.trigger === 'idle-timeout') lastRunningAt = Date.now()
    await runCommand(decision.command, 'shutdown')
  }

  /** Arm one attempt, replacing any previous one, and return it. */
  const arm = (trigger: ShutdownTrigger, firesAt: number, detail: string, since?: number): PendingShutdown => {
    // Thresholds the attempt starts inside are marked announced: a countdown
    // armed inside the ten-minute window must not immediately report "ten
    // minutes" for a deadline that is already closer.
    const remainingMs = Math.max(0, firesAt - Date.now())
    const alreadyInside = settings.remindAtMin.filter(threshold => remainingMs <= threshold * MINUTE_MS)
    const armed: PendingShutdown = { trigger, firesAt, detail, announced: [...alreadyInside], ...since === undefined ? {} : { since } }
    pending = armed
    clearTimer()
    timer = setTimeout(() => {
      timer = undefined
      pending = undefined
      void attempt(armed)
    }, Math.max(0, Math.min(firesAt - Date.now(), MAX_TIMER_DELAY_MS)))
    return armed
  }

  /**
   * Cancel one armed attempt. The operator's cancel command runs even when this
   * component armed nothing, because an earlier run may have left the OS with a
   * pending shutdown of its own.
   */
  const cancelPending = async (reason: string): Promise<CommandReport | undefined> => {
    const armed = pending
    pending = undefined
    clearTimer()
    if (armed !== undefined) announce(`cancelled the pending shutdown (${armed.detail}): ${reason}`)
    if (settings.cancelCommand === '') return undefined
    return await runCommand(settings.cancelCommand, 'cancellation')
  }

  /** Whether the gate would allow one trigger right now. */
  const preview = (trigger: ShutdownTrigger, since?: number): ShutdownDecision =>
    shutdownDecision(policy(), trigger, Date.now(), since)

  /** One watcher pass: plan completion, idle timeout, and the reminders owed. */
  const watch = async (): Promise<void> => {
    if (settings.watchPlans) {
      const progress = planProgress(await supervisor.plans.list())
      const complete = allPlansComplete(progress)
      if (complete) completedAt ??= Date.now()
      const action = planWatchAction({
        complete,
        armedByPlans: pending?.trigger === 'all-tasks-completed',
        since: completedAt,
        now: Date.now(),
      })
      if (!complete) {
        completedAt = undefined
        plansSpent = false
      }
      if (action.kind === 'cancel') await cancelPending('work is open again')
      if (action.kind === 'arm' && !plansSpent) {
        // The gate is asked when the attempt fires, once the grace period has
        // actually elapsed; asking here would refuse an attempt that is simply
        // still inside it.
        arm('all-tasks-completed', action.since + policy().gracePeriodMin * MINUTE_MS, 'every task plan finished', action.since)
      }
    }
    if (settings.idleTimeoutMs > 0 && pending === undefined && Date.now() - lastRunningAt >= settings.idleTimeoutMs) {
      arm('idle-timeout', Date.now(), `no agent ran for ${String(Math.round(settings.idleTimeoutMs / MINUTE_MS))} minutes`)
    }
    if (pending !== undefined) {
      for (const threshold of dueReminders(pending.firesAt - Date.now(), settings.remindAtMin, pending.announced)) {
        pending.announced.push(threshold)
        announce(`shutdown in ${String(threshold)} minute(s): ${pending.detail}`)
      }
    }
  }

  /** The model-visible projection of one armed attempt. */
  const armedResult = (armed: PendingShutdown, decision: ShutdownDecision) => ({
    pending: true,
    trigger: armed.trigger,
    firesAt: new Date(armed.firesAt).toISOString(),
    remainingSec: Math.max(0, Math.round((armed.firesAt - Date.now()) / 1000)),
    detail: armed.detail,
    allowed: decision.allowed,
    reason: decision.reason,
    ...decision.allowed ? { command: decision.command } : {},
  })

  ctx.effect(() => () => {
    clearTimer()
  }, 'supervisor-shutdown timer')

  ctx.effect(function* () {
    ctx.on('agent/status', ({ status }) => {
      if (status === 'running') lastRunningAt = Date.now()
    })
  }, 'supervisor-shutdown activity watcher')

  if (settings.enabled) {
    if (settings.scheduledAt !== undefined) {
      arm('scheduled-time', settings.scheduledAt, `the configured wall clock ${config.scheduleAt ?? ''}`.trim())
    }
    const poll = setInterval(() => {
      void watch()
    }, settings.pollIntervalMs)
    ctx.effect(() => () => {
      clearInterval(poll)
    }, 'supervisor-shutdown watcher')
    void watch()
  }

  ctx.tools.register(defineTool({
    name: 'supervisor_power',
    description:
      'Report or change the pending automatic shutdown: confirm the work is done so it fires after the operator grace period, schedule it for a countdown, cancel it, or read what is armed. '
      + 'The operator owns whether shutdown is enabled at all and which command runs; this tool never changes those.',
    parameters: {
      action: { type: 'string', required: true, enum: ['status', 'confirm', 'schedule', 'cancel'], description: 'Read the pending attempt, arm one for completed work, arm one for a countdown, or cancel.' },
      minutes: { type: 'integer', description: 'Minutes from now for `schedule`; ignored by the other actions.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          pending: { type: 'boolean', required: true, description: 'True when a shutdown attempt is armed.' },
          trigger: { type: 'string', enum: ['all-tasks-completed', 'scheduled-time', 'idle-timeout'], description: 'Trigger the armed attempt asks the gate about.' },
          firesAt: { type: 'string', description: 'ISO timestamp the armed attempt fires at.' },
          remainingSec: { type: 'integer', description: 'Seconds left before the armed attempt fires.' },
          detail: { type: 'string', description: 'What armed the attempt.' },
          allowed: { type: 'boolean', required: true, description: 'Whether the operator gate allows a shutdown now.' },
          reason: { type: 'string', required: true, description: 'Why the gate decided that way.' },
          cancelled: { type: 'boolean', description: 'True when `cancel` cleared an attempt or ran the cancel command.' },
          command: { type: 'string', description: 'Operator command the gate would run, present only when allowed.' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.pending
          ? `shutdown armed (${value.detail ?? ''}); fires at ${value.firesAt ?? ''}`
          : `no shutdown pending: ${value.reason}`,
      }],
    },
    async execute(args, exec) {
      requireAgent(exec)
      if (args.action === 'cancel') {
        const armed = pending !== undefined
        const report = await cancelPending('cancelled on request')
        return {
          pending: false,
          allowed: false,
          reason: armed || report !== undefined
            ? 'The pending shutdown was cancelled.'
            : 'Nothing was pending to cancel.',
          cancelled: armed || report !== undefined,
        }
      }
      if (args.action === 'confirm') {
        const decision = preview('all-tasks-completed')
        if (!decision.allowed) return { pending: false, allowed: false, reason: decision.reason }
        const since = Date.now()
        const armed = arm('all-tasks-completed', since + policy().gracePeriodMin * MINUTE_MS, 'the supervising model confirmed the work is done', since)
        return armedResult(armed, decision)
      }
      if (args.action === 'schedule') {
        const minutes = args.minutes
        if (minutes === undefined || !Number.isFinite(minutes) || minutes <= 0) {
          throw new Error('supervisor_power schedule needs `minutes`, a positive whole number')
        }
        const decision = preview('scheduled-time')
        if (!decision.allowed) return { pending: false, allowed: false, reason: decision.reason }
        const armed = arm('scheduled-time', Date.now() + minutes * MINUTE_MS, `scheduled for ${String(minutes)} minute(s) from now`)
        return armedResult(armed, decision)
      }
      const decision = preview(pending?.trigger ?? 'scheduled-time', pending?.since)
      if (pending === undefined) {
        return {
          pending: false,
          allowed: decision.allowed,
          reason: decision.reason,
          ...decision.allowed ? { command: decision.command } : {},
        }
      }
      return armedResult(pending, decision)
    },
    presentCall: args => ({ card: 'generic', title: `Power: ${args.action}`, kind: 'other' }),
  }))
}

/**
 * Resolve the scheduler's settings. The schema fills every single-field default,
 * so only the cross-field rule is enforced here: a stated clock must be a clock.
 * @param config - validated plugin configuration.
 * @returns the settings the scheduler reads.
 * @throws TypeError when `scheduleAt` is not a `HH:MM` wall clock.
 */
export function resolveSettings(config: ShutdownConfig): ShutdownSettings {
  const clock = config.scheduleAt ?? ''
  const afterMinutes = config.scheduleAfterMinutes ?? 0
  const afterSeconds = config.scheduleAfterSeconds ?? 0
  const countdownMs = afterSeconds > 0 ? afterSeconds * 1000 : afterMinutes * MINUTE_MS
  const scheduledAt = clock.trim() === ''
    ? (countdownMs > 0 ? Date.now() + countdownMs : undefined)
    : nextClockInstant(clock, Date.now())
  if (clock.trim() !== '' && scheduledAt === undefined) {
    throw new TypeError(`supervisor shutdown "scheduleAt" must be a HH:MM wall clock, got ${JSON.stringify(clock)}`)
  }
  return {
    enabled: config.enabled ?? false,
    scheduledAt,
    watchPlans: config.watchPlans ?? false,
    idleTimeoutMs: (config.idleTimeoutMin ?? 0) * MINUTE_MS,
    remindAtMin: config.remindAtMin ?? [10, 5, 1],
    cancelCommand: config.cancelCommand ?? '',
    notifyChatId: config.notifyChatId ?? '',
    dryRun: config.dryRun ?? false,
    pollIntervalMs: (config.pollIntervalSec ?? 30) * 1000,
    commandTimeoutMs: (config.commandTimeoutSec ?? 30) * 1000,
  }
}
