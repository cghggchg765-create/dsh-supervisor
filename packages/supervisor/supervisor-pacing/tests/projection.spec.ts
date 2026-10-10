/**
 * The pacing session projection: every terminal reason folds into the state a
 * restarted harness reads to decide whether a run deserves a resume.
 */

import { describe, expect, it } from 'vitest'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent, TurnEndReason } from '@deepseek-ai/dsh-session'
import { foldPacing, INITIAL_PACING_STATE, INTERRUPTED_FAILURE, PACING_PROJECTION } from '../src/projection.ts'

/** One `turn/end` event carrying the given terminal reason. */
function turnEnd(reason: TurnEndReason, time = 1000): SessionEvent {
  return { type: 'turn/end', seq: SessionSeq(1), time, data: { turn: 1, reason } }
}

describe('the pacing projection', () => {
  it('registers under one key and folds from the empty state', () => {
    expect(PACING_PROJECTION.key).toBe('pacing')
    expect(PACING_PROJECTION.stateVersion).toBe(1)
    expect(PACING_PROJECTION.init()).toEqual(INITIAL_PACING_STATE)
    expect(INITIAL_PACING_STATE).toEqual({ outcome: 'none', failure: null, endedAt: null })
  })

  it('leaves the state alone for every event that is not a turn end', () => {
    const event: SessionEvent = { type: 'step/start', seq: SessionSeq(2), time: 5, data: { turn: 1, step: 1 } }
    expect(foldPacing(INITIAL_PACING_STATE, event)).toBe(INITIAL_PACING_STATE)
  })

  it('records a completed turn without a failure', () => {
    expect(foldPacing(INITIAL_PACING_STATE, turnEnd({ kind: 'completed' }, 42)))
      .toEqual({ outcome: 'completed', failure: null, endedAt: 42 })
  })

  it('records the failure facts of an errored turn', () => {
    expect(foldPacing(INITIAL_PACING_STATE, turnEnd({
      kind: 'error',
      error: { code: 'RATE_LIMIT', message: 'slow down', providerRetryAfterMs: 30_000 },
    })))
      .toEqual({
        outcome: 'error',
        failure: { code: 'RATE_LIMIT', message: 'slow down', providerRetryAfterMs: 30_000 },
        endedAt: 1000,
      })
    expect(foldPacing(INITIAL_PACING_STATE, turnEnd({ kind: 'error', error: { code: 'AUTH', message: 'bad key' } })))
      .toEqual({ outcome: 'error', failure: { code: 'AUTH', message: 'bad key' }, endedAt: 1000 })
  })

  it('treats a crash-orphaned turn as a resumable interruption', () => {
    expect(foldPacing(INITIAL_PACING_STATE, turnEnd({ kind: 'interrupted' })))
      .toEqual({ outcome: 'interrupted', failure: INTERRUPTED_FAILURE, endedAt: 1000 })
  })

  it('records any other terminal reason without a failure', () => {
    expect(foldPacing(INITIAL_PACING_STATE, turnEnd({ kind: 'aborted', reason: { kind: 'user' } })))
      .toEqual({ outcome: 'other', failure: null, endedAt: 1000 })
  })
})
