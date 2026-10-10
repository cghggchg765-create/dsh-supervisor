/**
 * The pacing decision core: which failures deserve a cross-turn resume, how
 * long to wait for it, and when pacing gives up. Every function here is pure
 * over facts the agent loop already recorded, so the plugin's timers and
 * listeners stay thin and the whole policy is unit-testable without a loop.
 * @module @deepseek-ai/dsh-supervisor-pacing/pacing
 */

import { parseLimitReset, parseProviderReset } from '@deepseek-ai/dsh-supervisor-core'

/** The failure facts one pacing decision reads, narrowed from an agent error payload. */
export interface PacingFailure {
  /** Stable provider-neutral failure code, as the model adapter classified it. */
  readonly code: string
  /** Human-readable failure text, scanned for a stated resume instant. */
  readonly message: string
  /** Provider-requested delay in milliseconds, when the adapter parsed one. */
  readonly providerRetryAfterMs?: number | undefined
}

/** Effective pacing policy, resolved from the plugin configuration. */
export interface PacingPolicy {
  /** Failure codes this deployment resumes. */
  readonly codes: readonly string[]
  /** First backoff delay for a failure that states no instant. */
  readonly initialDelayMs: number
  /** Ceiling for a computed backoff delay. */
  readonly maxDelayMs: number
  /** Fraction of a backoff delay applied as symmetric jitter. */
  readonly jitterRatio: number
  /** Wait added past a stated reset before resuming, so the provider serves again. */
  readonly bufferMs: number
  /** Longest resume delay honored; a later stated instant is clamped to it. */
  readonly maxResumeDelayMs: number
  /** Minimum spacing between two automatic resumes for one session. */
  readonly minIntervalMs: number
  /** Consecutive automatic resumes allowed before pacing gives up. */
  readonly maxResumesPerSession: number
}

/** Why a failure was not scheduled. */
export type PacingSkip = 'code' | 'budget'

/** Which form stated the resume instant. */
export type PacingSource = 'retry-after' | 'reset' | 'backoff'

/** What to do about one failure. */
export type PacingPlan =
  | { readonly kind: 'resume'; readonly resumeAt: number; readonly source: PacingSource }
  | { readonly kind: 'skip'; readonly reason: PacingSkip }

/** The facts one planning call reads. */
export interface PacingPlanInput {
  /** Failure the loop reported. */
  readonly failure: PacingFailure
  /** Effective policy. */
  readonly policy: PacingPolicy
  /** Epoch milliseconds the plan is made at. */
  readonly now: number
  /** Automatic resumes already spent on this session. */
  readonly resumes: number
  /** Epoch milliseconds of the last automatic resume, for the minimum spacing. */
  readonly lastResumeAt?: number
  /** Jitter source; defaults to `Math.random`. */
  readonly random?: () => number
}

/**
 * Narrow an agent error payload to the failure facts pacing reads. The loop
 * types this payload as `unknown`, so every field is checked here.
 * @param error - value the loop reported for a failed turn.
 * @returns the failure facts, or undefined when the value is not a structured failure.
 */
export function asFailure(error: unknown): PacingFailure | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const candidate: { code?: unknown; message?: unknown; providerRetryAfterMs?: unknown } = error
  if (typeof candidate.code !== 'string' || candidate.code.length === 0) return undefined
  if (typeof candidate.message !== 'string') return undefined
  const retryAfter = candidate.providerRetryAfterMs
  const stated = typeof retryAfter === 'number' && Number.isFinite(retryAfter) && retryAfter > 0
    ? { providerRetryAfterMs: retryAfter }
    : {}
  return { code: candidate.code, message: candidate.message, ...stated }
}

/**
 * Plan the resume instant for one failure: the provider's stated instant when
 * there is one, a bounded jittered backoff otherwise, and never earlier than the
 * minimum spacing after the previous automatic resume.
 * @param input - failure, policy, and the session's resume history.
 * @returns the instant to wake the agent, or why pacing declined.
 */
export function planResume(input: PacingPlanInput): PacingPlan {
  const { failure, policy, now, resumes } = input
  if (!policy.codes.includes(failure.code)) return { kind: 'skip', reason: 'code' }
  if (resumes >= policy.maxResumesPerSession) return { kind: 'skip', reason: 'budget' }
  const stated = statedDelay(failure, now)
  const delay = stated === undefined
    ? backoffDelay(resumes, policy, input.random ?? Math.random)
    : clamp(stated.delayMs + policy.bufferMs, 0, policy.maxResumeDelayMs)
  const spaced = input.lastResumeAt === undefined
    ? delay
    : Math.max(delay, policy.minIntervalMs - (now - input.lastResumeAt))
  return { kind: 'resume', resumeAt: now + spaced, source: stated?.source ?? 'backoff' }
}

/**
 * Backoff for one attempt, jittered symmetrically and capped.
 * @param resumes - automatic resumes already spent, which sets the exponent.
 * @param policy - effective policy supplying the bounds.
 * @param random - jitter source returning [0, 1).
 * @returns the delay in whole milliseconds.
 */
export function backoffDelay(resumes: number, policy: PacingPolicy, random: () => number): number {
  const base = Math.min(policy.initialDelayMs * 2 ** resumes, policy.maxDelayMs)
  const jittered = base * (1 + policy.jitterRatio * (random() * 2 - 1))
  return Math.max(0, Math.round(clamp(jittered, 0, policy.maxDelayMs)))
}

/**
 * The delay a failure itself states, when it states one.
 * @param failure - failure facts to read.
 * @param now - epoch milliseconds the message is read at.
 * @returns the delay and which form stated it, or undefined when the message states none.
 */
function statedDelay(failure: PacingFailure, now: number): { delayMs: number; source: PacingSource } | undefined {
  if (failure.providerRetryAfterMs !== undefined) {
    return { delayMs: failure.providerRetryAfterMs, source: 'retry-after' }
  }
  // A provider that names a wall clock is read by the CLI parser; the provider
  // parser owns the forms only a provider states.
  const reset = parseProviderReset(failure.message, now) ?? parseLimitReset(failure.message, now)
  if (reset === undefined) return undefined
  return { delayMs: Math.max(0, reset.resumeAt - now), source: 'reset' }
}

/** Hold one number inside an inclusive range. */
function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high)
}
