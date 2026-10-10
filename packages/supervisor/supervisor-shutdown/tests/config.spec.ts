/**
 * Settings resolution: the schema fills every single-field default, so the
 * resolver is exercised directly for the documented defaults, for both ways of
 * arming a timed shutdown, and for the one cross-field refusal.
 */

import { describe, expect, it } from 'vitest'
import { MINUTE_MS } from '../src/power.ts'
import { resolveSettings } from '../src/index.ts'

describe('shutdown settings', () => {
  it('applies every documented default, with nothing armed', () => {
    expect(resolveSettings({})).toEqual({
      enabled: false,
      scheduledAt: undefined,
      watchPlans: false,
      idleTimeoutMs: 0,
      remindAtMin: [10, 5, 1],
      cancelCommand: '',
      notifyChatId: '',
      dryRun: false,
      pollIntervalMs: 30_000,
      commandTimeoutMs: 30_000,
    })
  })

  it('arms a countdown from the configured minutes', () => {
    const before = Date.now()
    const settings = resolveSettings({ scheduleAfterMinutes: 90 })
    expect(settings.scheduledAt).toBeGreaterThanOrEqual(before + 90 * MINUTE_MS)
    expect(settings.scheduledAt).toBeLessThanOrEqual(Date.now() + 90 * MINUTE_MS)
  })

  it('arms the next occurrence of a wall clock', () => {
    const settings = resolveSettings({ scheduleAt: '23:30' })
    expect(settings.scheduledAt).toBeDefined()
    expect(new Date(settings.scheduledAt ?? 0).getHours()).toBe(23)
    expect(new Date(settings.scheduledAt ?? 0).getMinutes()).toBe(30)
  })

  it('keeps every value the deployment states', () => {
    const settings = resolveSettings({
      enabled: true,
      watchPlans: true,
      idleTimeoutMin: 15,
      remindAtMin: [30],
      cancelCommand: 'shutdown /a',
      notifyChatId: 'ops-chat',
      dryRun: true,
      pollIntervalSec: 5,
      commandTimeoutSec: 60,
    })
    expect(settings).toMatchObject({
      enabled: true,
      watchPlans: true,
      idleTimeoutMs: 15 * MINUTE_MS,
      remindAtMin: [30],
      cancelCommand: 'shutdown /a',
      notifyChatId: 'ops-chat',
      dryRun: true,
      pollIntervalMs: 5_000,
      commandTimeoutMs: 60_000,
    })
  })

  it('refuses a schedule that is not a wall clock', () => {
    expect(() => resolveSettings({ scheduleAt: 'tonight' }))
      .toThrow('"scheduleAt" must be a HH:MM wall clock')
  })
})
