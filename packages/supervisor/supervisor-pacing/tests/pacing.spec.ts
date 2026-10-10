/**
 * The pacing decision core: failure narrowing, resume-instant priority, backoff
 * bounds, and the two reasons pacing declines. Pure functions, no loop.
 */

import { describe, expect, it } from 'vitest'
import { asFailure, backoffDelay, planResume, type PacingPolicy } from '../src/pacing.ts'

/** Epoch milliseconds every case plans from. */
const NOW = Date.UTC(2026, 0, 15, 10)

/** Policy under test; jitter is exercised through an injected random source. */
const policy: PacingPolicy = {
  codes: ['RATE_LIMIT', 'TIMEOUT'],
  initialDelayMs: 1000,
  maxDelayMs: 8000,
  jitterRatio: 0.5,
  bufferMs: 120_000,
  maxResumeDelayMs: 6 * 60 * 60 * 1000,
  minIntervalMs: 60_000,
  maxResumesPerSession: 3,
}

describe('failure narrowing', () => {
  it('keeps the code, message, and a positive provider delay', () => {
    expect(asFailure({ code: 'RATE_LIMIT', message: 'slow down' }))
      .toEqual({ code: 'RATE_LIMIT', message: 'slow down' })
    expect(asFailure({ code: 'RATE_LIMIT', message: 'slow down', providerRetryAfterMs: 5000 }))
      .toEqual({ code: 'RATE_LIMIT', message: 'slow down', providerRetryAfterMs: 5000 })
  })

  it('drops a provider delay that could not be a wait', () => {
    expect(asFailure({ code: 'RATE_LIMIT', message: 'x', providerRetryAfterMs: 0 })).toEqual({ code: 'RATE_LIMIT', message: 'x' })
    expect(asFailure({ code: 'RATE_LIMIT', message: 'x', providerRetryAfterMs: Number.NaN })).toEqual({ code: 'RATE_LIMIT', message: 'x' })
  })

  it('rejects anything that is not a structured failure', () => {
    expect(asFailure(undefined)).toBeUndefined()
    expect(asFailure(null)).toBeUndefined()
    expect(asFailure('boom')).toBeUndefined()
    expect(asFailure({})).toBeUndefined()
    expect(asFailure({ code: '', message: 'x' })).toBeUndefined()
    expect(asFailure({ code: 'RATE_LIMIT' })).toBeUndefined()
  })
})

describe('resume planning', () => {
  it('declines a code this deployment does not resume', () => {
    expect(planResume({ failure: { code: 'AUTH', message: 'bad key' }, policy, now: NOW, resumes: 0 }))
      .toEqual({ kind: 'skip', reason: 'code' })
  })

  it('declines once the session spent its resume budget', () => {
    expect(planResume({ failure: { code: 'RATE_LIMIT', message: 'slow down' }, policy, now: NOW, resumes: 3 }))
      .toEqual({ kind: 'skip', reason: 'budget' })
  })

  it('honors a provider delay that is longer than the backoff ceiling', () => {
    const plan = planResume({
      failure: { code: 'RATE_LIMIT', message: 'slow down', providerRetryAfterMs: 300_000 },
      policy,
      now: NOW,
      resumes: 0,
    })
    expect(plan).toEqual({ kind: 'resume', resumeAt: NOW + 300_000 + policy.bufferMs, source: 'retry-after' })
  })

  it('clamps a stated instant to the configured maximum wait', () => {
    const plan = planResume({
      failure: { code: 'RATE_LIMIT', message: 'slow down', providerRetryAfterMs: 10 * 60 * 60 * 1000 },
      policy,
      now: NOW,
      resumes: 0,
    })
    expect(plan).toEqual({ kind: 'resume', resumeAt: NOW + policy.maxResumeDelayMs, source: 'retry-after' })
  })

  it('reads an instant out of the failure message and adds the buffer', () => {
    const plan = planResume({
      failure: { code: 'RATE_LIMIT', message: 'Rate limit reached. Please try again in 20 minutes.' },
      policy,
      now: NOW,
      resumes: 0,
    })
    expect(plan).toEqual({ kind: 'resume', resumeAt: NOW + 20 * 60_000 + policy.bufferMs, source: 'reset' })
  })

  it('falls back to a bounded backoff when the failure states no instant', () => {
    const plan = planResume({
      failure: { code: 'RATE_LIMIT', message: 'slow down' },
      policy,
      now: NOW,
      resumes: 0,
      random: () => 0.5,
    })
    expect(plan).toEqual({ kind: 'resume', resumeAt: NOW + policy.initialDelayMs, source: 'backoff' })
  })

  it('keeps at least the minimum spacing after the previous automatic resume', () => {
    const plan = planResume({
      failure: { code: 'RATE_LIMIT', message: 'slow down' },
      policy,
      now: NOW,
      resumes: 0,
      lastResumeAt: NOW - 1000,
      random: () => 0.5,
    })
    expect(plan).toEqual({ kind: 'resume', resumeAt: NOW + policy.minIntervalMs - 1000, source: 'backoff' })
  })

  it('does not shorten a stated wait to satisfy the minimum spacing', () => {
    const plan = planResume({
      failure: { code: 'RATE_LIMIT', message: 'slow down', providerRetryAfterMs: 600_000 },
      policy,
      now: NOW,
      resumes: 1,
      lastResumeAt: NOW - 1000,
    })
    expect(plan).toEqual({ kind: 'resume', resumeAt: NOW + 600_000 + policy.bufferMs, source: 'retry-after' })
  })
})

describe('backoff', () => {
  it('doubles per spent resume and stops at the ceiling', () => {
    expect(backoffDelay(0, policy, () => 0.5)).toBe(1000)
    expect(backoffDelay(1, policy, () => 0.5)).toBe(2000)
    expect(backoffDelay(2, policy, () => 0.5)).toBe(4000)
    expect(backoffDelay(3, policy, () => 0.5)).toBe(8000)
    expect(backoffDelay(9, policy, () => 0.5)).toBe(8000)
  })

  it('applies symmetric jitter and never leaves the ceiling', () => {
    expect(backoffDelay(0, policy, () => 0)).toBe(500)
    expect(backoffDelay(0, policy, () => 1)).toBe(1500)
    expect(backoffDelay(3, policy, () => 1)).toBe(8000)
  })
})
