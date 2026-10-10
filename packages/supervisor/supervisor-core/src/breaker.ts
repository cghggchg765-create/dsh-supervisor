/**
 * Progress circuit breaker. A hosted agent can keep the terminal busy without
 * getting anywhere: the same output over and over, the same command retried, a
 * wait that settles identically every time. The breaker is the deterministic
 * counter for that: it watches a per-session sequence of settlements, calls a
 * settlement "progress" only when the observed output actually changed, and
 * moves CLOSED → HALF-OPEN → OPEN as the identical ones pile up.
 *
 * The breaker never stops anything by itself. Its state is evidence attached to
 * the tool results and to `supervisor_status`, so the supervising model can
 * escalate with a fresh terminal, a different model, or a human instead of
 * retrying forever. The cooldown back to HALF-OPEN is what keeps a fixed
 * deployment from parking on a tripped breaker: the next settlement re-probes.
 * @module @deepseek-ai/dsh-supervisor-core/breaker
 */

/** The three breaker positions, matching the reference implementation. */
export type BreakerState =
  /** Output is still changing; no stall observed. */
  | 'closed'
  /** The stall limit was reached; the next non-progress settlement trips it. */
  | 'half-open'
  /** The stall persisted; the supervised session needs an intervention. */
  | 'open'

/** Tunable breaker limits. */
export interface BreakerPolicy {
  /** Consecutive identical settlements that move `closed` to `half-open`. */
  noProgressLimit: number
  /** Consecutive identical settlements that move `half-open` to `open`. */
  openLimit: number
  /** Seconds an open breaker waits before allowing one re-probe. */
  cooldownSec: number
}

/** Default breaker policy, matching the documented escalation ladder. */
export const DEFAULT_BREAKER_POLICY: BreakerPolicy = {
  noProgressLimit: 2,
  openLimit: 3,
  cooldownSec: 300,
}

/** Breaker state as a tool result or status row reports it. */
export type BreakerReport =
  | {
    /** Output is still changing, or the stall limit was reached and one more stall trips it. */
    state: 'closed' | 'half-open'
    /** Identical settlements observed since the last change. */
    consecutiveNoProgress: number
  }
  | {
    /** The stall persisted; the supervised session needs an intervention. */
    state: 'open'
    /** Identical settlements observed since the last change. */
    consecutiveNoProgress: number
    /** Seconds since the breaker opened, which bound the remaining cooldown. */
    openForSec: number
  }

/** The breaker position: open carries the moment it opened. */
type Position =
  | { kind: 'closed' | 'half-open' }
  | { kind: 'open'; at: number }

/**
 * Per-session progress breaker. One instance exists per supervised terminal and
 * is discarded with it, so its counters never outlive the session they describe.
 */
export class ProgressBreaker {
  private position: Position = { kind: 'closed' }

  private noProgress = 0

  /**
   * @param policy - resolved breaker limits.
   */
  constructor(private readonly policy: BreakerPolicy) {}

  /**
   * Record one settlement's progress and return the resulting state.
   * @param progress - whether the settlement's output differed from the previous one.
   * @param now - epoch milliseconds of the settlement.
   * @returns the breaker position after this observation.
   */
  observe(progress: boolean, now: number): BreakerState {
    if (progress) {
      this.noProgress = 0
      this.position = { kind: 'closed' }
      return 'closed'
    }
    this.noProgress += 1
    if (this.position.kind === 'open') {
      // Already tripped: only the cooldown can move it, and `report` decides that.
      return this.report(now).state
    }
    if (this.noProgress >= this.policy.noProgressLimit) {
      this.position = this.noProgress >= this.policy.openLimit
        ? { kind: 'open', at: now }
        : { kind: 'half-open' }
    }
    return this.position.kind
  }

  /**
   * Read the breaker state, applying the cooldown that re-opens the probe window.
   * @param now - epoch milliseconds to evaluate the cooldown against.
   * @returns the current position and its counters.
   */
  report(now: number): BreakerReport {
    if (this.position.kind !== 'open') {
      return { state: this.position.kind, consecutiveNoProgress: this.noProgress }
    }
    const openMs = now - this.position.at
    if (openMs >= this.policy.cooldownSec * 1000) {
      this.position = { kind: 'half-open' }
      return { state: 'half-open', consecutiveNoProgress: this.noProgress }
    }
    return { state: 'open', consecutiveNoProgress: this.noProgress, openForSec: Math.round(openMs / 1000) }
  }
}
