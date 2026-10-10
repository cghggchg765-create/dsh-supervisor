/**
 * Token spend accounting for supervised tasks. Hosted CLIs print token counts
 * in their output; this module turns those counts into dollars with the price
 * table an operator configured, keeps one running total per task and one per
 * local calendar day, and reports when a total reaches the alert threshold or
 * the budget itself.
 *
 * The ledger never stops anything on its own: `status` reports `exceeded` and
 * the policy's `onExceed`, and the supervising model applies that action.
 * @module @deepseek-ai/dsh-supervisor-ops/budget
 */

/** Token price of one model, used to turn a token count into money. */
export interface ModelPrice {
  /** Model id the price applies to. */
  model: string
  /** US dollars per one million tokens. */
  usdPerMillionTokens: number
}

/** One usage observation. */
export interface UsageEntry {
  /** Epoch milliseconds the usage was observed. */
  at: number
  /** Model that produced the usage, when the output named one. */
  model?: string
  /** Tokens consumed. */
  tokens: number
  /** Cost in US dollars, when the caller knows it better than the price table. */
  costUSD?: number
}

/** Budget limits and the action taken when one is crossed. */
export interface BudgetPolicy {
  /** Dollars allowed for one task. */
  taskBudgetUSD: number
  /** Dollars allowed per calendar day. */
  dailyBudgetUSD: number
  /** Percentage of a budget at which the caller is warned. */
  alertThresholdPct: number
  /** Action the supervising model should take once a budget is exceeded. */
  onExceed: 'downgrade-all' | 'stop-task'
}

/** Default policy: a small per-task allowance under a larger daily one. */
export const DEFAULT_BUDGET_POLICY: BudgetPolicy = {
  taskBudgetUSD: 5,
  dailyBudgetUSD: 20,
  alertThresholdPct: 80,
  onExceed: 'downgrade-all',
}

/** Budget state as a tool result reports it. */
export interface BudgetStatus {
  /** Dollars spent on the current task. */
  taskUSD: number
  /** Dollars spent today, in the host's local calendar day. */
  dailyUSD: number
  /** Whether either budget reached its alert threshold. */
  alert: boolean
  /** Whether either budget was exceeded. */
  exceeded: boolean
  /** Action to take once exceeded. */
  onExceed: BudgetPolicy['onExceed']
}

/** Multiplier of the `k` suffix. */
const THOUSAND = 1_000

/** Multiplier of the `m` suffix and the denominator of a per-million price. */
const MILLION = 1_000_000

/**
 * A token count, an optional `k`/`m` suffix, and the word `tokens`, matching
 * how the hosted CLIs print a usage line, e.g. `12.5k tokens`.
 */
const USAGE_PATTERN = /(\d+(?:\.\d+)?)\s*([km])?\s*tokens?\b/gi

/** One recorded observation with the dollars it contributed. */
interface PricedEntry {
  /** Observation exactly as the caller recorded it. */
  entry: UsageEntry
  /** Dollar cost resolved at record time. */
  costUSD: number
}

/** Running spend for one task and the current day. */
export class UsageLedger {
  private readonly recorded: PricedEntry[] = []

  /** Index in `recorded` where the current task's spend begins. */
  private taskStart = 0

  /**
   * @param policy - resolved budget limits.
   * @param prices - model price table used when an entry carries no explicit cost.
   * @throws TypeError when a budget is not positive, the alert threshold is
   * outside 1-100, or a table price is not finite.
   */
  constructor(
    private readonly policy: BudgetPolicy,
    private readonly prices: readonly ModelPrice[],
  ) {
    requirePositive(policy.taskBudgetUSD, 'taskBudgetUSD')
    requirePositive(policy.dailyBudgetUSD, 'dailyBudgetUSD')
    if (!Number.isFinite(policy.alertThresholdPct) || policy.alertThresholdPct < 1 || policy.alertThresholdPct > 100) {
      throw new TypeError('supervisor budget field "alertThresholdPct" must be between 1 and 100')
    }
    for (const price of prices) requireFinitePrice(price.usdPerMillionTokens)
  }

  /**
   * Record one observation; its cost is the explicit one, else the price table's, else zero.
   * @param entry - usage to record.
   */
  record(entry: UsageEntry): void {
    this.recorded.push({ entry, costUSD: this.costOf(entry) })
  }

  /**
   * Current spend and whether a limit was reached.
   * @param now - epoch milliseconds defining the local calendar day.
   * @returns task and daily dollars with the alert and exceeded flags.
   */
  status(now: number): BudgetStatus {
    let taskUSD = 0
    let dailyUSD = 0
    for (const [index, row] of this.recorded.entries()) {
      if (index >= this.taskStart) taskUSD += row.costUSD
      if (sameLocalDay(row.entry.at, now)) dailyUSD += row.costUSD
    }
    return {
      taskUSD,
      dailyUSD,
      alert: taskUSD >= this.alertFrom(this.policy.taskBudgetUSD) || dailyUSD >= this.alertFrom(this.policy.dailyBudgetUSD),
      exceeded: taskUSD >= this.policy.taskBudgetUSD || dailyUSD >= this.policy.dailyBudgetUSD,
      onExceed: this.policy.onExceed,
    }
  }

  /** Drop the task's spend, keeping the daily total. */
  resetTask(): void {
    this.taskStart = this.recorded.length
  }

  /** Every recorded entry, oldest first. */
  get entries(): readonly UsageEntry[] {
    return this.recorded.map(row => row.entry)
  }

  /** Dollars at which the alert threshold is reached for one budget. */
  private alertFrom(budgetUSD: number): number {
    return budgetUSD * this.policy.alertThresholdPct / 100
  }

  /** Dollars one observation contributes, resolving the fallbacks in order. */
  private costOf(entry: UsageEntry): number {
    if (entry.costUSD !== undefined) return entry.costUSD
    const price = priceOf(entry.model, this.prices)
    return price === undefined ? 0 : estimateCostUSD(entry.tokens, price)
  }
}

/**
 * Price of one model, or undefined when the table has no entry for it.
 * @param model - model id to look up.
 * @param prices - price table to search.
 * @returns the model's dollars per one million tokens, or undefined when absent.
 */
export function priceOf(model: string | undefined, prices: readonly ModelPrice[]): number | undefined {
  if (model === undefined) return undefined
  return prices.find(price => price.model === model)?.usdPerMillionTokens
}

/**
 * Cost of a token count at one price.
 * @param tokens - tokens consumed.
 * @param usdPerMillionTokens - US dollars per one million tokens.
 * @returns the cost in US dollars.
 * @throws TypeError when the price is not finite.
 */
export function estimateCostUSD(tokens: number, usdPerMillionTokens: number): number {
  requireFinitePrice(usdPerMillionTokens)
  return tokens / MILLION * usdPerMillionTokens
}

/**
 * Token count parsed out of CLI output, e.g. `12.5k tokens`.
 * @param text - CLI output to scan.
 * @returns the largest parsed count, or undefined when the text carries none.
 */
export function parseUsage(text: string): { tokens: number } | undefined {
  let largest: number | undefined
  for (const match of text.matchAll(USAGE_PATTERN)) {
    // The pattern requires the digits group, so the captured text is a number.
    const tokens = Number(match[1]) * scaleOf(match[2])
    if (largest === undefined || tokens > largest) largest = tokens
  }
  return largest === undefined ? undefined : { tokens: largest }
}

/** Reject a non-positive or non-finite configured budget. */
function requirePositive(value: number, field: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError(`supervisor budget field "${field}" must be a positive number`)
  }
}

/** Reject a price that cannot produce a finite cost. */
function requireFinitePrice(usdPerMillionTokens: number): void {
  if (!Number.isFinite(usdPerMillionTokens)) {
    throw new TypeError('supervisor budget field "usdPerMillionTokens" must be a finite number')
  }
}

/** Multiplier of one parsed `k`/`m` suffix, one when the count carries none. */
function scaleOf(suffix: string | undefined): number {
  if (suffix === undefined) return 1
  return suffix.toLowerCase() === 'k' ? THOUSAND : MILLION
}

/** Whether two instants fall on the same local calendar day. */
function sameLocalDay(left: number, right: number): boolean {
  return localDayKey(left) === localDayKey(right)
}

/** Local calendar day of one instant, as a comparable key. */
function localDayKey(at: number): string {
  const date = new Date(at)
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`
}
