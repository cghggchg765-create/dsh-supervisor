/**
 * Auto-shutdown decision. The plugin never invents an OS command: the operator
 * configures one, and this module decides whether that command may run for one
 * trigger, so an unconfigured deployment can never power a machine off. The
 * decision carries the reason that produced it, for the audit trail.
 * @module @deepseek-ai/dsh-supervisor-ops/shutdown
 */

/** When the supervisor may shut the machine down. */
export interface ShutdownPolicy {
  /** Whether shutdown is permitted at all. */
  enabled: boolean
  /** Operator-supplied command to run; empty means shutdown is not configured. */
  command: string
  /** Minutes to wait after the last task finishes before shutting down. */
  gracePeriodMin: number
}

/** Reason a shutdown was considered. */
export type ShutdownTrigger = 'all-tasks-completed' | 'scheduled-time' | 'idle-timeout'

/** Default policy: disabled, with no command. */
export const DEFAULT_SHUTDOWN_POLICY: ShutdownPolicy = {
  enabled: false,
  command: '',
  gracePeriodMin: 5,
}

/** The decision to run, or the reason it was refused. */
export type ShutdownDecision =
  | {
    /** Whether the caller may run `command`. */
    readonly allowed: true
    /** Operator command the caller may run. */
    readonly command: string
    /** Why the decision came out this way, for the audit trail. */
    readonly reason: string
  }
  | {
    /** Whether the caller may run `command`. */
    readonly allowed: false
    /** Why the decision came out this way, for the audit trail. */
    readonly reason: string
  }

/** Milliseconds in the configured grace period's minute. */
const MINUTE_MS = 60_000

/**
 * Decide whether a shutdown may run. The plugin never invents an OS command:
 * an operator must configure one, so an unconfigured policy always refuses.
 * `all-tasks-completed` with no recorded finish time is allowed, because the
 * caller that reports that trigger is the one asserting every task finished.
 * @param policy - resolved shutdown policy.
 * @param trigger - what made the supervisor consider a shutdown.
 * @param now - epoch milliseconds of the decision.
 * @param lastTaskFinishedAt - epoch milliseconds the last task finished, when recorded.
 * @returns the decision and the sentence explaining it.
 * @throws TypeError when `gracePeriodMin` is not a positive number.
 */
export function shutdownDecision(
  policy: ShutdownPolicy,
  trigger: ShutdownTrigger,
  now: number,
  lastTaskFinishedAt?: number,
): ShutdownDecision {
  if (!Number.isFinite(policy.gracePeriodMin) || policy.gracePeriodMin <= 0) {
    throw new TypeError('supervisor shutdown field "gracePeriodMin" must be a positive number')
  }
  if (!policy.enabled) {
    return { allowed: false, reason: `Shutdown refused for ${trigger}: auto-shutdown is disabled.` }
  }
  const command = policy.command.trim()
  if (command === '') {
    return { allowed: false, reason: `Shutdown refused for ${trigger}: no shutdown command is configured.` }
  }
  if (trigger === 'all-tasks-completed') {
    const graceMs = policy.gracePeriodMin * MINUTE_MS
    if (lastTaskFinishedAt !== undefined && now - lastTaskFinishedAt < graceMs) {
      return {
        allowed: false,
        reason: `Shutdown refused for ${trigger}: the ${policy.gracePeriodMin}-minute grace period has not elapsed since the last task finished.`,
      }
    }
    const detail = lastTaskFinishedAt === undefined
      ? 'the caller asserted every task finished and recorded no finish time'
      : `the ${policy.gracePeriodMin}-minute grace period elapsed since the last task finished`
    return { allowed: true, command, reason: `Shutdown allowed for ${trigger}: ${detail}.` }
  }
  return { allowed: true, command, reason: `Shutdown allowed for ${trigger}: the configured command is enabled.` }
}
