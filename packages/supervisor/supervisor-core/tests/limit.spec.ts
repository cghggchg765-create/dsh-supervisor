import { describe, expect, it } from 'vitest'
import { isProviderLimit, isUsageLimit, parseLimitReset, parseProviderReset, RESUME_BUFFER_MS, shouldResume } from '../src/limit.ts'

/** Epoch milliseconds of one UTC wall clock. */
function utc(year: number, month: number, day: number, hour: number = 0, minute: number = 0): number {
  return Date.UTC(year, month - 1, day, hour, minute)
}

/** January 15, 2026 10:00 UTC, a Thursday, used as the scan instant. */
const NOW = utc(2026, 1, 15, 10)

describe('usage-limit detection', () => {
  it('accepts every known limit wording when the gate phrase appears', () => {
    expect(isUsageLimit('Claude usage limit reached. Your limit will reset at 3pm.')).toBe(true)
    expect(isUsageLimit("You've hit your usage limit. Try again later.")).toBe(true)
    expect(isUsageLimit("You're out of extra usage. Wait for the reset.")).toBe(true)
    expect(isUsageLimit('Quota exceeded for this limit.')).toBe(true)
    expect(isUsageLimit('Too many requests right now; the limit will clear.')).toBe(true)
    expect(isUsageLimit('HTTP 429 on the rate limit endpoint.')).toBe(true)
  })

  it('rejects wording that has no limit phrase or no gate phrase', () => {
    expect(isUsageLimit('quota exceeded')).toBe(false)
    expect(isUsageLimit('429 Too Many Requests')).toBe(false)
    expect(isUsageLimit('All clear, no limits at all.')).toBe(false)
    expect(isUsageLimit('Everything finished successfully.')).toBe(false)
  })
})

describe('limit reset parsing', () => {
  it('reads a wall clock in the zone stated in parentheses', () => {
    const text = 'Claude usage limit reached. Your limit will reset at 3pm (America/New_York).'
    expect(parseLimitReset(text, NOW, 'UTC')).toEqual({
      resumeAt: utc(2026, 1, 15, 20),
      phrase: 'reset at 3pm (America/New_York)',
      source: 'reset-time',
    })
  })

  it('reads a wall clock in the caller zone, with minutes and meridiem', () => {
    expect(parseLimitReset('usage limit reached. resets 3:30pm', NOW, 'UTC')?.resumeAt).toBe(utc(2026, 1, 15, 15, 30))
    expect(parseLimitReset('usage limit reached. resets at 11 am', NOW, 'UTC')?.resumeAt).toBe(utc(2026, 1, 15, 11))
    expect(parseLimitReset('usage limit reached. resets at 3PM', NOW, 'UTC')?.resumeAt).toBe(utc(2026, 1, 15, 15))
  })

  it('reads a 24-hour wall clock without a meridiem', () => {
    const reset = parseLimitReset('usage limit reached. resets 15:00', NOW, 'UTC')
    expect(reset).toEqual({ resumeAt: utc(2026, 1, 15, 15), phrase: 'resets 15:00', source: 'reset-time' })
  })

  it('moves a wall clock that already passed to the next day', () => {
    expect(parseLimitReset('usage limit reached. resets at 9am', NOW, 'UTC')?.resumeAt).toBe(utc(2026, 1, 16, 9))
  })

  it('resolves a weekday to its next occurrence', () => {
    expect(parseLimitReset('usage limit reached. resets Mon 3pm', NOW, 'UTC')?.resumeAt).toBe(utc(2026, 1, 19, 15))
  })

  it('resolves the current weekday a week ahead', () => {
    expect(parseLimitReset('usage limit reached. resets Thu 3pm', NOW, 'UTC')?.resumeAt).toBe(utc(2026, 1, 22, 15))
  })

  it('resolves a calendar date in the current year', () => {
    const reset = parseLimitReset('usage limit reached. resets January 20 at 3pm', NOW, 'UTC')
    expect(reset?.source).toBe('reset-time')
    expect(reset?.resumeAt).toBe(utc(2026, 1, 20, 15))
  })

  it('rolls a date over two days past into the next year', () => {
    const now = utc(2026, 12, 30, 10)
    expect(parseLimitReset('usage limit reached. resets Jan 2 at 3pm', now, 'UTC')?.resumeAt).toBe(utc(2027, 1, 2, 15))
  })

  it('keeps a date within two days in the past', () => {
    expect(parseLimitReset('usage limit reached. resets Jan 14 at 3pm', NOW, 'UTC')?.resumeAt).toBe(utc(2026, 1, 14, 15))
  })

  it('falls back when the stated zone is not one the runtime resolves', () => {
    const text = 'usage limit reached. resets at 3pm (Not/AZone)'
    expect(parseLimitReset(text, NOW, 'UTC')?.resumeAt).toBe(utc(2026, 1, 15, 15))
  })

  it('reads an epoch-seconds restatement', () => {
    expect(parseLimitReset('usage limit reached|1735689600', utc(2024, 12, 31, 10))).toEqual({
      resumeAt: 1735689600000,
      phrase: 'usage limit reached|1735689600',
      source: 'epoch',
    })
  })

  it('rejects a reset further than eight days ahead', () => {
    expect(parseLimitReset('usage limit reached. resets Dec 1 at 3pm', NOW, 'UTC')).toBeUndefined()
    expect(parseLimitReset('usage limit reached|1735689600', utc(2024, 1, 1))).toBeUndefined()
  })

  it('rejects text without a limit phrase', () => {
    expect(parseLimitReset('Everything is fine. resets at 3pm', NOW, 'UTC')).toBeUndefined()
  })

  it('rejects a limit phrase with no parseable time', () => {
    expect(parseLimitReset('usage limit reached. Try again later.', NOW, 'UTC')).toBeUndefined()
  })

  it('rejects an impossible wall clock', () => {
    expect(parseLimitReset('usage limit reached. resets at 25pm', NOW, 'UTC')).toBeUndefined()
    expect(parseLimitReset('usage limit reached. resets at 0pm', NOW, 'UTC')).toBeUndefined()
    expect(parseLimitReset('usage limit reached. resets at 99', NOW, 'UTC')).toBeUndefined()
    expect(parseLimitReset('usage limit reached. resets at 3:99pm', NOW, 'UTC')).toBeUndefined()
  })

  it('reads the reset only from the 160 characters after the first limit phrase', () => {
    const distant = `usage limit reached${'x'.repeat(200)} resets at 3pm`
    expect(parseLimitReset(distant, NOW, 'UTC')).toBeUndefined()
    const earlier = `Too many requests.${'x'.repeat(200)} usage limit reached. resets at 3pm`
    expect(parseLimitReset(earlier, NOW, 'UTC')).toBeUndefined()
  })

  it('falls back to the host zone when the caller zone is not resolvable', () => {
    const text = 'usage limit reached. resets at 3pm'
    expect(parseLimitReset(text, NOW, 'Nowhere/Invalid')).toBeDefined()
  })
})

describe('resume scheduling', () => {
  it('waits a fixed buffer past the stated reset', () => {
    expect(RESUME_BUFFER_MS).toBe(120_000)
  })

  it('resumes once the reset instant arrives', () => {
    expect(shouldResume(undefined, NOW)).toBe(false)
    expect(shouldResume(NOW + 1, NOW)).toBe(false)
    expect(shouldResume(NOW, NOW)).toBe(true)
    expect(shouldResume(NOW - 1, NOW)).toBe(true)
  })
})

describe('provider reset parsing', () => {
  it('recognizes provider limit wording the CLI gate would miss', () => {
    expect(isProviderLimit('429 Too Many Requests')).toBe(true)
    expect(isProviderLimit('Rate limit exceeded, please slow down.')).toBe(true)
    expect(isProviderLimit('rate_limit_error: too many requests')).toBe(true)
    expect(isProviderLimit('You exceeded your current quota.')).toBe(true)
    expect(isProviderLimit('The engine is currently overloaded, please try again later.')).toBe(true)
    expect(isProviderLimit('Invalid API key.')).toBe(false)
    expect(isProviderLimit('Upstream connection reset.')).toBe(false)
  })

  it('reads a retry-after count stated in seconds', () => {
    expect(parseProviderReset('Rate limit exceeded. retry-after: 30', NOW))
      .toMatchObject({ resumeAt: NOW + 30_000, source: 'retry-after' })
    expect(parseProviderReset('429 too many requests (retry after 12)', NOW))
      .toMatchObject({ resumeAt: NOW + 12_000, source: 'retry-after' })
  })

  it('reads a delay stated relative to now, including several terms', () => {
    expect(parseProviderReset('Rate limit reached for gpt. Please try again in 20 minutes.', NOW))
      .toMatchObject({ resumeAt: NOW + 20 * 60_000, source: 'relative' })
    expect(parseProviderReset('quota exceeded; retry in 1 hour 30 minutes', NOW))
      .toMatchObject({ resumeAt: NOW + (90 * 60_000), source: 'relative' })
    expect(parseProviderReset('Overloaded. Try again in 5s.', NOW))
      .toMatchObject({ resumeAt: NOW + 5000, source: 'relative' })
  })

  it('reads an absolute instant in ISO-8601 or HTTP-date form', () => {
    const iso = parseProviderReset('rate limit exceeded; resets at 2026-01-15T11:30:00Z', NOW)
    expect(iso).toMatchObject({ resumeAt: utc(2026, 1, 15, 11, 30), source: 'timestamp' })
    const http = parseProviderReset('429 Too Many Requests. Retry after Wed, 15 Jan 2026 11:30:00 GMT', NOW)
    expect(http).toMatchObject({ resumeAt: utc(2026, 1, 15, 11, 30), source: 'timestamp' })
  })

  it('states nothing when the message carries no credible instant', () => {
    expect(parseProviderReset('Rate limit exceeded, please slow down.', NOW)).toBeUndefined()
    expect(parseProviderReset('Rate limit exceeded; resets at 2027-01-01T00:00:00Z', NOW)).toBeUndefined()
    expect(parseProviderReset('Invalid API key.', NOW)).toBeUndefined()
  })

  it('states nothing when a trigger is followed by no parsable duration', () => {
    expect(parseProviderReset('Rate limit exceeded. retry-after: ', NOW)).toBeUndefined()
    expect(parseProviderReset('Rate limit exceeded; try again in a moment', NOW)).toBeUndefined()
    expect(parseProviderReset('Rate limit exceeded; try again in 5 parsecs', NOW)).toBeUndefined()
    expect(parseProviderReset('Rate limit exceeded; retry in', NOW)).toBeUndefined()
  })

  it('states nothing when an instant-shaped token or a GMT token does not parse', () => {
    expect(parseProviderReset('rate limit exceeded; resets at 2026-13-45T99:99:99Z', NOW)).toBeUndefined()
    expect(parseProviderReset('429 too many requests at GMT', NOW)).toBeUndefined()
    expect(parseProviderReset('rate limit; retry after Wed, 45 Foo 2026 11:30:00 GMT', NOW)).toBeUndefined()
    expect(parseProviderReset('rate limit; back at GMT and Wed, 15 Jan 2026 11:30:00 GMT', NOW))
      .toMatchObject({ resumeAt: utc(2026, 1, 15, 11, 30), source: 'timestamp' })
  })
})
