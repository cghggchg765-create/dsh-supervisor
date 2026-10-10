/**
 * Usage-limit detection and resume scheduling for supervised CLIs. A hosted
 * agent that runs out of provider quota usually says when the quota returns;
 * this module reads that statement so the supervisor can schedule the retry
 * instead of polling the agent.
 * @module @deepseek-ai/dsh-supervisor-core/limit
 */

/** A usage-limit message's parsed resume point. */
export interface LimitReset {
  /** Epoch milliseconds when the limit resets. */
  resumeAt: number
  /** Verbatim phrase the time was parsed from, for evidence. */
  phrase: string
  /** Which message form produced the time. */
  source: 'reset-time' | 'epoch'
}

/**
 * Wait applied after the stated reset before the supervisor resumes the agent.
 * {@link parseLimitReset} reports the reset instant itself; the caller that
 * schedules the resume adds this buffer.
 */
export const RESUME_BUFFER_MS = 120_000

/** Characters after the limit phrase in which a reset statement is still read. */
const RESET_WINDOW_CHARS = 160

/** Furthest reset instant accepted; beyond it the stated time is not credible. */
const MAX_AHEAD_MS = 8 * 24 * 60 * 60 * 1000

/** A stated calendar date further in the past than this belongs to the next year. */
const ROLL_FORWARD_MS = 2 * 24 * 60 * 60 * 1000

/** Gate phrase present in every usage-limit message. */
const LIMIT_GATE = /limit|extra usage/i

/**
 * Wording that marks a usage limit, one alternative per known CLI message.
 * The alternation is ordered by specificity; the leftmost match in the text
 * selects the phrase the reset statement is read after.
 */
const LIMIT_PHRASE = new RegExp(
  [
    '\\blimit reached\\b',
    "you'?ve hit your [^\\n]{1,60}?limit",
    "you'?re out of extra usage",
    '\\bquota exceeded\\b',
    '\\btoo many requests\\b',
    '\\b429\\b',
  ].join('|'),
  'i',
)

/** Weekday abbreviations in `Date.getUTCDay()` order. */
const WEEKDAY_NAMES: readonly string[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

/** Month abbreviations in `Date.getUTCMonth()` order. */
const MONTH_NAMES: readonly string[] = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

/**
 * The reset statement: an optional weekday or calendar date, a wall clock, and
 * an optional IANA zone in parentheses. Capture groups are weekday, month, day,
 * hour, minute, meridiem, and zone.
 */
const RESET_CLAUSE = new RegExp(
  '\\bresets?\\b\\s*(?:at\\s*)?'
  + `(?:(${WEEKDAY_NAMES.join('|')})[a-z]*\\s+)?`
  + `(?:(${MONTH_NAMES.join('|')})[a-z]*\\s+(\\d{1,2})(?:st|nd|rd|th)?\\s*,?\\s*(?:at\\s*)?)?`
  + '(\\d{1,2})(?::(\\d{2}))?\\s*(am|pm)?'
  + '\\s*(?:\\(([^)]+)\\))?',
  'i',
)

/** Epoch-seconds clause used by agents that report their own reset instant. */
const EPOCH_CLAUSE = /\busage limit reached\s*\|\s*(\d+)/i

/**
 * Whether the text carries a usage-limit phrase at all.
 * @param text - terminal output to scan.
 * @returns true when a limit wording and the gate phrase both appear.
 */
export function isUsageLimit(text: string): boolean {
  return LIMIT_GATE.test(text) && LIMIT_PHRASE.test(text)
}

/**
 * Parse the resume point out of a usage-limit message.
 * @param text - terminal output to scan.
 * @param now - epoch milliseconds the scan runs at.
 * @param timeZone - IANA zone the message's wall clock is stated in; defaults to the host zone.
 * @returns the stated reset instant without {@link RESUME_BUFFER_MS}, or
 * undefined when the text names no credible resume point.
 */
export function parseLimitReset(text: string, now: number, timeZone?: string): LimitReset | undefined {
  const phrase = LIMIT_PHRASE.exec(text)
  if (phrase === null) return undefined
  const windowStart = phrase.index + phrase[0].length
  const clause = RESET_CLAUSE.exec(text.slice(windowStart, windowStart + RESET_WINDOW_CHARS))
  if (clause === null) return epochReset(text, now)
  const parsed = resetFromClause(clause, now, timeZone)
  if (parsed === undefined) return epochReset(text, now)
  return accept(parsed, now)
}

/**
 * Whether a scheduled resume is due.
 * @param resumeAt - reset instant, or undefined when none was parsed.
 * @param now - epoch milliseconds to compare against.
 * @returns true when `now` reached the instant.
 */
export function shouldResume(resumeAt: number | undefined, now: number): boolean {
  return resumeAt !== undefined && now >= resumeAt
}

/** Drop a reset instant too far ahead to be a credible reading of the message. */
function accept<T extends { resumeAt: number }>(reset: T, now: number): T | undefined {
  return reset.resumeAt - now > MAX_AHEAD_MS ? undefined : reset
}

/** Read the epoch-seconds clause, when the message carries one. */
function epochReset(text: string, now: number): LimitReset | undefined {
  const matched = EPOCH_CLAUSE.exec(text)
  if (matched === null) return undefined
  // The pattern requires the digits group, so the captured text is a number.
  return accept({ resumeAt: Number(matched[1]) * 1000, phrase: matched[0], source: 'epoch' }, now)
}

/** Read the reset statement into an instant in the zone it was stated in. */
function resetFromClause(clause: RegExpExecArray, now: number, configuredZone: string | undefined): LimitReset | undefined {
  const [, weekdayName, monthName, dayText, hourText, minuteText, meridiemName, zoneName] = clause
  const hour = toHour24(Number(hourText), meridiemName?.toLowerCase())
  if (hour === undefined) return undefined
  const minute = minuteText === undefined ? 0 : Number(minuteText)
  if (minute > 59) return undefined
  const zone = zoneOr(zoneName, zoneOr(configuredZone, hostTimeZone()))
  const phrase = clause[0].trim()
  if (weekdayName !== undefined) {
    return { resumeAt: weekdayResumeAt(weekdayName, hour, minute, now, zone), phrase, source: 'reset-time' }
  }
  if (monthName !== undefined) {
    return { resumeAt: dateResumeAt(monthName, Number(dayText), hour, minute, now, zone), phrase, source: 'reset-time' }
  }
  return { resumeAt: clockResumeAt(hour, minute, now, zone), phrase, source: 'reset-time' }
}

/** Next occurrence of a wall clock in the zone, tomorrow once it has passed. */
function clockResumeAt(hour: number, minute: number, now: number, zone: string): number {
  const today = zonedNow(now, zone)
  const candidate = wallClockEpoch(today.year, today.month, today.day, hour, minute, zone)
  return candidate <= now ? wallClockEpoch(today.year, today.month, today.day + 1, hour, minute, zone) : candidate
}

/** Next occurrence of a weekday, one to seven days ahead, at that wall clock. */
function weekdayResumeAt(name: string, hour: number, minute: number, now: number, zone: string): number {
  const today = zonedNow(now, zone)
  const target = WEEKDAY_NAMES.indexOf(name.toLowerCase().slice(0, 3))
  const current = new Date(Date.UTC(today.year, today.month - 1, today.day)).getUTCDay()
  const ahead = ((target - current + 7) % 7) || 7
  return wallClockEpoch(today.year, today.month, today.day + ahead, hour, minute, zone)
}

/** A calendar date's wall clock; a date over two days past rolls a year forward. */
function dateResumeAt(name: string, day: number, hour: number, minute: number, now: number, zone: string): number {
  const year = zonedNow(now, zone).year
  const month = MONTH_NAMES.indexOf(name.toLowerCase().slice(0, 3)) + 1
  const candidate = wallClockEpoch(year, month, day, hour, minute, zone)
  return now - candidate > ROLL_FORWARD_MS ? wallClockEpoch(year + 1, month, day, hour, minute, zone) : candidate
}

/** Epoch milliseconds of one wall clock in one zone. */
function wallClockEpoch(year: number, month: number, day: number, hour: number, minute: number, zone: string): number {
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute)
  return utcGuess - zoneOffsetMs(utcGuess, zone)
}

/** Calendar date `now` falls on in one zone. */
function zonedNow(now: number, zone: string): { year: number; month: number; day: number } {
  const formatter = new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: 'numeric', day: 'numeric' })
  let year = 0
  let month = 0
  let day = 0
  for (const part of formatter.formatToParts(new Date(now))) {
    if (part.type === 'year') year = Number(part.value)
    else if (part.type === 'month') month = Number(part.value)
    else if (part.type === 'day') day = Number(part.value)
  }
  return { year, month, day }
}

/** Offset of one zone at an instant, in milliseconds east of UTC. */
function zoneOffsetMs(epochMs: number, zone: string): number {
  const formatter = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' })
  let name = ''
  for (const part of formatter.formatToParts(new Date(epochMs))) {
    if (part.type === 'timeZoneName') name = part.value
  }
  // `longOffset` renders as `GMT+HH:MM` or `GMT-HH:MM`; a bare `GMT` has no
  // digits, and `Number('')` is zero, so the same arithmetic covers it.
  const east = name.startsWith('GMT-') ? -1 : 1
  return east * (Number(name.slice(4, 6)) * 60 + Number(name.slice(7, 9))) * 60_000
}

/** Convert the message's hour to 24-hour form, or reject an impossible time. */
function toHour24(hour: number, meridiem: string | undefined): number | undefined {
  if (meridiem === undefined) return hour <= 23 ? hour : undefined
  if (hour < 1 || hour > 12) return undefined
  const base = hour % 12
  return meridiem === 'pm' ? base + 12 : base
}

/** Formatter for one zone, or undefined when the runtime rejects the name. */
function formatterFor(zone: string): Intl.DateTimeFormat | undefined {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: zone })
  } catch {
    // An unrecognized IANA name cannot produce a formatter; the caller
    // substitutes a zone it already resolved.
    return undefined
  }
}

/** The host's zone, used when neither the message nor the caller states one. */
function hostTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone
}

/** The first of two zone names the runtime resolves, preferring the first. */
function zoneOr(name: string | undefined, fallback: string): string {
  if (name === undefined) return fallback
  return formatterFor(name) === undefined ? fallback : name
}

/** A provider-side limit message's parsed resume point. */
export interface ProviderReset {
  /** Epoch milliseconds when the provider says requests may resume. */
  resumeAt: number
  /** Verbatim phrase the instant was parsed from, for evidence. */
  phrase: string
  /** Which message form produced the instant. */
  source: 'retry-after' | 'relative' | 'timestamp'
}

/** Wording that marks a provider-side rate limit or quota refusal. */
const PROVIDER_LIMIT_PHRASE = /\b(?:rate[ _-]?limits?(?:ed|_error)?|too many requests|\b429\b|quota|overloaded)/i

/**
 * Whether the text carries a provider-side limit refusal.
 * @param text - provider failure message to scan.
 * @returns true when a rate-limit, quota, or overload wording appears.
 */
export function isProviderLimit(text: string): boolean {
  return PROVIDER_LIMIT_PHRASE.test(text)
}

/** Whether one character is a decimal digit. */
function isDigit(character: string | undefined): boolean {
  return character !== undefined && character >= '0' && character <= '9'
}

/**
 * Read a `retry-after` count stated as seconds.
 * @param text - provider failure message to scan.
 * @returns the stated seconds and the phrase they were read from, or undefined.
 */
function retryAfterSeconds(text: string): { seconds: number; phrase: string } | undefined {
  const lower = text.toLowerCase()
  const hyphenated = lower.indexOf('retry-after')
  const spaced = lower.indexOf('retry after')
  const at = hyphenated >= 0 ? hyphenated : spaced
  if (at < 0) return undefined
  let index = at + (hyphenated >= 0 ? 'retry-after'.length : 'retry after'.length)
  // Only separators may sit between the phrase and its count: a provider that
  // writes `retry after Wed, 15 Jan 2026 …` states a date, not a count, and the
  // date is read by {@link parseProviderReset}'s absolute-instant branch.
  while (index < text.length && !isDigit(text[index])) {
    const character = text[index]
    if (character !== ' ' && character !== ':' && character !== '=' && character !== '\t') return undefined
    index += 1
  }
  const start = index
  while (index < text.length && isDigit(text[index])) index += 1
  if (index === start) return undefined
  return { seconds: Number(text.slice(start, index)), phrase: text.slice(at, index) }
}

/**
 * Parse the resume point a provider failure states, in the forms a provider
 * actually uses: a `retry-after` count, a delay relative to now, or an absolute
 * instant. A message that only states a wall clock is read by
 * {@link parseLimitReset} instead.
 * @param text - provider failure message to scan.
 * @param now - epoch milliseconds the scan runs at.
 * @returns the stated resume instant, or undefined when the text states none
 * that is credible.
 */
export function parseProviderReset(text: string, now: number): ProviderReset | undefined {
  const retryAfter = retryAfterSeconds(text)
  if (retryAfter !== undefined) {
    return accept({ resumeAt: now + retryAfter.seconds * 1000, phrase: retryAfter.phrase, source: 'retry-after' }, now)
  }
  const relative = relativeDelayMs(text)
  if (relative !== undefined) {
    return accept({ resumeAt: now + relative.delayMs, phrase: relative.phrase, source: 'relative' }, now)
  }
  const instant = absoluteInstant(text)
  if (instant !== undefined) {
    return accept({ resumeAt: instant.resumeAt, phrase: instant.phrase, source: 'timestamp' }, now)
  }
  return undefined
}

/** Phrases a provider states before a delay measured from now. */
const RELATIVE_TRIGGERS: readonly string[] = ['try again', 'retry', 'available', 'come back', 'resets', 'reset']

/** Duration units, longest spelling first so a longer unit wins its prefix. */
const DURATION_UNITS: readonly (readonly [string, number])[] = [
  ['milliseconds', 1], ['millisecond', 1], ['ms', 1],
  ['seconds', 1000], ['second', 1000], ['secs', 1000], ['sec', 1000], ['s', 1000],
  ['minutes', 60_000], ['minute', 60_000], ['mins', 60_000], ['min', 60_000], ['m', 60_000],
  ['hours', 3_600_000], ['hour', 3_600_000], ['hrs', 3_600_000], ['hr', 3_600_000], ['h', 3_600_000],
  ['days', 86_400_000], ['day', 86_400_000], ['d', 86_400_000],
]

/**
 * Read a delay stated relative to now, such as `try again in 20 minutes`.
 * @param text - provider failure message to scan.
 * @returns the delay and the phrase it was read from, or undefined.
 */
function relativeDelayMs(text: string): { delayMs: number; phrase: string } | undefined {
  const lower = text.toLowerCase()
  for (const trigger of RELATIVE_TRIGGERS) {
    let from = lower.indexOf(trigger)
    while (from >= 0) {
      const inAt = lower.indexOf(' in ', from + trigger.length)
      if (inAt >= 0 && inAt - from <= 60) {
        const parsed = durationFrom(text, inAt + 4)
        if (parsed !== undefined) {
          return { delayMs: parsed.delayMs, phrase: text.slice(from, parsed.end).trim() }
        }
      }
      from = lower.indexOf(trigger, from + trigger.length)
    }
  }
  return undefined
}

/**
 * Sum up to three `<count> <unit>` terms starting at one position.
 * @param text - message being scanned.
 * @param start - index of the first count, with no leading space.
 * @returns the summed delay and the index just past the last unit.
 */
function durationFrom(text: string, start: number): { delayMs: number; end: number } | undefined {
  let index = start
  let total = 0
  let terms = 0
  while (terms < 3) {
    const before = index
    while (text[index] === ' ') index += 1
    const digitsAt = index
    while (isDigit(text[index])) index += 1
    if (index === digitsAt) {
      index = before
      break
    }
    const amount = Number(text.slice(digitsAt, index))
    while (text[index] === ' ') index += 1
    const unit = unitMs(text, index)
    if (unit === undefined) {
      index = before
      break
    }
    index += unit.length
    total += amount * unit.ms
    terms += 1
  }
  return terms === 0 ? undefined : { delayMs: total, end: index }
}

/** The duration unit spelled at one position, longest spelling first. */
function unitMs(text: string, at: number): { ms: number; length: number } | undefined {
  for (const [word, ms] of DURATION_UNITS) {
    if (text.startsWith(word, at)) return { ms, length: word.length }
  }
  return undefined
}

/** Characters that can appear inside an absolute instant. */
function isInstantChar(character: string | undefined): boolean {
  if (character === undefined) return false
  return isDigit(character) || ' -:.+TZ'.includes(character)
}

/**
 * Read an absolute instant the message states: an ISO-8601 timestamp, or the
 * HTTP-date form a provider echoes from a `Retry-After` header.
 * @param text - provider failure message to scan.
 * @returns the instant and the phrase it was read from, or undefined.
 */
function absoluteInstant(text: string): { resumeAt: number; phrase: string } | undefined {
  let index = 0
  while (index < text.length) {
    if (!isInstantChar(text[index])) {
      index += 1
      continue
    }
    const start = index
    while (isInstantChar(text[index])) index += 1
    const token = text.slice(start, index).trim()
    if (token.length >= 10 && isDigit(token[0]) && token.includes('-')) {
      const parsed = Date.parse(token)
      if (!Number.isNaN(parsed)) return { resumeAt: parsed, phrase: token }
    }
  }
  return httpDateInstant(text)
}

/**
 * Read the HTTP-date form, which spaces its parts so the token scan above
 * cannot hold it together. The weekday comma is required: it is what separates
 * the date from whatever prose precedes it, and a lenient parse of prose can
 * yield a plausible but wrong instant.
 * @param text - provider failure message to scan.
 * @returns the instant and the phrase it was read from, or undefined.
 */
function httpDateInstant(text: string): { resumeAt: number; phrase: string } | undefined {
  let at = text.indexOf(' GMT')
  while (at >= 0) {
    const lineStart = text.lastIndexOf('\n', at) + 1
    const comma = text.lastIndexOf(',', at)
    if (comma >= lineStart) {
      const token = text.slice(comma + 1, at + 4).trim()
      const parsed = Date.parse(token)
      if (!Number.isNaN(parsed)) return { resumeAt: parsed, phrase: token }
    }
    at = text.indexOf(' GMT', at + 1)
  }
  return undefined
}
