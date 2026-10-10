import { describe, expect, it } from 'vitest'
import { DEFAULT_SHUTDOWN_POLICY, shutdownDecision, type ShutdownPolicy } from '../src/shutdown.ts'

/** Policy with a configured command and a one-minute grace period. */
const policy: ShutdownPolicy = { enabled: true, command: 'shutdown /s /t 0', gracePeriodMin: 1 }

/** Epoch milliseconds the decisions are taken at. */
const now = 1_000_000

describe('shutdown decisions', () => {
  it('starts disabled with no command', () => {
    expect(DEFAULT_SHUTDOWN_POLICY).toEqual({ enabled: false, command: '', gracePeriodMin: 5 })
  })

  it('refuses while auto-shutdown is disabled', () => {
    expect(shutdownDecision({ ...policy, enabled: false }, 'idle-timeout', now)).toEqual({
      allowed: false,
      reason: 'Shutdown refused for idle-timeout: auto-shutdown is disabled.',
    })
  })

  it('refuses while no shutdown command is configured', () => {
    expect(shutdownDecision({ ...policy, command: '   ' }, 'scheduled-time', now)).toEqual({
      allowed: false,
      reason: 'Shutdown refused for scheduled-time: no shutdown command is configured.',
    })
  })

  it('refuses all-tasks-completed inside the grace period', () => {
    expect(shutdownDecision(policy, 'all-tasks-completed', now, now - 30_000)).toEqual({
      allowed: false,
      reason: 'Shutdown refused for all-tasks-completed: the 1-minute grace period has not elapsed since the last task finished.',
    })
  })

  it('allows all-tasks-completed at the end of the grace period', () => {
    expect(shutdownDecision(policy, 'all-tasks-completed', now, now - 60_000)).toEqual({
      allowed: true,
      command: 'shutdown /s /t 0',
      reason: 'Shutdown allowed for all-tasks-completed: the 1-minute grace period elapsed since the last task finished.',
    })
  })

  it('allows all-tasks-completed when no finish time was recorded', () => {
    expect(shutdownDecision(policy, 'all-tasks-completed', now)).toEqual({
      allowed: true,
      command: 'shutdown /s /t 0',
      reason: 'Shutdown allowed for all-tasks-completed: the caller asserted every task finished and recorded no finish time.',
    })
  })

  it('allows the scheduled and idle triggers without a grace period', () => {
    expect(shutdownDecision(policy, 'scheduled-time', now)).toEqual({
      allowed: true,
      command: 'shutdown /s /t 0',
      reason: 'Shutdown allowed for scheduled-time: the configured command is enabled.',
    })
    expect(shutdownDecision(policy, 'idle-timeout', now, now - 1)).toEqual({
      allowed: true,
      command: 'shutdown /s /t 0',
      reason: 'Shutdown allowed for idle-timeout: the configured command is enabled.',
    })
  })

  it('authorizes the configured command with its padding trimmed', () => {
    expect(shutdownDecision({ ...policy, command: '  shutdown -h now  ' }, 'idle-timeout', now)).toEqual({
      allowed: true,
      command: 'shutdown -h now',
      reason: 'Shutdown allowed for idle-timeout: the configured command is enabled.',
    })
  })

  it('refuses a grace period that is not positive', () => {
    expect(() => shutdownDecision({ ...policy, gracePeriodMin: 0 }, 'scheduled-time', now)).toThrow(TypeError)
    expect(() => shutdownDecision({ ...policy, gracePeriodMin: 0 }, 'scheduled-time', now)).toThrow(/gracePeriodMin/)
    expect(() => shutdownDecision({ ...policy, gracePeriodMin: -5 }, 'idle-timeout', now)).toThrow(/gracePeriodMin/)
    expect(() => shutdownDecision({ ...policy, gracePeriodMin: Number.NaN }, 'idle-timeout', now)).toThrow(/gracePeriodMin/)
    expect(() => shutdownDecision({ ...policy, enabled: false, gracePeriodMin: 0 }, 'idle-timeout', now))
      .toThrow(/gracePeriodMin/)
  })
})
