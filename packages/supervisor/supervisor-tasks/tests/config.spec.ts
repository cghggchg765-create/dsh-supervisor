/**
 * Configuration resolution specs for the task-state component: the defaults a
 * deployment inherits when it configures nothing, the effective values it gets
 * from an explicit choice, and the loud refusal of unusable numbers. Plugin
 * mounting validates the authored config through `Config` first, so these cases
 * drive the resolver directly.
 */

import { describe, expect, it } from 'vitest'
import { resolveTaskConfig } from '../src/config.ts'

describe('task configuration', () => {
  it('defaults every choice and takes the state directory from the caller', () => {
    expect(resolveTaskConfig({}, '/state/root')).toEqual({
      stateDir: '/state/root',
      checkpointRetention: { maxPerTask: 10, maxAgeDays: 30 },
      checkpointBranchPrefix: 'supervisor/',
      maxRetriesPerIssue: 2,
    })
  })

  it('keeps every configured choice', () => {
    expect(resolveTaskConfig({
      checkpointBranchPrefix: 'checkpoint/',
      checkpointMaxPerTask: 3,
      checkpointMaxAgeDays: 5,
      maxRetriesPerIssue: 1,
    }, '/state/root')).toEqual({
      stateDir: '/state/root',
      checkpointRetention: { maxPerTask: 3, maxAgeDays: 5 },
      checkpointBranchPrefix: 'checkpoint/',
      maxRetriesPerIssue: 1,
    })
  })

  it('refuses a retention limit or retry budget that is not a positive number', () => {
    expect(() => resolveTaskConfig({ checkpointMaxPerTask: 0 }, '/state/root'))
      .toThrow('supervisor configuration field "checkpointMaxPerTask" must be a positive number')
    expect(() => resolveTaskConfig({ checkpointMaxAgeDays: Number.NaN }, '/state/root'))
      .toThrow('supervisor configuration field "checkpointMaxAgeDays" must be a positive number')
    expect(() => resolveTaskConfig({ maxRetriesPerIssue: -1 }, '/state/root'))
      .toThrow('supervisor configuration field "maxRetriesPerIssue" must be a positive number')
  })
})
