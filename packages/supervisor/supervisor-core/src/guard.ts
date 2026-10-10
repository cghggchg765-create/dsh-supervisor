/**
 * L1 detection: deterministic regex rules, sliding-window rules, and state
 * marks. Nothing here decides whether the hosted agent is abnormal — it only
 * produces evidence and marks for the supervising model to judge.
 *
 * Every matcher is a literal in this module. Configuration may disable a rule,
 * change its severity, or supply literal keywords, but never supplies a regular
 * expression: an attacker-controlled or careless pattern would otherwise reach
 * every scan with catastrophic-backtracking cost.
 *
 * Pattern rules are synchronous scans of one terminal settlement. Window rules
 * keep per-session history in memory only: like the platform's own
 * repeat-tool-reminder, the window is not persisted, so a restarted harness
 * re-observes rather than resuming stale counts.
 * @module @deepseek-ai/dsh-supervisor-core/guard
 */

import type { OutputClassification } from './adapter.ts'
import type { L1RuleHit, L1Severity, StateMark } from './types.ts'

/** Rule mechanism that produced a hit. */
export type RuleKind =
  /** Stateless regex over the scanned text. */
  | 'pattern'
  /** Case-insensitive literal keywords over the scanned text. */
  | 'keywords'
  /** The same normalized output keeps reappearing inside the window. */
  | 'repeat-output'
  /** Consecutive failed observations inside the window. */
  | 'error-streak'
  /** The managed process keeps exiting non-zero inside the window. */
  | 'crash-loop'
  /** One settlement exceeded the configured output size. */
  | 'output-size'

/** One built-in or configured L1 rule. */
export interface RuleDefinition {
  /** Stable id, also the key used by configuration overrides. */
  id: string
  /** Severity reported for every hit of this rule. */
  severity: L1Severity
  /** Mechanism that produces hits. */
  kind: RuleKind
  /** Literal matcher for {@link RuleKind} `pattern`. */
  pattern?: RegExp
  /** Literal matcher for {@link RuleKind} `keywords`. */
  keywords?: readonly string[]
}
/** Tunable thresholds for the window and size rules. */
export interface DetectionThresholds {
  /** Consecutive failed observations that raise `error-streak`. */
  errorStreakThreshold: number
  /** Repeated identical observations inside the window that raise `empty-loop`. */
  repeatThreshold: number
  /** Window length in minutes for `empty-loop` and `error-streak`. */
  repeatWindowMin: number
  /** Non-zero exits inside the crash window that raise `crash-loop`. */
  maxRestarts: number
  /** Crash window length in minutes. */
  crashWindowMin: number
  /** Bytes in one settlement that raise `context-bloat`. */
  contextBloatBytes: number
  /** Seconds without output after which a settlement is marked `silence`. */
  silenceThresholdSec: number
}

/** Default thresholds, matching the documented P0 detection contract. */
export const DEFAULT_THRESHOLDS: DetectionThresholds = {
  errorStreakThreshold: 3,
  repeatThreshold: 3,
  repeatWindowMin: 5,
  maxRestarts: 3,
  crashWindowMin: 10,
  contextBloatBytes: 50 * 1024,
  silenceThresholdSec: 30,
}

/** Maximum characters of matched text carried into {@link L1RuleHit.evidence}. */
const EVIDENCE_MAX_CHARS = 200

/** Observations kept per session before the oldest is dropped. */
const MAX_WINDOW_ENTRIES = 64

/** Id of the keyword-driven rule, the only rule configuration can extend. */
const DRIFT_RULE_ID = 'goal-drift-signal'

/**
 * Rules other than `goal-drift-signal`, which is built from configured keywords.
 * Regexes that match a specific agent CLI's terminal output carry the
 * observation that makes them reliable; changing that observation without
 * re-verifying the pattern reintroduces the false positives it prevents.
 */
export const BUILT_IN_RULES: readonly RuleDefinition[] = [
  {
    id: 'api-disconnect',
    severity: 'high',
    kind: 'pattern',
    // Transport errno names and HTTP status codes carry word boundaries; the
    // prose forms are literal keywords so they cannot backtrack.
    pattern: /\bE(?:CONNRESET|CONNREFUSED|TIMEDOUT|PIPE|AI_AGAIN)\b|\b5(?:02|03|04|29)\b/i,
    keywords: [
      'socket hang up',
      'stream error',
      'stream closed',
      'connection refused',
      'connection reset',
      'connection error',
      'overloaded',
      'service unavailable',
      'bad gateway',
      'gateway timeout',
      'internal server error',
    ],
  },
  {
    id: 'rate-limit',
    severity: 'medium',
    kind: 'pattern',
    pattern: /\b429\b|rate[ _-]?limit|too many requests/i,
    keywords: [
      'usage limit reached',
      'limit reached',
      'out of extra usage',
      'quota exceeded',
    ],
  },
  {
    id: 'permission-prompt',
    severity: 'high',
    kind: 'pattern',
    // Confirmation prompts and numbered option menus of the known agent CLIs.
    // The menu branch requires a selection cursor, so ordinary numbered lists in
    // agent output do not match.
    pattern: /\(y\/n\)|\bAllow\b[^\n]*\?|Do you want to|Press Enter|[❯›>»]\s*\d+[.)]\s/i,
  },
  {
    id: 'model-switch-fail',
    severity: 'medium',
    kind: 'pattern',
    pattern: /invalid model|unknown model|model not (?:found|available)/i,
  },
  {
    id: DRIFT_RULE_ID,
    severity: 'medium',
    kind: 'keywords',
    keywords: [],
  },
  {
    id: 'empty-loop',
    severity: 'high',
    kind: 'repeat-output',
  },
  {
    id: 'error-streak',
    severity: 'high',
    kind: 'error-streak',
  },
  {
    id: 'crash-loop',
    severity: 'critical',
    kind: 'crash-loop',
  },
  {
    id: 'context-bloat',
    severity: 'medium',
    kind: 'output-size',
  },
]

/** Configuration override for one rule id. */
export interface RuleOverride {
  /** Rule to override; must name a built-in rule. */
  id: string
  /** Set false to disable the rule. */
  enabled?: boolean
  /** Replacement severity for every hit. */
  severity?: L1Severity
  /** Literal keywords for `goal-drift-signal`; replacing the list replaces the matcher. */
  keywords?: string[]
}

/** A rule after overrides were applied. */
export interface ResolvedRule extends RuleDefinition {
  /** Whether the rule may produce hits. */
  enabled: boolean
}

/**
 * Apply configuration overrides to the built-in rule table.
 * @param overrides - per-rule overrides from plugin configuration.
 * @returns every built-in rule with overrides applied, in declaration order.
 * @throws TypeError when an override names an unknown rule.
 */
export function resolveRules(overrides: readonly RuleOverride[]): ResolvedRule[] {
  const resolved = new Map<string, ResolvedRule>(
    BUILT_IN_RULES.map(rule => [rule.id, { ...rule, enabled: rule.kind !== 'keywords' }]),
  )
  for (const override of overrides) {
    const current = resolved.get(override.id)
    if (!current) {
      const known = [...resolved.keys()].join(', ')
      throw new TypeError(`unknown supervisor L1 rule "${override.id}"; known rules: ${known}`)
    }
    const keywords = (override.keywords ?? current.keywords ?? [])
      .map(keyword => keyword.trim())
      .filter(keyword => keyword !== '')
    resolved.set(override.id, {
      ...current,
      ...override.severity === undefined ? {} : { severity: override.severity },
      ...current.kind === 'keywords' ? { keywords } : {},
      enabled: override.enabled ?? (current.kind === 'keywords' ? keywords.length > 0 : current.enabled),
    })
  }
  return [...resolved.values()]
}

/**
 * Scan one settlement's text with the stateless rules.
 * @param text - output text of one settlement.
 * @param rules - resolved rule table.
 * @param now - epoch milliseconds of the scan.
 * @param thresholds - resolved detection thresholds; `contextBloatBytes` bounds `context-bloat`.
 * @param byteLength - output size in bytes; defaults to the UTF-8 length of `text`.
 * @returns one hit per matching rule, in rule order.
 */
export function scanText(
  text: string,
  rules: readonly ResolvedRule[],
  now: number,
  thresholds: DetectionThresholds,
  byteLength: number = Buffer.byteLength(text, 'utf8'),
): L1RuleHit[] {
  const hits: L1RuleHit[] = []
  for (const rule of rules) {
    if (!rule.enabled) continue
    if (rule.kind === 'output-size') {
      if (byteLength >= thresholds.contextBloatBytes) {
        hits.push({ ruleId: rule.id, severity: rule.severity, evidence: `${byteLength} bytes`, timestamp: now })
      }
      continue
    }
    if (rule.kind === 'keywords') {
      const matched = matchKeyword(text, rule.keywords ?? [])
      if (matched !== undefined) {
        hits.push({ ruleId: rule.id, severity: rule.severity, evidence: boundEvidence(matched), timestamp: now })
      }
      continue
    }
    if (rule.kind !== 'pattern' || !rule.pattern) continue
    const matched = text.match(rule.pattern)
    if (matched) {
      hits.push({ ruleId: rule.id, severity: rule.severity, evidence: boundEvidence(matched[0]), timestamp: now })
      continue
    }
    const keyword = matchKeyword(text, rule.keywords ?? [])
    if (keyword !== undefined) {
      hits.push({ ruleId: rule.id, severity: rule.severity, evidence: boundEvidence(keyword), timestamp: now })
    }
  }
  return hits
}

/** Return the first configured keyword found in the text, case-insensitively. */
function matchKeyword(text: string, keywords: readonly string[]): string | undefined {
  const haystack = text.toLowerCase()
  for (const keyword of keywords) {
    if (haystack.includes(keyword.toLowerCase())) return keyword
  }
  return undefined
}

/** Trim matched text to the evidence bound, marking the elision. */
function boundEvidence(matched: string): string {
  const collapsed = matched.replaceAll(/\s+/g, ' ').trim()
  return collapsed.length <= EVIDENCE_MAX_CHARS ? collapsed : `${collapsed.slice(0, EVIDENCE_MAX_CHARS)}…`
}

/** One observed settlement fed into the window rules. */
export interface Observation {
  /** Epoch milliseconds when the settlement was observed. */
  at: number
  /** Normalized output text; whitespace-collapsed and bounded by the caller. */
  text: string
  /** Whether this settlement counted as a failure (error text or non-zero exit). */
  failed: boolean
  /** Exit code when the top-level session exited during this settlement. */
  exitCode?: number | null
}

/** A window rule hit plus the convergence hint that qualifies it. */
export interface WindowHit extends L1RuleHit {
  /** For `empty-loop`: whether the repeated observations were byte-identical. */
  convergence?: 'identical' | 'changing'
}

/**
 * Per-session sliding windows for the rules that need history. One instance
 * exists per supervised terminal and is dropped when the terminal is closed.
 */
export class SessionWindows {
  private readonly observations: Observation[] = []

  private readonly nonZeroExits: number[] = []

  /**
   * Record one observation and evaluate the window rules.
   * @param observation - the settlement to record.
   * @param thresholds - resolved detection thresholds.
   * @param rules - resolved rule table.
   * @returns hits produced by this observation, in rule order.
   */
  observe(
    observation: Observation,
    thresholds: DetectionThresholds,
    rules: readonly ResolvedRule[],
  ): WindowHit[] {
    this.observations.push(observation)
    while (this.observations.length > MAX_WINDOW_ENTRIES) this.observations.shift()
    if (observation.exitCode !== undefined && observation.exitCode !== null && observation.exitCode !== 0) {
      this.nonZeroExits.push(observation.at)
    }
    this.evictExpired(this.nonZeroExits, observation.at, thresholds.crashWindowMin)
    const hits: WindowHit[] = []
    for (const rule of rules) {
      if (!rule.enabled) continue
      if (rule.kind === 'repeat-output') {
        const hit = this.repeatHit(rule, observation.at, thresholds)
        if (hit) hits.push(hit)
      } else if (rule.kind === 'error-streak') {
        const hit = this.errorStreakHit(rule, thresholds, observation.at)
        if (hit) hits.push(hit)
      } else if (rule.kind === 'crash-loop') {
        const hit = this.crashLoopHit(rule, thresholds, observation.at)
        if (hit) hits.push(hit)
      }
    }
    return hits
  }

  /** Count trailing failures, clearing the streak on success. */
  private errorStreakHit(rule: ResolvedRule, thresholds: DetectionThresholds, at: number): WindowHit | undefined {
    const windowStart = at - thresholds.repeatWindowMin * 60_000
    const recent = this.observations.filter(entry => entry.at >= windowStart)
    let streak = 0
    for (let index = recent.length - 1; index >= 0; index -= 1) {
      const entry = recent[index]
      if (!entry || !entry.failed) break
      streak += 1
    }
    if (streak < thresholds.errorStreakThreshold) return undefined
    return {
      ruleId: rule.id,
      severity: rule.severity,
      evidence: `${streak} consecutive failed observations`,
      timestamp: at,
    }
  }

  /**
   * Count repeats of the newest normalized output. Identical repeats and
   * still-changing repeats are distinguished, because a still-changing loop may
   * be converging while a byte-identical one usually is not.
   */
  private repeatHit(
    rule: ResolvedRule,
    now: number,
    thresholds: DetectionThresholds,
  ): WindowHit | undefined {
    const newest = this.observations.at(-1)
    if (!newest || newest.text === '') return undefined
    const windowStart = now - thresholds.repeatWindowMin * 60_000
    const window = this.observations.filter(entry => entry.at >= windowStart)
    let repeats = 0
    let identical = true
    for (const entry of window) {
      if (entry.text === newest.text) {
        repeats += 1
        continue
      }
      if (entry.text.includes(newest.text) || newest.text.includes(entry.text)) identical = false
    }
    if (repeats < thresholds.repeatThreshold) return undefined
    return {
      ruleId: rule.id,
      severity: rule.severity,
      evidence: `${repeats} repeats of the same output (${identical ? 'identical' : 'still changing'})`,
      timestamp: now,
      convergence: identical ? 'identical' : 'changing',
    }
  }

  /** Count non-zero exits inside the crash window. */
  private crashLoopHit(rule: ResolvedRule, thresholds: DetectionThresholds, at: number): WindowHit | undefined {
    if (this.nonZeroExits.length < thresholds.maxRestarts) return undefined
    return {
      ruleId: rule.id,
      severity: rule.severity,
      evidence: `${this.nonZeroExits.length} non-zero exits in ${thresholds.crashWindowMin} minutes`,
      timestamp: at,
    }
  }

  /** Drop exit timestamps that fell out of the crash window. */
  private evictExpired(entries: number[], now: number, windowMin: number): void {
    const windowStart = now - windowMin * 60_000
    let oldest = entries[0]
    while (oldest !== undefined && oldest < windowStart) {
      entries.shift()
      oldest = entries[0]
    }
  }
}

/** Settlement facts the marks are derived from. */
export interface MarkInput {
  /**
   * Wait reason reported by the terminal operation, or undefined for an
   * observation that was not a settlement (a read of retained scrollback):
   * only a settlement can report that the terminal reached a prompt.
   */
  waitReason: 'stdin_read' | 'inferred_idle' | 'timeout' | 'session_exit' | undefined
  /** Top-level session status at settlement. */
  sessionStatus: { kind: 'running' } | { kind: 'exited'; exitCode: number | null; signal: NodeJS.Signals | null }
  /** Whether the heartbeat for this session exceeded its timeout. */
  heartbeatStale?: boolean
  /** Classification of the settlement output, when the adapter produced one. */
  classification?: OutputClassification
}

/**
 * Derive deterministic state marks from one observation.
 * @param input - observation facts.
 * @returns marks in a stable order, each present at most once.
 */
export function deriveMarks(input: MarkInput): StateMark[] {
  const marks = new Set<StateMark>()
  if (input.waitReason === 'stdin_read' || input.waitReason === 'inferred_idle') marks.add('prompt-idle')
  if (input.classification?.kind === 'waiting-input') marks.add('waiting-input')
  if (input.classification?.kind === 'working') marks.add('working')
  if (input.waitReason === 'timeout') marks.add('silence')
  if (input.sessionStatus.kind === 'exited') {
    marks.add(input.sessionStatus.exitCode === 0 ? 'exit-ok' : 'exit-bad')
  }
  if (input.heartbeatStale) marks.add('heartbeat-stale')
  return [...marks]
}

/**
 * Normalize output text for the repeat window: collapse whitespace, bound length.
 * @param text - settlement output to normalize.
 * @returns the collapsed text, keeping its tail when it exceeds the window bound.
 */
export function normalizeForWindow(text: string): string {
  const collapsed = text.replaceAll(/\s+/g, ' ').trim()
  return collapsed.length <= 400 ? collapsed : collapsed.slice(-400)
}

/**
 * Decide whether one settlement counts as a failure for `error-streak`.
 * @param text - settlement output.
 * @param exitCode - exit code when the session exited during this settlement.
 * @returns true when the output carries an error indication or the exit was non-zero.
 */
export function isFailedObservation(text: string, exitCode?: number | null): boolean {
  if (exitCode !== undefined && exitCode !== null && exitCode !== 0) return true
  return /^\s*(?:Error|ERROR|Traceback|error:)/m.test(text)
    || /\b(?:Traceback|panic|FAILED|fatal)\b/.test(text)
}
