/**
 * Configuration resolution: the schema fills every single-field default, so the
 * resolvers are exercised directly for the documented defaults and for the
 * cross-field refusals the schema cannot express.
 */

import { describe, expect, it } from 'vitest'
import { RESUME_BUFFER_MS } from '@deepseek-ai/dsh-supervisor-core'
import { resolvePolicy, resolveSettings } from '../src/index.ts'

describe('configuration resolution', () => {
  it('applies every documented default', () => {
    expect(resolvePolicy({})).toEqual({
      codes: ['RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'EMPTY_RESPONSE', 'INTERRUPTED'],
      initialDelayMs: 1_000,
      maxDelayMs: 10_000,
      jitterRatio: 0.1,
      bufferMs: RESUME_BUFFER_MS,
      maxResumeDelayMs: 6 * 60 * 60 * 1000,
      minIntervalMs: 60_000,
      maxResumesPerSession: 3,
    })
    expect(resolveSettings({})).toEqual({
      enabled: true,
      scope: 'roots',
      resumeGoals: true,
      resumeOnRestart: false,
      notifyOnGiveUp: true,
      notifyChatId: '',
    })
  })

  it('keeps every value the deployment states', () => {
    expect(resolvePolicy({
      codes: ['RATE_LIMIT'],
      initialDelayMs: 250,
      maxDelayMs: 500,
      jitterRatio: 0,
      bufferMs: 0,
      maxResumeDelayMs: 60_000,
      minIntervalMs: 0,
      maxResumesPerSession: 1,
    })).toMatchObject({ initialDelayMs: 250, maxDelayMs: 500, maxResumesPerSession: 1 })
    expect(resolveSettings({
      enabled: false,
      scope: 'all',
      resumeGoals: false,
      resumeOnRestart: true,
      notifyOnGiveUp: false,
      notifyChatId: 'ops-chat',
    })).toEqual({
      enabled: false,
      scope: 'all',
      resumeGoals: false,
      resumeOnRestart: true,
      notifyOnGiveUp: false,
      notifyChatId: 'ops-chat',
    })
  })

  it('refuses a ladder that could never grow and an empty code list', () => {
    expect(() => resolvePolicy({ initialDelayMs: 100, maxDelayMs: 10 }))
      .toThrow('"maxDelayMs" must be at least "initialDelayMs"')
    expect(() => resolvePolicy({ codes: [] })).toThrow('"codes" must name at least one failure code')
  })
})
