/**
 * The shutdown decision core: what the stored plans say about completion, when a
 * configured wall clock next comes due, and which reminders are owed. Every
 * function is pure, so the scheduler's timing is testable without a clock.
 * @module @deepseek-ai/dsh-supervisor-shutdown/power
 */

import type { TaskPlan } from '@deepseek-ai/dsh-supervisor-core'

/** Milliseconds in one minute. */
export const MINUTE_MS = 60_000

/** One plan's subtask progress, as the completion watcher reads it. */
export interface PlanProgress {
  /** Plan identity, so a notice can name what is still open. */
  readonly taskId: string
  /** Subtasks the plan declares. */
  readonly total: number
  /** Subtasks that are neither completed nor skipped. */
  readonly unfinished: number
}

/**
 * Project stored plans into completion progress. A subtask counts as finished
 * only when it is `completed` or `skipped`, which is the shutdown gate's own
 * notion of unfinished work.
 * @param plans - stored plans to project.
 * @returns one progress entry per plan, in storage order.
 */
export function planProgress(plans: readonly TaskPlan[]): PlanProgress[] {
  return plans.map(plan => ({
    taskId: plan.taskId,
    total: plan.subTasks.length,
    unfinished: plan.subTasks.filter(subTask => subTask.status !== 'completed' && subTask.status !== 'skipped').length,
  }))
}

/**
 * Whether every stored plan finished its subtasks. An empty plan list is not
 * completion: a deployment that stored nothing has nothing to have finished.
 * @param progress - progress entries from {@link planProgress}.
 * @returns true when at least one plan exists and every plan has no unfinished subtask.
 */
export function allPlansComplete(progress: readonly PlanProgress[]): boolean {
  return progress.length > 0 && progress.every(plan => plan.unfinished === 0)
}

/**
 * Whether one string is a `HH:MM` local wall clock.
 * @param value - candidate text.
 * @returns true when the text is a valid 24-hour clock.
 */
export function isClock(value: string): boolean {
  const text = value.trim()
  const colon = text.indexOf(':')
  if (colon <= 0 || colon === text.length - 1) return false
  const hourText = text.slice(0, colon)
  const minuteText = text.slice(colon + 1)
  if (minuteText.length !== 2 || !allDigits(hourText) || !allDigits(minuteText)) return false
  return Number(hourText) <= 23 && Number(minuteText) <= 59
}

/**
 * The next instant a `HH:MM` wall clock comes due: today when it is still ahead,
 * tomorrow once it has passed. The date arithmetic runs through the local
 * calendar, so a day that crosses a daylight-saving boundary still lands on the
 * stated clock.
 * @param clock - `HH:MM` local wall clock.
 * @param now - epoch milliseconds to resolve against.
 * @returns the instant, or undefined when the clock is not a valid one.
 */
export function nextClockInstant(clock: string, now: number): number | undefined {
  if (!isClock(clock)) return undefined
  const text = clock.trim()
  const colon = text.indexOf(':')
  const hour = Number(text.slice(0, colon))
  const minute = Number(text.slice(colon + 1))
  const today = new Date(now)
  today.setHours(hour, minute, 0, 0)
  if (today.getTime() > now) return today.getTime()
  const tomorrow = new Date(now)
  tomorrow.setDate(tomorrow.getDate() + 1)
  tomorrow.setHours(hour, minute, 0, 0)
  return tomorrow.getTime()
}

/**
 * Reminder thresholds this remaining time crossed and that no earlier pass
 * announced. Each threshold fires once per armed attempt, so re-arming restarts
 * the reminders instead of replaying the ones already delivered.
 * @param remainingMs - milliseconds left before the attempt fires.
 * @param thresholdsMin - configured thresholds in minutes.
 * @param announced - thresholds already announced for this attempt.
 * @returns the thresholds to announce now, most distant first.
 */
export function dueReminders(
  remainingMs: number,
  thresholdsMin: readonly number[],
  announced: readonly number[],
): number[] {
  return thresholdsMin
    .filter(threshold => !announced.includes(threshold) && remainingMs <= threshold * MINUTE_MS)
    .sort((left, right) => right - left)
}

/** What the plan watcher should do with the armed attempt on one pass. */
export type PlanWatchAction =
  | { readonly kind: 'arm'; readonly since: number }
  | { readonly kind: 'cancel' }
  | { readonly kind: 'none' }

/**
 * Decide the plan watcher's move for one pass: arm once every plan finished,
 * cancel an attempt the watcher itself armed when work reopened, and otherwise
 * leave the state alone.
 * @param input - completion of the stored plans, whether an attempt is armed, the recorded completion instant, and now.
 * @returns the action for this pass.
 */
export function planWatchAction(input: {
  readonly complete: boolean
  readonly armedByPlans: boolean
  readonly since: number | undefined
  readonly now: number
}): PlanWatchAction {
  if (!input.complete) return input.armedByPlans ? { kind: 'cancel' } : { kind: 'none' }
  if (input.armedByPlans) return { kind: 'none' }
  return { kind: 'arm', since: input.since ?? input.now }
}

/**
 * Whether every character of one string is a decimal digit.
 * @param text - string the caller already knows is non-empty.
 * @returns true when no character falls outside `0`-`9`.
 */
function allDigits(text: string): boolean {
  for (const character of text) {
    if (character < '0' || character > '9') return false
  }
  return true
}
