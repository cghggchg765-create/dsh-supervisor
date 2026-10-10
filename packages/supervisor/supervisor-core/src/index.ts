/**
 * One supervised-terminal control plane core: it launches and drives external
 * CLI agents through terminals, derives deterministic marks and L1 rule hits
 * from their output, and keeps heartbeats, output logs, and task plans durable.
 * The plugin owns no intelligence — the supervising model decides what any of
 * it means.
 * @module @deepseek-ai/dsh-supervisor-core
 */

import { join } from 'node:path'
import { Service, type Context, type Logger } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { TerminalSessionId, TerminalSessionStatus, TerminalWaitReason } from '@deepseek-ai/dsh-terminal'
import z from '@deepseek-ai/schemastery'
import { characteristicsFor, classifyOutput } from './adapter.ts'
import { ProgressBreaker } from './breaker.ts'
import { SessionWindows, deriveMarks, isFailedObservation, normalizeForWindow, scanText } from './guard.ts'
import { HeartbeatStore } from './heartbeat.ts'
import { RESUME_BUFFER_MS, isUsageLimit, parseLimitReset, shouldResume } from './limit.ts'
import { PlanStore } from './plan.ts'
import {
  resolveConfig,
  type InspectionReport,
  type ResolvedConfig,
  type SettlementReport,
  type SupervisedSession,
  type SupervisorConfig,
} from './runtime.ts'
import { SpillLog } from './spill.ts'
import { registerTools } from './tools.ts'
import type { AgentKind } from './types.ts'

/**
 * The supervised-terminal control plane: the registry of driven terminals, the
 * one detection pipeline every terminal tool funnels its settlement through,
 * the durable heartbeat, output-log, and plan stores, and the watchdog that
 * wakes an idle agent when a terminal goes quiet.
 */
export class SupervisorRuntime extends Service {
  /** Services the control plane registers tools on and drives terminals through. */
  static inject = ['tools', 'terminals']

  /** Plugin configuration schema. */
  static Config: z<SupervisorConfig> = z.object({
    stateDir: z.string().default('.supervisor'),
    workspaceDir: z.string().default(''),
    worktreeBase: z.string().default('.worktrees'),
    agents: z.dict(z.object({
      startCommand: z.string().required(),
      resumeCommand: z.string(),
      modelSwitchCommand: z.string(),
    })).default({}),
    defaultProfile: z.string().default('headless'),
    shellQuoting: z.union([
      z.const('posix'),
      z.const('powershell'),
      z.const('none'),
    ]).default(process.platform === 'win32' ? 'powershell' : 'posix'),
    rules: z.array(z.object({
      id: z.string().required(),
      enabled: z.boolean(),
      severity: z.union([z.const('low'), z.const('medium'), z.const('high'), z.const('critical')]),
      keywords: z.array(z.string()),
    })).default([]),
    detection: z.object({
      errorStreakThreshold: z.number().step(1).min(1).default(3),
      repeatThreshold: z.number().step(1).min(1).default(3),
      repeatWindowMin: z.number().step(1).min(1).default(5),
      maxRestarts: z.number().step(1).min(1).default(3),
      crashWindowMin: z.number().step(1).min(1).default(10),
      contextBloatBytes: z.number().step(1).min(1).default(50 * 1024),
      silenceThresholdSec: z.number().step(1).min(1).default(30),
    }).default({}),
    breaker: z.object({
      noProgressLimit: z.number().step(1).min(1).default(2),
      openLimit: z.number().step(1).min(1).default(3),
      cooldownSec: z.number().step(1).min(1).default(300),
    }).default({}),
    limitResumeEnabled: z.boolean().default(true),
    spillEnabled: z.boolean().default(true),
    spillMaxBytes: z.number().step(1).min(1).default(5 * 1024 * 1024 * 1024),
    runTimeoutSec: z.number().step(1).min(1).default(600),
    runPollIntervalMs: z.number().step(1).min(1).default(500),
    heartbeatTimeoutSec: z.number().step(1).min(1).default(300),
    watchdogEnabled: z.boolean().default(true),
    watchdogIntervalSec: z.number().step(1).min(1).default(60),
    watchdogCooldownSec: z.number().step(1).min(1).default(300),
  })

  /** Resolved configuration. */
  readonly config: ResolvedConfig

  /** Terminals this plugin has driven, keyed by terminal session id. */
  readonly sessions: Map<string, SupervisedSession> = new Map()

  /** Heartbeat records. */
  readonly heartbeats: HeartbeatStore

  /** Append-only output logs. */
  readonly spill: SpillLog

  /** Task plans. */
  readonly plans: PlanStore

  /**
   * @param ctx - the context the service registers itself in.
   * @param config - validated plugin configuration.
   */
  constructor(ctx: Context, config: SupervisorConfig = {}) {
    super(ctx, 'supervisor')
    this.config = resolveConfig(config)
    this.heartbeats = new HeartbeatStore(join(this.config.stateDir, 'heartbeat'), this.config.heartbeatTimeoutSec)
    this.spill = new SpillLog(join(this.config.stateDir, 'spill'), this.config.spillEnabled, this.config.spillMaxBytes)
    this.plans = new PlanStore(join(this.config.stateDir, 'plans'))
    registerTools(this.ctx, this)
    if (this.config.watchdogEnabled) {
      const logger = this.ctx.logger('supervisor')
      this.ctx.effect(() => {
        const timer = setInterval(() => { void sweepStaleTerminals(this, logger) }, this.config.watchdogIntervalSec * 1000)
        return () => { clearInterval(timer) }
      }, 'supervisor heartbeat watchdog')
    }
  }

  /**
   * Drop one terminal from the registry, e.g. after it was closed.
   * @param sessionId - terminal session id to forget.
   */
  forget(sessionId: string): void {
    this.sessions.delete(sessionId)
  }

  /**
   * Run one settlement through the detection pipeline and record it.
   * @param owner - agent driving the terminal.
   * @param sessionId - terminal session id.
   * @param text - settlement output.
   * @param waitReason - wait reason reported by the terminal operation.
   * @param status - top-level session status at settlement.
   * @param now - epoch milliseconds of the observation.
   * @returns marks, rule hits, and spill facts for the tool result.
   */
  async observe(
    owner: Agent,
    sessionId: TerminalSessionId,
    text: string,
    waitReason: TerminalWaitReason,
    status: TerminalSessionStatus,
    now: number,
  ): Promise<SettlementReport> {
    const session = this.track(owner, sessionId, status)
    session.lastWaitReason = waitReason
    session.lastStatus = status
    const heartbeat = await this.heartbeats.touch(sessionId, waitReason, now)
    session.lastOutputAt = heartbeat.lastOutputAt
    const heartbeatStale = this.heartbeats.isStale(heartbeat, now)
    const exitCode = status.kind === 'exited' ? status.exitCode : undefined
    const spill = await this.spill.append(sessionId, session.taskId, text)
    if (spill.written) session.spillPath = spill.path
    const stateless = scanText(text, this.config.rules, now, this.config.thresholds)
    const normalized = normalizeForWindow(text)
    const windowHits = session.windows.observe(
      {
        at: now,
        text: normalized,
        failed: isFailedObservation(text, exitCode),
        ...exitCode === undefined ? {} : { exitCode },
      },
      this.config.thresholds,
      this.config.rules,
    )
    const classification = classifyOutput(text, characteristicsFor(session.agentKind).characteristics)
    const limit = this.config.limitResumeEnabled && isUsageLimit(text) ? parseLimitReset(text, now) : undefined
    if (limit !== undefined) session.limitResumeAt = limit.resumeAt + RESUME_BUFFER_MS
    const progress = session.previousObservation === undefined || session.previousObservation !== normalized
    session.previousObservation = normalized
    session.breaker.observe(progress, now)
    return {
      marks: deriveMarks({ waitReason, sessionStatus: status, heartbeatStale, classification }),
      breaker: session.breaker.report(now),
      outputClass: classification.kind,
      hits: [...stateless, ...windowHits],
      windowHits,
      heartbeatStale,
      ...session.spillPath === undefined ? {} : { spillPath: session.spillPath },
      spillCapped: spill.capped,
      ...limit === undefined || session.limitResumeAt === undefined ? {} : { limitResumeAt: session.limitResumeAt },
    }
  }

  /**
   * Scan retained scrollback without recording a settlement. A read observes
   * text the supervisor already has; it neither appends to the output log nor
   * advances the heartbeat, because doing either would let a poll of a stuck
   * terminal pass for progress.
   * @param owner - agent driving the terminal.
   * @param sessionId - terminal session id.
   * @param text - retained scrollback that was read.
   * @param status - top-level session status at the read.
   * @param now - epoch milliseconds of the read.
   * @returns marks and rule hits for the inspected text.
   */
  async inspect(
    owner: Agent,
    sessionId: TerminalSessionId,
    text: string,
    status: TerminalSessionStatus,
    now: number,
  ): Promise<InspectionReport> {
    const session = this.track(owner, sessionId, status)
    session.lastStatus = status
    const heartbeat = await this.heartbeats.read(sessionId)
    const heartbeatStale = heartbeat !== undefined && this.heartbeats.isStale(heartbeat, now)
    const classification = classifyOutput(text, characteristicsFor(session.agentKind).characteristics)
    return {
      marks: deriveMarks({ waitReason: undefined, sessionStatus: status, heartbeatStale, classification }),
      outputClass: classification.kind,
      hits: scanText(text, this.config.rules, now, this.config.thresholds),
      heartbeatStale,
      ...session.spillPath === undefined ? {} : { spillPath: session.spillPath },
    }
  }

  /**
   * Record which CLI runs in a terminal, so its output is classified with that
   * agent's characteristics from the next observation on. Declaring it is how a
   * terminal the supervisor did not launch becomes classifiable.
   * @param owner - agent driving the terminal.
   * @param sessionId - terminal session id.
   * @param kind - hosted agent kind.
   * @param status - status observed at the declaration.
   */
  declareAgent(owner: Agent, sessionId: TerminalSessionId, kind: AgentKind, status: TerminalSessionStatus): void {
    this.track(owner, sessionId, status).agentKind = kind
  }

  /**
   * Register or fetch the registry entry for one terminal.
   * @param owner - agent driving the terminal.
   * @param sessionId - terminal session id.
   * @param status - status observed most recently, used to seed a new entry.
   * @returns the registry entry, created on first use.
   */
  track(owner: Agent, sessionId: TerminalSessionId, status: TerminalSessionStatus): SupervisedSession {
    const existing = this.sessions.get(sessionId)
    if (existing) {
      existing.owner = owner
      return existing
    }
    const created: SupervisedSession = {
      sessionId,
      owner,
      lastWaitReason: 'inferred_idle',
      lastOutputAt: Date.now(),
      lastStatus: status,
      windows: new SessionWindows(),
      breaker: new ProgressBreaker(this.config.breaker),
    }
    this.sessions.set(sessionId, created)
    return created
  }

  /**
   * Check one terminal's heartbeat and alert the caller when it went stale.
   * @param sessionId - terminal session id.
   * @param onStale - called with the registry entry when the heartbeat is stale and the cooldown elapsed.
   * @param now - epoch milliseconds of the watchdog pass.
   */
  async checkStaleness(
    sessionId: string,
    onStale: (session: SupervisedSession) => void,
    now: number,
  ): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) return
    const heartbeat = await this.heartbeats.read(sessionId)
    if (!heartbeat) return
    const stale = this.heartbeats.isStale(heartbeat, now)
    await this.heartbeats.recordCheck(heartbeat, stale)
    if (!stale) return
    const cooldownMs = this.config.watchdogCooldownSec * 1000
    if (session.lastAlertAt !== undefined && now - session.lastAlertAt < cooldownMs) return
    session.lastAlertAt = now
    onStale(session)
  }
}

/**
 * Wake the supervising agent when a usage limit it was waiting out has reset.
 * The scheduled instant is the reset time plus the configured buffer, so the
 * agent resumes after the provider has actually started serving again.
 * @param runtime - plugin runtime holding the supervised sessions.
 * @param sessionId - terminal to check.
 * @param now - epoch milliseconds of the sweep.
 * @param logger - plugin logger for failures that must not stop the sweep.
 */
function resumePausedLimit(runtime: SupervisorRuntime, sessionId: string, now: number, logger: Logger): void {
  const session = runtime.sessions.get(sessionId)
  if (session?.limitResumeAt === undefined || !shouldResume(session.limitResumeAt, now)) return
  try {
    session.owner.steer(createUserMessage({
      content: [{
        type: 'text',
        text: `[supervisor] terminal ${sessionId} hit a usage limit that should have reset by now. `
          + 'Send a follow-up instruction to resume the task, or read the terminal first if the CLI left a dialog open.',
      }],
      source: { kind: 'user' },
    }))
    // Cleared only after the steer landed: a schedule lost to a rejected steer
    // would leave the run parked forever, while keeping it just retries on the
    // next sweep.
    session.limitResumeAt = undefined
  } catch (error) {
    logger.warn(`watchdog could not steer ${session.owner.id} about the reset limit: ${String(error)}`)
  }
}

/**
 * Wake the supervising agent for every terminal whose heartbeat went stale.
 * The watchdog is the only path that reaches the model without a tool call:
 * without it, a terminal that stops producing output while the agent is idle
 * stays unnoticed until something else wakes the agent.
 * @param runtime - plugin runtime holding the supervised sessions.
 * @param logger - plugin logger for failures that must not stop the sweep.
 */
async function sweepStaleTerminals(runtime: SupervisorRuntime, logger: Logger): Promise<void> {
  const now = Date.now()
  for (const sessionId of [...runtime.sessions.keys()]) {
    resumePausedLimit(runtime, sessionId, now, logger)
    await runtime.checkStaleness(sessionId, (session) => {
      const ageSec = Math.round((now - session.lastOutputAt) / 1000)
      const breaker = session.breaker.report(now)
      const breakerNotice = breaker.state === 'open'
        ? ` Its progress breaker is OPEN after ${breaker.consecutiveNoProgress} identical settlements `
          + `(open for ${breaker.openForSec}s)`
          + ': the terminal is repeating itself, so consider a different instruction, a fresh terminal, or a human decision.'
        : ''
      try {
        session.owner.steer(createUserMessage({
          content: [{
            type: 'text',
            text: `[supervisor] terminal ${sessionId} produced no output for ${ageSec}s `
              + `(timeout ${runtime.config.heartbeatTimeoutSec}s, last wait reason "${session.lastWaitReason}"`
              + `${session.taskId === undefined ? '' : `, task ${session.taskId}`}). `
              + 'Read it with supervisor_terminal_read and decide whether to answer a prompt, interrupt it, '
              + `or take a checkpoint.${breakerNotice}`,
          }],
          // The notice enters the conversation on the operator's behalf, and the
          // payload names its producer; a dedicated source kind would be a
          // breaking session-format change just to record the source.
          source: { kind: 'user' },
        }))
      } catch (error) {
        // A disposed agent, or one already driving, cannot accept a steer; the
        // next sweep retries once it is idle again, so this pass only reports.
        logger.warn(`watchdog could not steer ${session.owner.id}: ${String(error)}`)
      }
    }, now)
  }
}

export default SupervisorRuntime

export {
  resolveConfig,
  quote,
  renderCommand,
  DEFAULT_AGENT_TEMPLATES,
} from './runtime.ts'
export type {
  SupervisorConfig,
  ResolvedConfig,
  AgentTemplate,
  ShellQuoting,
  SettlementReport,
  InspectionReport,
  SupervisedSession,
} from './runtime.ts'
export { DEFAULT_THRESHOLDS } from './guard.ts'
export { sanitize } from './heartbeat.ts'
export { AGENT_KINDS } from './agent-kinds.ts'
export type {
  AgentKind,
  StateMark,
  L1Severity,
  L1RuleHit,
  VerificationMethod,
  AcceptanceCriterion,
  EstimatedEffort,
  SubTaskStatus,
  SubTask,
  IntegrationStrategy,
  TaskPlan,
  GitRef,
  TerminalStateRecord,
  SupervisorCheckpoint,
  Heartbeat,
} from './types.ts'
export {
  requireAgent,
  settlementText,
  ruleHits,
  describeStatus,
  declaredTerminal,
  settlementResult,
  MARK_ENUM,
  WAIT_REASON_ENUM,
  SIGNAL_ENUM,
  OUTPUT_CLASS_ENUM,
  BREAKER_STATE_ENUM,
  SEVERITY_ENUM,
  RULE_HIT_SCHEMA,
  SETTLEMENT_OUTPUT,
} from './tool-support.ts'
export type { RuleHitResult } from './tool-support.ts'
export {
  RESUME_BUFFER_MS,
  isProviderLimit,
  isUsageLimit,
  parseLimitReset,
  parseProviderReset,
  shouldResume,
} from './limit.ts'
export type { LimitReset, ProviderReset } from './limit.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    supervisor: SupervisorRuntime
  }
}
