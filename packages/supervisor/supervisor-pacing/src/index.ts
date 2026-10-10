/**
 * Automatic pacing for the supervising agent itself. The harness watches the
 * CLI agents it hosts, but its own model requests can fail the same way: a rate
 * limit, an upstream refusal, a dropped connection. `dsh-llm-retry` already
 * retries inside the failing step with the provider's own policy; what nothing
 * owned is the cross-turn case — a `Retry-After` longer than that policy allows,
 * after which the turn ends `error` and nothing wakes the agent again. This
 * component waits out the stated reset (or a bounded backoff), re-arms a goal the
 * failure disarmed, and wakes the agent for one more turn, within a per-session
 * budget and with a chat alert when it gives up.
 *
 * It deliberately does not hook `agent/request-error`: retrying inside a step
 * belongs to `dsh-llm-retry`, and a second claimant would race it.
 * @module @deepseek-ai/dsh-supervisor-pacing
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-goal'
import type {} from '@deepseek-ai/dsh-supervisor-ops'
import { RESUME_BUFFER_MS } from '@deepseek-ai/dsh-supervisor-core'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import z from '@deepseek-ai/schemastery'
import { asFailure, planResume, type PacingFailure, type PacingPolicy, type PacingSkip } from './pacing.ts'
import { PACING_PROJECTION } from './projection.ts'

/** Cordis plugin name. */
export const name = 'supervisor-pacing'

/** Services pacing observes, wakes agents through, and stores its fold state in. */
export const inject = ['agents', 'sessions', 'sessionProjections']

/** Plugin configuration schema. */
export const Config: z<PacingConfig> = z.object({
  enabled: z.boolean().default(true),
  scope: z.union([z.const('roots'), z.const('all')]).default('roots'),
  codes: z.array(z.string()).default(['RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'EMPTY_RESPONSE', 'INTERRUPTED']),
  initialDelayMs: z.number().step(1).min(1).default(1_000),
  maxDelayMs: z.number().step(1).min(1).default(10_000),
  jitterRatio: z.number().min(0).max(1).default(0.1),
  bufferMs: z.number().step(1).min(0).default(RESUME_BUFFER_MS),
  maxResumeDelayMs: z.number().step(1).min(1).default(6 * 60 * 60 * 1000),
  minIntervalMs: z.number().step(1).min(0).default(60_000),
  maxResumesPerSession: z.number().step(1).min(1).default(3),
  resumeGoals: z.boolean().default(true),
  resumeOnRestart: z.boolean().default(false),
  notifyOnGiveUp: z.boolean().default(true),
  notifyChatId: z.string().default(''),
})

/** Plugin configuration as authored in cordis.yml. */
export interface PacingConfig {
  /** Whether automatic pacing runs at all. */
  enabled?: boolean
  /** Agents paced: the roots a human drives, or every agent including subagents. */
  scope?: 'roots' | 'all'
  /** Failure codes pacing resumes; any other code is reported and left alone. */
  codes?: string[]
  /** First backoff delay for a failure that states no resume instant. */
  initialDelayMs?: number
  /** Ceiling for a computed backoff delay. */
  maxDelayMs?: number
  /** Fraction of a backoff delay applied as symmetric jitter. */
  jitterRatio?: number
  /** Wait added past a stated reset before resuming. */
  bufferMs?: number
  /** Longest resume delay honored; a later stated instant is clamped to it. */
  maxResumeDelayMs?: number
  /** Minimum spacing between two automatic resumes for one session. */
  minIntervalMs?: number
  /** Consecutive automatic resumes allowed before pacing gives up. */
  maxResumesPerSession?: number
  /** Re-arm an active goal the failure disarmed, so its rounds continue. */
  resumeGoals?: boolean
  /** Resume a session whose last turn failed before this process started. */
  resumeOnRestart?: boolean
  /** Report a give-up to the chat transport, when one is registered. */
  notifyOnGiveUp?: boolean
  /** Conversation a give-up alert is sent to; empty disables the alert. */
  notifyChatId?: string
}

/** Settings the plugin reads outside the numeric policy. */
interface PacingSettings {
  /** Whether pacing runs. */
  readonly enabled: boolean
  /** Which agents are paced. */
  readonly scope: 'roots' | 'all'
  /** Whether a disarmed active goal is re-armed before the resume. */
  readonly resumeGoals: boolean
  /** Whether a session failed before this process started is resumed. */
  readonly resumeOnRestart: boolean
  /** Whether a give-up reaches the chat transport. */
  readonly notifyOnGiveUp: boolean
  /** Conversation a give-up alert is sent to. */
  readonly notifyChatId: string
}

/** One agent's pacing bookkeeping, discarded with the plugin or the agent. */
interface PacingEntry {
  /** Agent this entry paces. */
  readonly agent: Agent
  /** Pending wake timer, absent while nothing is scheduled. */
  timer: ReturnType<typeof setTimeout> | undefined
  /** Instant the pending timer fires at, for logging. */
  resumeAt: number | undefined
  /** Consecutive automatic resumes spent since the last successful turn. */
  resumes: number
  /** Epoch milliseconds of the last delivered resume, for the minimum spacing. */
  lastResumeAt: number | undefined
  /** Resumes delivered but not yet observed as an opening turn. */
  expectedTurns: number
  /** Epoch milliseconds of the last give-up report, for the alert cooldown. */
  reportedAt: number | undefined
}

/**
 * Register the pacing listeners, projection, and pending timers.
 * @param ctx - plugin context with the agent registry and projection registry.
 * @param config - validated plugin configuration.
 * @throws TypeError when a delay, budget, or jitter value is unusable.
 */
export function apply(ctx: Context, config: PacingConfig = {}): void {
  const policy = resolvePolicy(config)
  const settings = resolveSettings(config)
  const entries = new Map<string, PacingEntry>()

  /** Fetch or create one agent's pacing bookkeeping. */
  const entryFor = (agent: Agent): PacingEntry => {
    const existing = entries.get(agent.id)
    if (existing !== undefined) return existing
    const created: PacingEntry = {
      agent,
      timer: undefined,
      resumeAt: undefined,
      resumes: 0,
      lastResumeAt: undefined,
      expectedTurns: 0,
      reportedAt: undefined,
    }
    entries.set(agent.id, created)
    return created
  }

  /** Cancel one agent's pending wake, keeping its resume history. */
  const cancel = (entry: PacingEntry): void => {
    if (entry.timer !== undefined) clearTimeout(entry.timer)
    entry.timer = undefined
    entry.resumeAt = undefined
  }

  /**
   * Deliver one resume: claim the agent's idle phase, re-arm its goal, and queue
   * the wake message. A busy agent is retried after it next goes idle, and a
   * driver that refuses the message is reported without failing the plugin.
   */
  const deliver = async (entry: PacingEntry): Promise<void> => {
    const agent = entry.agent
    let maintenance: Promise<boolean>
    try {
      maintenance = agent.runMaintenance(() => {
        rearmGoal(ctx, settings, agent)
        try {
          entry.expectedTurns += 1
          entry.lastResumeAt = Date.now()
          agent.followup(createUserMessage({
            content: [{ type: 'text', text: resumeNotice(entry, policy) }],
            source: { kind: 'user' },
          }))
        } catch (error: unknown) {
          entry.expectedTurns -= 1
          ctx.logger.warn(`supervisor-pacing: could not wake agent "${agent.id}": ${String(error)}`)
          return Promise.resolve(false)
        }
        return Promise.resolve(true)
      })
    } catch (error: unknown) {
      // The idle phase belongs to a live turn or another maintenance task; the
      // next idle transition retries, so a busy agent is never polled.
      ctx.logger.debug(`supervisor-pacing: agent "${agent.id}" is busy; waiting for idle: ${String(error)}`)
      void agent.whenIdle().then(() => {
        if (entries.get(agent.id) === entry) void deliver(entry)
      })
      return
    }
    // The task resolves its own refusal; a rejection here would mean the phase
    // itself tore down, which the disposal path already handles.
    await maintenance
  }

  /** Arm one agent's wake at a resume instant, bounded by the timer ceiling. */
  const arm = (entry: PacingEntry, resumeAt: number): void => {
    cancel(entry)
    entry.resumeAt = resumeAt
    const delay = Math.max(0, Math.min(resumeAt - Date.now(), MAX_TIMER_DELAY_MS))
    entry.timer = setTimeout(() => {
      entry.timer = undefined
      void deliver(entry)
    }, delay)
  }

  /** Report that pacing will not resume one failure, once per cooldown. */
  const reportGiveUp = (entry: PacingEntry, reason: PacingSkip, failure: PacingFailure): void => {
    const detail = reason === 'budget'
      ? `spent ${String(entry.resumes)} automatic resume(s)`
      : `failure code "${failure.code}" is not one this deployment resumes`
    ctx.logger.warn(`supervisor-pacing: not resuming agent "${entry.agent.id}": ${detail}`)
    if (!settings.notifyOnGiveUp || settings.notifyChatId === '') return
    const now = Date.now()
    if (entry.reportedAt !== undefined && now - entry.reportedAt < policy.minIntervalMs) return
    entry.reportedAt = now
    const chat = ctx.get('supervisorOps')?.chat
    if (chat === undefined) return
    void chat.notify(settings.notifyChatId, `[pacing] ${detail}; agent ${entry.agent.id} needs attention`)
      .catch((error: unknown) => {
        ctx.logger.warn(`supervisor-pacing: give-up alert failed: ${String(error)}`)
      })
  }

  /** Decide and schedule one failure's resume. */
  const paceFailure = (agent: Agent, failure: PacingFailure): void => {
    const entry = entryFor(agent)
    const plan = planResume({
      failure,
      policy,
      now: Date.now(),
      resumes: entry.resumes,
      ...entry.lastResumeAt === undefined ? {} : { lastResumeAt: entry.lastResumeAt },
    })
    if (plan.kind === 'skip') {
      reportGiveUp(entry, plan.reason, failure)
      return
    }
    entry.resumes += 1
    arm(entry, plan.resumeAt)
    ctx.logger.info(
      `supervisor-pacing: agent "${agent.id}" failed with ${failure.code}; `
      + `resume ${String(entry.resumes)}/${String(policy.maxResumesPerSession)} scheduled in `
      + `${String(Math.round((plan.resumeAt - Date.now()) / 1000))}s (${plan.source})`,
    )
  }

  /** Whether one agent is in this deployment's pacing scope. */
  const inScope = (agent: Agent): boolean => settings.scope === 'all' || ctx.agents.roots().includes(agent)

  /** Resume a session whose last turn failed before this process started. */
  const checkRestart = (agent: Agent): void => {
    if (!settings.enabled || !settings.resumeOnRestart || !inScope(agent)) return
    const failure = ctx.sessionProjections.stateOf(agent.session, 'pacing')?.failure
    if (failure === null || failure === undefined) return
    paceFailure(agent, failure)
  }

  /** Fold one committed event into this plugin's own view of a session. */
  const observeSession = (session: Session, event: SessionEvent): void => {
    const agent = ctx.agents.get(session.id)
    if (agent === undefined) return
    const entry = entries.get(agent.id)
    if (entry === undefined) return
    if (event.type === 'turn/start') {
      if (entry.expectedTurns > 0) {
        entry.expectedTurns -= 1
        return
      }
      // Something else woke the agent: the human is back or another plugin drove
      // the turn, so the pending resume is redundant and the budget restarts.
      cancel(entry)
      entry.resumes = 0
      return
    }
    if (event.type === 'turn/end' && event.data.reason.kind === 'completed') entry.resumes = 0
  }

  ctx.effect(() => {
    const dispose = ctx.sessionProjections.register(PACING_PROJECTION)
    return () => {
      for (const entry of entries.values()) cancel(entry)
      entries.clear()
      dispose()
    }
  }, 'supervisor-pacing projection')

  ctx.effect(function* () {
    ctx.on('agent/error', ({ agent, error }) => {
      if (!settings.enabled || !inScope(agent)) return
      const failure = asFailure(error)
      if (failure === undefined) return
      paceFailure(agent, failure)
    })
    ctx.on('agent/disposed', ({ agent }) => {
      const entry = entries.get(agent.id)
      if (entry === undefined) return
      cancel(entry)
      entries.delete(agent.id)
    })
    ctx.on('agent/created', ({ agent }) => {
      checkRestart(agent)
    })
    ctx.on('session/event', (session, event) => {
      observeSession(session, event)
    })
  }, 'supervisor-pacing listeners')

  if (settings.enabled && settings.resumeOnRestart) {
    for (const agent of ctx.agents.roots()) checkRestart(agent)
  }
}

/**
 * Re-arm an active goal the failure disarmed, so its rounds continue after the
 * cooldown. The round driver disarms on any error, including a rate limit, which
 * would otherwise park an armed goal until a human resumed it.
 */
function rearmGoal(ctx: Context, settings: PacingSettings, agent: Agent): void {
  if (!settings.resumeGoals) return
  const goals = ctx.get('goals')
  if (goals === undefined) return
  const goal = goals.get(agent)
  if (goal === undefined || goal.phase !== 'active' || goal.activation !== 'disarmed') return
  try {
    goals.resume(agent, { id: goal.id, revision: goal.revision })
  } catch (error: unknown) {
    ctx.logger.warn(`supervisor-pacing: could not re-arm the goal for agent "${agent.id}": ${String(error)}`)
  }
}

/** The model-visible notice one resume delivers. */
function resumeNotice(entry: PacingEntry, policy: PacingPolicy): string {
  return `[pacing] the previous turn failed. This is automatic resume ${String(entry.resumes)} `
    + `of ${String(policy.maxResumesPerSession)}: continue the work from where it stopped, and if it `
    + 'cannot continue, report what remains instead of retrying.'
}

/**
 * Resolve the numeric policy, rejecting a combination that could never work.
 * The schema fills every single-field default, so only cross-field combinations
 * are checked here: an unusable ladder or an empty code list still fails loud.
 * @param config - validated plugin configuration.
 * @returns the effective policy.
 * @throws TypeError when the backoff ladder cannot grow or no code is resumable.
 */
export function resolvePolicy(config: PacingConfig): PacingPolicy {
  const policy: PacingPolicy = {
    codes: config.codes ?? ['RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'EMPTY_RESPONSE', 'INTERRUPTED'],
    initialDelayMs: config.initialDelayMs ?? 1_000,
    maxDelayMs: config.maxDelayMs ?? 10_000,
    jitterRatio: config.jitterRatio ?? 0.1,
    bufferMs: config.bufferMs ?? RESUME_BUFFER_MS,
    maxResumeDelayMs: config.maxResumeDelayMs ?? 6 * 60 * 60 * 1000,
    minIntervalMs: config.minIntervalMs ?? 60_000,
    maxResumesPerSession: config.maxResumesPerSession ?? 3,
  }
  if (policy.maxDelayMs < policy.initialDelayMs) {
    throw new TypeError('supervisor pacing "maxDelayMs" must be at least "initialDelayMs" so the backoff can grow')
  }
  if (policy.codes.length === 0) {
    throw new TypeError('supervisor pacing "codes" must name at least one failure code to resume')
  }
  return policy
}

/**
 * Resolve the settings the numeric policy does not cover.
 * @param config - validated plugin configuration.
 * @returns the effective settings.
 */
export function resolveSettings(config: PacingConfig): PacingSettings {
  return {
    enabled: config.enabled ?? true,
    scope: config.scope ?? 'roots',
    resumeGoals: config.resumeGoals ?? true,
    resumeOnRestart: config.resumeOnRestart ?? false,
    notifyOnGiveUp: config.notifyOnGiveUp ?? true,
    notifyChatId: config.notifyChatId ?? '',
  }
}
