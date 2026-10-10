/**
 * The pacing session projection: how one session's last turn ended, folded from
 * committed events so a restarted harness can decide whether an interrupted run
 * deserves a resume without reading history synchronously.
 * @module @deepseek-ai/dsh-supervisor-pacing/projection
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { z as zod } from 'zod'
import type { PacingFailure } from './pacing.ts'

/** How one session's last recorded turn ended. */
export type PacingOutcome = 'none' | 'completed' | 'error' | 'interrupted' | 'other'

/** The failure a crash-orphaned turn is treated as, so recovery can resume it. */
export const INTERRUPTED_FAILURE: PacingFailure = {
  code: 'INTERRUPTED',
  message: 'the turn was interrupted before this process started',
}

/** The pacing projection's fold state for one session. */
export interface PacingSessionState {
  /** Terminal reason of the last recorded turn. */
  readonly outcome: PacingOutcome
  /** Failure facts of the last failed or interrupted turn, or null. */
  readonly failure: PacingFailure | null
  /** Epoch milliseconds the last turn ended at, or null before any turn ends. */
  readonly endedAt: number | null
}

/** The fold state before any turn ends. */
export const INITIAL_PACING_STATE: PacingSessionState = {
  outcome: 'none',
  failure: null,
  endedAt: null,
}

/** Schema validating a fold state restored from the projection cache. */
const pacingStateSchema = zod.object({
  /** Terminal reason of the last recorded turn. */
  outcome: zod.union([
    zod.literal('none'),
    zod.literal('completed'),
    zod.literal('error'),
    zod.literal('interrupted'),
    zod.literal('other'),
  ]),
  /** Failure facts of the last failed or interrupted turn, or null. */
  failure: zod.object({
    code: zod.string(),
    message: zod.string(),
    providerRetryAfterMs: zod.number().optional(),
  }).nullable(),
  /** Epoch milliseconds the last turn ended at, or null. */
  endedAt: zod.number().nullable(),
})

/**
 * Fold one committed session event into the pacing state. Only `turn/end`
 * carries a terminal reason, so every other event returns the state unchanged.
 * @param state - state before the event.
 * @param event - committed event to fold.
 * @returns the state after the event.
 */
export function foldPacing(state: PacingSessionState, event: SessionEvent): PacingSessionState {
  if (event.type !== 'turn/end') return state
  const reason = event.data.reason
  if (reason.kind === 'error') {
    return {
      outcome: 'error',
      failure: {
        code: reason.error.code,
        message: reason.error.message,
        ...reason.error.providerRetryAfterMs === undefined
          ? {}
          : { providerRetryAfterMs: reason.error.providerRetryAfterMs },
      },
      endedAt: event.time,
    }
  }
  if (reason.kind === 'interrupted') {
    return { outcome: 'interrupted', failure: INTERRUPTED_FAILURE, endedAt: event.time }
  }
  const outcome: PacingOutcome = reason.kind === 'completed' ? 'completed' : 'other'
  return { outcome, failure: null, endedAt: event.time }
}

/** The session projection this plugin registers under the `pacing` key. */
export const PACING_PROJECTION = {
  key: 'pacing',
  stateVersion: 1,
  stateSchema: pacingStateSchema,
  init: (): PacingSessionState => INITIAL_PACING_STATE,
  apply: foldPacing,
} as const

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Automatic pacing's fold state for one session. */
    pacing: PacingSessionState
  }
}
