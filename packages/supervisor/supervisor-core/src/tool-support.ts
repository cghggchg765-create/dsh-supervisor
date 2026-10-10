/**
 * Shared tool helpers and schema constants. The sibling tool components import
 * these so every settlement-carrying tool reports the same fields with the same
 * names, and the schema constants stay one definition.
 * @module @deepseek-ai/dsh-supervisor-core/tool-support
 */

import { TerminalSessionId, type TerminalSessionStatus, type TerminalWaitReason } from '@deepseek-ai/dsh-terminal'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { OutputClass } from './adapter.ts'
import { AGENT_KINDS } from './agent-kinds.ts'
import type { BreakerState } from './breaker.ts'
import type { WindowHit } from './guard.ts'
import type { SettlementReport, SupervisorRuntime } from './index.ts'
import type { L1RuleHit, StateMark } from './types.ts'

/** Marks and hits shared by every terminal-result schema. */
export const MARK_ENUM = ['prompt-idle', 'waiting-input', 'working', 'silence', 'exit-ok', 'exit-bad', 'heartbeat-stale'] as const

/** Wait reasons the terminal service can report. */
export const WAIT_REASON_ENUM = ['stdin_read', 'inferred_idle', 'timeout', 'session_exit'] as const

/** Signals a caller may send to a supervised terminal. */
export const SIGNAL_ENUM = ['SIGINT', 'SIGTERM', 'SIGKILL', 'SIGTSTP', 'SIGHUP'] as const

/** Classes the output classifier can report. */
export const OUTPUT_CLASS_ENUM = ['waiting-input', 'working', 'error', 'completed', 'unknown'] as const

/** Progress-breaker positions. */
export const BREAKER_STATE_ENUM = ['closed', 'half-open', 'open'] as const

/** L1 severities a configured rule may report. */
export const SEVERITY_ENUM = ['low', 'medium', 'high', 'critical'] as const

/** Rule-hit schema shared by the terminal tools. */
export const RULE_HIT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ruleId: { type: 'string', required: true, description: 'L1 rule that matched.' },
    severity: { type: 'string', required: true, enum: SEVERITY_ENUM, description: 'Configured severity.' },
    evidence: { type: 'string', required: true, description: 'Output fragment that matched.' },
    convergence: { type: 'string', enum: ['identical', 'changing'], description: 'For `empty-loop`: whether the repeated output was byte-identical or still changing.' },
  },
} as const

/** Wait reason plus the marks and hits derived from one settlement. */
export const SETTLEMENT_OUTPUT = {
  output: { type: 'string', required: true, description: 'Bounded terminal output captured at settlement.' },
  waitReason: { type: 'string', required: true, enum: WAIT_REASON_ENUM, description: 'Why the wait returned.' },
  stateMarks: { type: 'array', required: true, items: { type: 'string', enum: MARK_ENUM }, description: 'Deterministic marks; judge them yourself.' },
  outputClass: { type: 'string', required: true, enum: OUTPUT_CLASS_ENUM, description: 'What the output appears to be doing, per the hosted agent\'s characteristics.' },
  l1Hits: { type: 'array', required: true, items: RULE_HIT_SCHEMA, description: 'Rule matches in this settlement.' },
  breaker: { type: 'string', required: true, enum: BREAKER_STATE_ENUM, description: 'Progress breaker: closed while output keeps changing, half-open at the stall limit, open when the stall persisted.' },
  breakerNoProgress: { type: 'integer', required: true, description: 'Identical settlements observed since the output last changed.' },
  spillPath: { type: 'string', description: 'Append-only output log for this terminal.' },
  spillCapped: { type: 'boolean', required: true, description: 'True when the log reached its byte cap and stopped recording.' },
  sessionStatus: { type: 'string', required: true, description: 'running, or exited with a code.' },
} as const

/**
 * The exact agent that owns a terminal call, or a loud failure.
 * @param exec - tool execution context carrying the owning agent.
 * @returns the owning agent.
 * @throws Error when the call carries no owning agent.
 */
export function requireAgent(exec: ToolRunContext): Agent {
  if (!exec.agent) throw new Error('supervisor tools require an owning agent session')
  return exec.agent
}

/**
 * Render one settlement as a short text block for the model.
 * @param waitReason - why the wait returned.
 * @param output - bounded terminal output captured at settlement.
 * @param marks - deterministic marks derived from the settlement.
 * @returns the wait reason, marks, and output tail as one text block.
 */
export function settlementText(waitReason: string, output: string, marks: readonly string[]): string {
  const markText = marks.length > 0 ? ` [${marks.join(', ')}]` : ''
  const tail = output.length <= 4000 ? output : `…${output.slice(-4000)}`
  return `${waitReason}${markText}\n${tail}`
}

/** Narrow an L1 hit to a window hit, which alone carries a convergence hint. */
function isWindowHit(hit: L1RuleHit): hit is WindowHit {
  return 'convergence' in hit
}

/** One L1 hit as the tool result carries it. */
export interface RuleHitResult {
  /** Built-in rule id that matched. */
  ruleId: string
  /** Configured severity of that hit. */
  severity: L1RuleHit['severity']
  /** Verbatim output fragment that triggered the match. */
  evidence: string
  /** For `empty-loop`: whether the repeated output was byte-identical or still changing. */
  convergence?: 'identical' | 'changing'
}

/**
 * Project every L1 hit of one observation into the tool-result schema. Window
 * rules keep their convergence hint: an `empty-loop` whose output is still
 * changing may be converging, which is what the supervising model must judge.
 * @param report - detection output of one settlement or read.
 * @returns the hits in rule order, ready for the tool result.
 */
export function ruleHits(report: { hits: readonly L1RuleHit[] }): RuleHitResult[] {
  return report.hits.map((hit): RuleHitResult => {
    const result = { ruleId: hit.ruleId, severity: hit.severity, evidence: hit.evidence }
    if (!isWindowHit(hit) || hit.convergence === undefined) return result
    return { ...result, convergence: hit.convergence }
  })
}

/**
 * Describe one session status for a tool result.
 * @param status - top-level session status to describe.
 * @returns `running`, or the exit code, signal, or `unknown` the session ended on.
 */
export function describeStatus(status: TerminalSessionStatus): string {
  return status.kind === 'running' ? 'running' : `exited(${status.exitCode ?? status.signal ?? 'unknown'})`
}

/**
 * The agent and terminal one tool call names, declaring the hosted CLI when the
 * caller supplied one.
 * @param runtime - plugin runtime holding the supervised sessions.
 * @param exec - tool execution context carrying the owning agent.
 * @param args - the call's terminal id and optional agent declaration.
 * @returns the owning agent and the terminal session id.
 */
export function declaredTerminal(
  runtime: SupervisorRuntime,
  exec: ToolRunContext,
  args: { sessionId: string; agentKind?: (typeof AGENT_KINDS)[number] },
): { agent: Agent; sessionId: ReturnType<typeof TerminalSessionId> } {
  const agent = requireAgent(exec)
  const sessionId = TerminalSessionId(args.sessionId)
  if (args.agentKind !== undefined) runtime.declareAgent(agent, sessionId, args.agentKind, { kind: 'running' })
  return { agent, sessionId }
}

/**
 * Project one settlement into the tool-result fields every settlement-carrying
 * tool shares.
 * @param report - detection output of the settlement.
 * @param settled - what the terminal returned.
 * @returns the shared result fields, ready to spread into a tool result.
 */
export function settlementResult(
  report: SettlementReport,
  settled: { viewport: string; waitReason: TerminalWaitReason; sessionStatus: TerminalSessionStatus },
): {
  output: string
  waitReason: TerminalWaitReason
  stateMarks: StateMark[]
  outputClass: OutputClass
  l1Hits: RuleHitResult[]
  breaker: BreakerState
  breakerNoProgress: number
  spillPath?: string
  spillCapped: boolean
  sessionStatus: string
} {
  return {
    output: settled.viewport,
    waitReason: settled.waitReason,
    stateMarks: report.marks,
    outputClass: report.outputClass,
    l1Hits: ruleHits(report),
    breaker: report.breaker.state,
    breakerNoProgress: report.breaker.consecutiveNoProgress,
    ...report.spillPath === undefined ? {} : { spillPath: report.spillPath },
    spillCapped: report.spillCapped,
    sessionStatus: describeStatus(settled.sessionStatus),
  }
}
