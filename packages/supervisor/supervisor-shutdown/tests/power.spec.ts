/**
 * The shutdown decision core: plan completion, the next wall-clock instant, and
 * the reminders one attempt owes. Pure functions, no clock of their own.
 */

import { describe, expect, it } from 'vitest'
import { MINUTE_MS, allPlansComplete, dueReminders, isClock, nextClockInstant, planProgress, planWatchAction } from '../src/power.ts'
import type { TaskPlan } from '@deepseek-ai/dsh-supervisor-core'

/** One plan whose subtasks carry the given statuses. */
function plan(taskId: string, statuses: TaskPlan['subTasks'][number]['status'][]): TaskPlan {
  return {
    taskId,
    goal: 'ship it',
    constraints: [],
    acceptanceCriteria: [],
    subTasks: statuses.map((status, index) => ({
      id: `st-${String(index)}`,
      title: `task ${String(index)}`,
      description: 'do it',
      dependsOn: [],
      requiredSkills: [],
      estimatedEffort: 'small' as const,
      acceptanceCriteria: [],
      status,
    })),
    integrationStrategy: 'sequential-merge',
    createdAt: 1,
    updatedAt: 1,
  }
}

/** Local epoch milliseconds of one wall clock on the reference day. */
function localClock(year: number, month: number, day: number, hour: number, minute: number): number {
  const instant = new Date(2026, 0, 15, 10, 0, 0, 0)
  instant.setFullYear(year, month - 1, day)
  instant.setHours(hour, minute, 0, 0)
  return instant.getTime()
}

/** January 15, 2026 10:00 local, the instant every case resolves against. */
const NOW = localClock(2026, 1, 15, 10, 0)

describe('plan progress', () => {
  it('counts every subtask that is neither completed nor skipped', () => {
    expect(planProgress([plan('a', ['completed', 'skipped', 'pending']), plan('b', [])])).toEqual([
      { taskId: 'a', total: 3, unfinished: 1 },
      { taskId: 'b', total: 0, unfinished: 0 },
    ])
  })

  it('treats only a non-empty, fully finished plan set as completion', () => {
    expect(allPlansComplete([])).toBe(false)
    expect(allPlansComplete(planProgress([plan('a', ['completed', 'skipped']) ]))).toBe(true)
    expect(allPlansComplete(planProgress([plan('a', ['completed']), plan('b', ['in-progress'])]))).toBe(false)
    expect(allPlansComplete(planProgress([plan('a', ['failed'])]))).toBe(false)
  })
})

describe('wall clocks', () => {
  it('accepts a 24-hour clock and refuses anything else', () => {
    expect(isClock('00:00')).toBe(true)
    expect(isClock('23:59')).toBe(true)
    expect(isClock('7:05')).toBe(true)
    expect(isClock('24:00')).toBe(false)
    expect(isClock('12:60')).toBe(false)
    expect(isClock('1200')).toBe(false)
    expect(isClock('12:5')).toBe(false)
    expect(isClock('')).toBe(false)
    expect(isClock('a:00')).toBe(false)
  })

  it('resolves to today when the clock is ahead and tomorrow once it passed', () => {
    expect(nextClockInstant('23:30', NOW)).toBe(localClock(2026, 1, 15, 23, 30))
    expect(nextClockInstant('09:00', NOW)).toBe(localClock(2026, 1, 16, 9, 0))
    expect(nextClockInstant('10:00', NOW)).toBe(localClock(2026, 1, 16, 10, 0))
    expect(nextClockInstant('nope', NOW)).toBeUndefined()
  })
})

describe('reminders', () => {
  it('reports each crossed threshold once, most distant first', () => {
    expect(dueReminders(11 * MINUTE_MS, [10, 5, 1], [])).toEqual([])
    expect(dueReminders(9 * MINUTE_MS, [10, 5, 1], [])).toEqual([10])
    expect(dueReminders(4 * MINUTE_MS, [10, 5, 1], [10])).toEqual([5])
    expect(dueReminders(30_000, [10, 5, 1], [10, 5])).toEqual([1])
    expect(dueReminders(30_000, [10, 5, 1], [10, 5, 1])).toEqual([])
  })

  it('reports several crossed thresholds in one pass, most distant first', () => {
    expect(dueReminders(30_000, [1, 10, 5], [])).toEqual([10, 5, 1])
  })
})

describe('the plan watcher decision', () => {
  it('arms once plans are complete and records the completion instant', () => {
    expect(planWatchAction({ complete: true, armedByPlans: false, since: undefined, now: 500 }))
      .toEqual({ kind: 'arm', since: 500 })
    expect(planWatchAction({ complete: true, armedByPlans: false, since: 100, now: 500 }))
      .toEqual({ kind: 'arm', since: 100 })
  })

  it('cancels only the attempt it armed, and leaves other attempts alone', () => {
    expect(planWatchAction({ complete: false, armedByPlans: true, since: 100, now: 500 })).toEqual({ kind: 'cancel' })
    expect(planWatchAction({ complete: false, armedByPlans: false, since: undefined, now: 500 })).toEqual({ kind: 'none' })
  })

  it('leaves a complete plan set alone while its attempt is already armed', () => {
    expect(planWatchAction({ complete: true, armedByPlans: true, since: 100, now: 500 })).toEqual({ kind: 'none' })
  })
})
