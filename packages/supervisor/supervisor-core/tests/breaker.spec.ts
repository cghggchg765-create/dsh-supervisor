import { describe, expect, it } from 'vitest'
import { DEFAULT_BREAKER_POLICY, ProgressBreaker, type BreakerPolicy } from '../src/breaker.ts'

/** Limits chosen so each ladder step is exactly one identical settlement. */
const policy: BreakerPolicy = { noProgressLimit: 2, openLimit: 3, cooldownSec: 300 }

/** Epoch milliseconds of the settlement that trips the breaker. */
const tripAt = 2_000

/** Drive a breaker to `open` with identical settlements. */
function trip(breaker: ProgressBreaker): void {
  breaker.observe(false, 0)
  breaker.observe(false, 1_000)
  breaker.observe(false, tripAt)
}

describe('progress breaker', () => {
  it('reports the first settlement as closed and counts its changed output', () => {
    const breaker = new ProgressBreaker(policy)
    expect(breaker.observe(true, 1_000)).toBe('closed')
    expect(breaker.report(1_000)).toEqual({ state: 'closed', consecutiveNoProgress: 0 })
  })

  it('stays closed below the no-progress limit and moves half-open at it', () => {
    const breaker = new ProgressBreaker(policy)
    expect(breaker.observe(false, 0)).toBe('closed')
    expect(breaker.report(0)).toEqual({ state: 'closed', consecutiveNoProgress: 1 })
    expect(breaker.observe(false, 1_000)).toBe('half-open')
  })

  it('restarts the identical-settlement count when output changes again', () => {
    const breaker = new ProgressBreaker(policy)
    breaker.observe(false, 0)
    breaker.observe(true, 1_000)
    expect(breaker.observe(false, 2_000)).toBe('closed')
    expect(breaker.report(2_000).consecutiveNoProgress).toBe(1)
  })

  it('trips open at the open limit and reports the seconds since it opened', () => {
    const breaker = new ProgressBreaker(policy)
    trip(breaker)
    expect(breaker.report(tripAt)).toEqual({ state: 'open', consecutiveNoProgress: 3, openForSec: 0 })
    expect(breaker.report(tripAt + 61_500)).toEqual({ state: 'open', consecutiveNoProgress: 3, openForSec: 62 })
  })

  it('keeps an open breaker open while a settlement lands inside the cooldown', () => {
    const breaker = new ProgressBreaker(policy)
    trip(breaker)
    const cooldownEnd = tripAt + policy.cooldownSec * 1000
    expect(breaker.observe(false, cooldownEnd - 1)).toBe('open')
    expect(breaker.report(cooldownEnd - 1)).toEqual({ state: 'open', consecutiveNoProgress: 4, openForSec: 300 })
  })

  it('re-probes half-open once the cooldown elapsed and can trip open again', () => {
    const breaker = new ProgressBreaker(policy)
    trip(breaker)
    const cooldownEnd = tripAt + policy.cooldownSec * 1000
    expect(breaker.observe(false, cooldownEnd)).toBe('half-open')
    expect(breaker.report(cooldownEnd)).toEqual({ state: 'half-open', consecutiveNoProgress: 4 })
    expect(breaker.observe(false, cooldownEnd + 1_000)).toBe('open')
  })

  it('moves back to closed as soon as an open breaker sees changed output', () => {
    const breaker = new ProgressBreaker(policy)
    trip(breaker)
    expect(breaker.observe(true, 100_000)).toBe('closed')
    expect(breaker.report(100_000)).toEqual({ state: 'closed', consecutiveNoProgress: 0 })
  })

  it('starts from the documented default escalation ladder', () => {
    expect(DEFAULT_BREAKER_POLICY).toEqual({ noProgressLimit: 2, openLimit: 3, cooldownSec: 300 })
  })
})
