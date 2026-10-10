/**
 * Per-agent output characteristics. A terminal settlement carries whatever the
 * hosted CLI printed, and every CLI prints its own spinner, its own prompt, and
 * its own error banner. This module is the supervisor's adapter table: one
 * literal pattern set per agent kind, and one classifier that reads the tail of
 * a settlement and names what the CLI appears to be doing.
 *
 * The classifier is evidence, not judgement. A `working` class means the output
 * carried an activity marker, not that the agent is making progress; the
 * supervising model decides what that implies. Ambiguous samples classify as
 * `unknown` and are left for the model to read.
 *
 * Patterns are literals in this module for the same reason the L1 rules are:
 * configuration never supplies a regular expression.
 * @module @deepseek-ai/dsh-supervisor-core/adapter
 */

import type { AgentKind } from './types.ts'

/** Where one agent CLI's characteristics come from. */
export type CharacteristicsSource = 'built-in' | 'default'

/** Terminal output patterns of one CLI agent, grouped by the class they identify. */
export interface AgentCharacteristics {
  /** The CLI is blocked on a human answer: a confirmation prompt or a selection menu. */
  waiting: readonly RegExp[]
  /** The CLI is producing work now: a spinner, a progress line, an interrupt hint. */
  active: readonly RegExp[]
  /** The CLI reported a failure. */
  error: readonly RegExp[]
  /** The CLI returned to its idle prompt after finishing a task. */
  completion: readonly RegExp[]
}

/** What one settlement's output appears to be doing. */
export type OutputClass = 'waiting-input' | 'working' | 'error' | 'completed' | 'unknown'

/** One classification result. */
export interface OutputClassification {
  /** Class the output matched, in the adapter's priority order. */
  kind: OutputClass
  /** Verbatim fragment that matched, when one did. */
  evidence?: string
}

/** Lines of the output tail the classifier reads. */
const CLASSIFY_TAIL_LINES = 8

/** Bounded evidence length, matching the L1 rule hits. */
const EVIDENCE_MAX_CHARS = 200

/** Activity markers: a spinner, an elapsed-time line, or a named work verb. */
const ACTIVE: readonly RegExp[] = [
  /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/,
  /\besc to interrupt\b/i,
  /…\s*\((?:\d+h\s+)?(?:\d+m\s+)?\d+s\b/i,
  /\b(?:Reading|Writing|Editing|Running|Searching|Thinking)\b/,
]

/** Failure banners the supported CLIs print when they give up. */
const ERROR: readonly RegExp[] = [
  /^\s*Error:/m,
  /\bENOENT\b/,
  /\bEACCES\b/,
  /Connection refused/i,
  /command not found/i,
]

/**
 * Built-in characteristics per agent kind. The waiting patterns are the ones a
 * confirmation prompt or a selection menu actually prints; the active patterns
 * are deliberately specific, because a bare star glyph also appears on a
 * completed summary line and would otherwise read as "working".
 */
export const AGENT_CHARACTERISTICS: Record<AgentKind, AgentCharacteristics> = {
  'claude-code': {
    waiting: [/\(y\/n\)/i, /\bAllow\b[^\n]*\?/i, /❯\s*\d+[.)]\s/],
    active: ACTIVE,
    error: ERROR,
    completion: [/❯\s*$/m],
  },
  codex: {
    waiting: [/\(y\/n\)/i, /\bAllow\b[^\n]*\?/i, /›\s*\d+[.)]\s/],
    active: [/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/, /\b(?:Reading|Writing|Editing|Running|Thinking)\b/],
    error: ERROR,
    completion: [/›\s*$/m],
  },
  'kimi-code': {
    waiting: [/\(y\/n\)/i, /\bAllow\b[^\n]*\?/i],
    active: [/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/],
    error: [/^\s*Error:/m, /Connection refused/i, /command not found/i],
    completion: [],
  },
  'qwen-code': {
    waiting: [/\(y\/n\)/i, /\bAllow\b[^\n]*\?/i],
    active: [/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/],
    error: [/^\s*Error:/m, /Connection refused/i, /command not found/i],
    completion: [],
  },
  trae: {
    waiting: [/\(y\/n\)/i, /\bAllow\b[^\n]*\?/i],
    active: [/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/],
    error: [/^\s*Error:/m, /Connection refused/i, /command not found/i],
    completion: [],
  },
  dsh: {
    waiting: [/\(y\/n\)/i, /\bAllow\b[^\n]*\?/i, /❯\s*\d+[.)]\s/],
    active: [/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/],
    error: [/^\s*Error:/m, /Connection refused/i, /command not found/i],
    completion: [],
  },
}

/**
 * Classify one settlement's output with an agent's characteristics.
 *
 * The priority order is the adapter's decision rule: a live prompt or spinner
 * outranks an error string, because a working transcript quotes errors it is
 * already handling, and completion ranks last so a co-present failure wins.
 * @param text - settlement output.
 * @param characteristics - pattern set of the hosted agent.
 * @returns the first matching class, or `unknown` when nothing matched.
 */
export function classifyOutput(text: string, characteristics: AgentCharacteristics): OutputClassification {
  const tail = tailLines(text, CLASSIFY_TAIL_LINES)
  const waiting = firstMatch(tail, characteristics.waiting)
  if (waiting !== undefined) return { kind: 'waiting-input', evidence: waiting }
  const active = firstMatch(tail, characteristics.active)
  if (active !== undefined) return { kind: 'working', evidence: active }
  const error = firstMatch(tail, characteristics.error)
  if (error !== undefined) return { kind: 'error', evidence: error }
  const completion = firstMatch(tail, characteristics.completion)
  if (completion !== undefined) return { kind: 'completed', evidence: completion }
  return { kind: 'unknown' }
}

/**
 * Characteristics of one agent kind, falling back to the union of every built-in
 * set when the hosted CLI was never declared. The union keeps a confirmation
 * prompt detectable in a terminal the supervisor did not launch; it cannot
 * classify `working`, because activity markers are agent-specific enough that a
 * union of them would match almost any transcript.
 * @param kind - hosted agent kind, when the session declared one.
 * @returns the characteristics to classify that session's output with.
 */
export function characteristicsFor(kind: AgentKind | undefined): { characteristics: AgentCharacteristics; source: CharacteristicsSource } {
  if (kind !== undefined) return { characteristics: AGENT_CHARACTERISTICS[kind], source: 'built-in' }
  return {
    characteristics: {
      waiting: [...new Set(Object.values(AGENT_CHARACTERISTICS).flatMap(entry => entry.waiting))],
      active: [],
      error: [],
      completion: [],
    },
    source: 'default',
  }
}

/** Keep the last `count` lines of an output sample. */
function tailLines(text: string, count: number): string {
  const lines = text.split('\n')
  return lines.length <= count ? text : lines.slice(-count).join('\n')
}

/** The bounded text of the first pattern that matches, or undefined. */
function firstMatch(text: string, patterns: readonly RegExp[]): string | undefined {
  for (const pattern of patterns) {
    const matched = text.match(pattern)
    if (!matched) continue
    const collapsed = matched[0].replaceAll(/\s+/g, ' ').trim()
    return collapsed.length <= EVIDENCE_MAX_CHARS ? collapsed : `${collapsed.slice(0, EVIDENCE_MAX_CHARS)}…`
  }
  return undefined
}
