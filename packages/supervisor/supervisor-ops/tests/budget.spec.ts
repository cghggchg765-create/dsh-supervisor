import { describe, expect, it } from 'vitest'
import {
  DEFAULT_BUDGET_POLICY,
  estimateCostUSD,
  parseUsage,
  priceOf,
  UsageLedger,
  type BudgetPolicy,
  type ModelPrice,
  type UsageEntry,
} from '../src/budget.ts'

/** Prices used by ledger tests: one dollar per million for the standard model. */
const prices: readonly ModelPrice[] = [
  { model: 'standard', usdPerMillionTokens: 1 },
  { model: 'premium', usdPerMillionTokens: 10 },
]

/** Limits with round numbers, so each threshold is exactly one recorded entry. */
const policy: BudgetPolicy = {
  taskBudgetUSD: 10,
  dailyBudgetUSD: 20,
  alertThresholdPct: 80,
  onExceed: 'stop-task',
}

/** Local-noon epoch milliseconds of the day `dayOffset` days after 2026-05-10. */
function localNoon(dayOffset: number): number {
  return new Date(2026, 4, 10 + dayOffset, 12, 0, 0).getTime()
}

/** One ledger entry billed through the price table. */
function standard(at: number, tokens: number): UsageEntry {
  return { at, model: 'standard', tokens }
}

describe('model prices', () => {
  it('looks a model up in the price table', () => {
    expect(priceOf('premium', prices)).toBe(10)
    expect(priceOf('missing', prices)).toBeUndefined()
    expect(priceOf(undefined, prices)).toBeUndefined()
  })

  it('turns a token count into dollars at one price', () => {
    expect(estimateCostUSD(1_000_000, 3)).toBe(3)
    expect(estimateCostUSD(250_000, 2)).toBe(0.5)
    expect(estimateCostUSD(0, 5)).toBe(0)
  })

  it('refuses a price that is not finite', () => {
    expect(() => estimateCostUSD(1_000, Number.NaN)).toThrow(TypeError)
    expect(() => estimateCostUSD(1_000, Number.NaN)).toThrow(/usdPerMillionTokens/)
    expect(() => estimateCostUSD(1_000, Number.POSITIVE_INFINITY)).toThrow(/usdPerMillionTokens/)
  })
})

describe('token counts in CLI output', () => {
  it('reads a plain count', () => {
    expect(parseUsage('used 1200 tokens')).toEqual({ tokens: 1200 })
  })

  it('scales the k and m suffixes', () => {
    expect(parseUsage('12.5k tokens')).toEqual({ tokens: 12_500 })
    expect(parseUsage('1.5M tokens')).toEqual({ tokens: 1_500_000 })
  })

  it('reads the phrase case-insensitively, singular or plural', () => {
    expect(parseUsage('TOKENS: 2K TOKENS')).toEqual({ tokens: 2_000 })
    expect(parseUsage('7 token')).toEqual({ tokens: 7 })
  })

  it('returns the largest count when several appear', () => {
    expect(parseUsage('12.5k tokens then 3 tokens')).toEqual({ tokens: 12_500 })
    expect(parseUsage('10 tokens then 2k tokens')).toEqual({ tokens: 2_000 })
  })

  it('reports nothing when the text carries no count', () => {
    expect(parseUsage('no usage in this line')).toBeUndefined()
    expect(parseUsage('1200 calls')).toBeUndefined()
  })
})

describe('usage ledger', () => {
  it('starts from the documented default policy', () => {
    expect(DEFAULT_BUDGET_POLICY).toEqual({
      taskBudgetUSD: 5,
      dailyBudgetUSD: 20,
      alertThresholdPct: 80,
      onExceed: 'downgrade-all',
    })
  })

  it('prices an explicit cost first, then the model table, then zero', () => {
    const ledger = new UsageLedger(policy, prices)
    ledger.record(standard(localNoon(0), 1_000_000))
    ledger.record({ at: localNoon(0), model: 'premium', tokens: 1_000_000, costUSD: 2 })
    ledger.record({ at: localNoon(0), model: 'unknown', tokens: 1_000_000 })
    ledger.record({ at: localNoon(0), tokens: 1_000_000 })
    expect(ledger.status(localNoon(0))).toMatchObject({ taskUSD: 3, dailyUSD: 3 })
  })

  it('sums the task entries and only the current local day', () => {
    const ledger = new UsageLedger(policy, prices)
    ledger.record(standard(localNoon(0), 2_000_000))
    ledger.record(standard(localNoon(1), 1_000_000))
    expect(ledger.status(localNoon(1))).toEqual({
      taskUSD: 3,
      dailyUSD: 1,
      alert: false,
      exceeded: false,
      onExceed: 'stop-task',
    })
  })

  it('alerts when the task reaches its share of the budget', () => {
    const ledger = new UsageLedger(policy, prices)
    ledger.record(standard(localNoon(0), 7_000_000))
    expect(ledger.status(localNoon(0))).toMatchObject({ taskUSD: 7, alert: false, exceeded: false })
    ledger.record(standard(localNoon(0), 1_000_000))
    expect(ledger.status(localNoon(0))).toMatchObject({ taskUSD: 8, alert: true, exceeded: false })
  })

  it('drops the task spend on reset while the daily spend survives', () => {
    const ledger = new UsageLedger(policy, prices)
    ledger.record(standard(localNoon(0), 4_000_000))
    ledger.resetTask()
    ledger.record(standard(localNoon(0), 1_000_000))
    expect(ledger.status(localNoon(0))).toMatchObject({ taskUSD: 1, dailyUSD: 5 })
  })

  it('alerts from the daily budget alone after a task reset', () => {
    const ledger = new UsageLedger(policy, prices)
    ledger.record(standard(localNoon(0), 16_000_000))
    ledger.resetTask()
    ledger.record(standard(localNoon(0), 1_000_000))
    expect(ledger.status(localNoon(0))).toMatchObject({ taskUSD: 1, dailyUSD: 17, alert: true, exceeded: false })
  })

  it('exceeds from the daily budget alone after a task reset', () => {
    const ledger = new UsageLedger(policy, prices)
    ledger.record(standard(localNoon(0), 20_000_000))
    ledger.resetTask()
    ledger.record(standard(localNoon(0), 1_000_000))
    expect(ledger.status(localNoon(0))).toMatchObject({ taskUSD: 1, dailyUSD: 21, alert: true, exceeded: true })
  })

  it('treats a spend equal to a budget as exceeded', () => {
    const ledger = new UsageLedger(policy, prices)
    ledger.record(standard(localNoon(0), 10_000_000))
    expect(ledger.status(localNoon(0))).toMatchObject({ taskUSD: 10, alert: true, exceeded: true })
  })

  it('keeps every recorded entry oldest first', () => {
    const ledger = new UsageLedger(policy, prices)
    const first = standard(localNoon(0), 1)
    const second: UsageEntry = { at: localNoon(0), costUSD: 0.25, tokens: 1 }
    ledger.record(first)
    ledger.record(second)
    expect(ledger.entries).toEqual([first, second])
  })

  it('refuses a budget that is not positive', () => {
    expect(() => new UsageLedger({ ...policy, taskBudgetUSD: 0 }, prices)).toThrow(TypeError)
    expect(() => new UsageLedger({ ...policy, taskBudgetUSD: 0 }, prices)).toThrow(/taskBudgetUSD/)
    expect(() => new UsageLedger({ ...policy, dailyBudgetUSD: -1 }, prices)).toThrow(/dailyBudgetUSD/)
    expect(() => new UsageLedger({ ...policy, taskBudgetUSD: Number.NaN }, prices)).toThrow(/taskBudgetUSD/)
  })

  it('refuses an alert threshold outside one to one hundred', () => {
    expect(() => new UsageLedger({ ...policy, alertThresholdPct: 0 }, prices)).toThrow(/alertThresholdPct/)
    expect(() => new UsageLedger({ ...policy, alertThresholdPct: 101 }, prices)).toThrow(/alertThresholdPct/)
    expect(() => new UsageLedger({ ...policy, alertThresholdPct: Number.NaN }, prices)).toThrow(/alertThresholdPct/)
  })

  it('accepts the threshold bounds and refuses a price that is not finite', () => {
    expect(() => new UsageLedger({ ...policy, alertThresholdPct: 1 }, prices)).not.toThrow()
    expect(() => new UsageLedger({ ...policy, alertThresholdPct: 100 }, prices)).not.toThrow()
    const broken: readonly ModelPrice[] = [{ model: 'broken', usdPerMillionTokens: Number.POSITIVE_INFINITY }]
    expect(() => new UsageLedger(policy, broken)).toThrow(/usdPerMillionTokens/)
  })
})
