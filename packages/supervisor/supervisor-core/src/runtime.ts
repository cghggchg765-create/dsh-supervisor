/**
 * Resolved configuration and the settlement vocabulary every supervisor tool
 * shares: agent launch templates, the detection thresholds, the breaker policy,
 * and the reports the terminal tools return.
 * @module @deepseek-ai/dsh-supervisor-core/runtime
 */

import { isAbsolute, resolve } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { TerminalSessionId, TerminalSessionStatus, TerminalWaitReason } from '@deepseek-ai/dsh-terminal'
import type { OutputClass } from './adapter.ts'
import { DEFAULT_BREAKER_POLICY, ProgressBreaker, type BreakerPolicy, type BreakerReport } from './breaker.ts'
import {
  DEFAULT_THRESHOLDS,
  SessionWindows,
  resolveRules,
  type DetectionThresholds,
  type ResolvedRule,
  type RuleOverride,
  type WindowHit,
} from './guard.ts'
import type { AgentKind, L1RuleHit, StateMark } from './types.ts'

/** Launch, resume, and switch commands for one hosted agent CLI. */
export interface AgentTemplate {
  /** Launch command; `{model}`, `{prompt}`, and `{profile}` are substituted. */
  startCommand: string
  /** Native resume command, when the CLI has one. */
  resumeCommand?: string
  /** In-session model switch command; empty when the CLI cannot switch while running. */
  modelSwitchCommand?: string
}

/** Shell dialect used to quote substituted values. */
export type ShellQuoting = 'posix' | 'powershell' | 'none'

/** Plugin configuration as authored in cordis.yml. */
export interface SupervisorConfig {
  /** Directory holding plans, heartbeats, and spill logs. */
  stateDir?: string
  /** Working directory the state directory is resolved against. */
  workspaceDir?: string
  /** Directory worktrees are created under; a relative path resolves against `workspaceDir`. */
  worktreeBase?: string
  /** Per-agent launch templates, merged over the built-in defaults. */
  agents?: Partial<Record<AgentKind, AgentTemplate>>
  /** Profile substituted into `{profile}`; the dsh template uses it. */
  defaultProfile?: string
  /** Shell dialect used to quote substituted launch values. */
  shellQuoting?: ShellQuoting
  /** L1 rule overrides. */
  rules?: RuleOverride[]
  /** Detection thresholds, merged over the defaults. */
  detection?: Partial<DetectionThresholds>
  /** Progress-breaker limits, merged over the defaults. */
  breaker?: Partial<BreakerPolicy>
  /** Whether a parsed usage-limit reset schedules an automatic resume. */
  limitResumeEnabled?: boolean
  /** Append every observed settlement to a per-terminal log. */
  spillEnabled?: boolean
  /** Byte cap for one terminal's spill log. */
  spillMaxBytes?: number
  /** Default seconds `supervisor_terminal_run` waits for its completion marker. */
  runTimeoutSec?: number
  /** Milliseconds between completion-marker polls. */
  runPollIntervalMs?: number
  /** Seconds without output after which a heartbeat counts as stale. */
  heartbeatTimeoutSec?: number
  /** Poll interval of the watchdog that wakes an idle agent on a stale terminal. */
  watchdogIntervalSec?: number
  /** Seconds between watchdog alerts for the same terminal. */
  watchdogCooldownSec?: number
  /** Start the watchdog when the plugin loads. */
  watchdogEnabled?: boolean
}

/** Configuration after defaults are applied and paths are resolved. */
export interface ResolvedConfig {
  /** Absolute state directory. */
  stateDir: string
  /** Working directory the state directory was resolved against. */
  workspaceDir: string
  /** Absolute directory worktrees are created under. */
  worktreeBase: string
  /** Effective launch templates, one per agent kind. */
  agentTemplates: Record<AgentKind, AgentTemplate>
  /** Profile substituted into `{profile}`. */
  defaultProfile: string
  /** Effective shell dialect. */
  shellQuoting: ShellQuoting
  /** Effective L1 rules. */
  rules: ResolvedRule[]
  /** Effective detection thresholds. */
  thresholds: DetectionThresholds
  /** Effective progress-breaker limits. */
  breaker: BreakerPolicy
  /** Whether usage-limit resets schedule an automatic resume. */
  limitResumeEnabled: boolean
  /** Whether settlement output is appended to spill logs. */
  spillEnabled: boolean
  /** Byte cap for one spill log. */
  spillMaxBytes: number
  /** Default completion-marker timeout in seconds. */
  runTimeoutSec: number
  /** Completion-marker poll interval in milliseconds. */
  runPollIntervalMs: number
  /** Heartbeat staleness timeout in seconds. */
  heartbeatTimeoutSec: number
  /** Watchdog poll interval in seconds. */
  watchdogIntervalSec: number
  /** Watchdog alert cooldown in seconds. */
  watchdogCooldownSec: number
  /** Whether the watchdog runs. */
  watchdogEnabled: boolean
}

/**
 * Built-in launch templates. `{prompt}` is substituted as one quoted argument
 * by {@link quote}; the templates therefore carry no quotes of their own.
 */
export const DEFAULT_AGENT_TEMPLATES: Record<AgentKind, AgentTemplate> = {
  'claude-code': {
    startCommand: 'claude --model {model} --dangerously-skip-permissions {prompt}',
    resumeCommand: 'claude -c',
    modelSwitchCommand: '/model {model}',
  },
  codex: {
    startCommand: 'codex exec --model {model} --skip-git-repo-check {prompt}',
    resumeCommand: 'codex exec resume --last',
    modelSwitchCommand: '',
  },
  'kimi-code': {
    startCommand: 'kimi -p {prompt}',
    resumeCommand: '',
    modelSwitchCommand: '',
  },
  'qwen-code': {
    startCommand: 'qwen-code {prompt}',
    resumeCommand: '',
    modelSwitchCommand: '',
  },
  trae: {
    startCommand: 'trae {prompt}',
    resumeCommand: '',
    modelSwitchCommand: '',
  },
  dsh: {
    startCommand: 'dsh --profile {profile} {prompt}',
    resumeCommand: 'dsh --profile {profile}',
    modelSwitchCommand: '',
  },
}

/** One settlement's detection output. */
export interface SettlementReport {
  /** Deterministic marks derived from the settlement. */
  marks: StateMark[]
  /** Progress-breaker position after this settlement. */
  breaker: BreakerReport
  /** What the output appears to be doing, per the hosted agent's characteristics. */
  outputClass: OutputClass
  /** Every L1 hit for this settlement: stateless rule matches followed by window hits. */
  hits: L1RuleHit[]
  /** Window rule hits for this settlement, kept apart so {@link SettlementReport.hits} stays ordered. */
  windowHits: WindowHit[]
  /** Whether the heartbeat exceeded its timeout at settlement time. */
  heartbeatStale: boolean
  /** Spill log path, when spill is enabled for this terminal. */
  spillPath?: string
  /** Whether the settlement could not be appended because the spill cap was reached. */
  spillCapped: boolean
  /** Epoch milliseconds a parsed usage limit lets the terminal resume. */
  limitResumeAt?: number
}

/** One read of retained scrollback, which is not a settlement. */
export interface InspectionReport {
  /** Marks an observation without a wait reason can carry: prompt text, exit state, heartbeat age. */
  marks: StateMark[]
  /** What the inspected text appears to be doing, per the hosted agent's characteristics. */
  outputClass: OutputClass
  /** Stateless rule hits over the inspected text. */
  hits: L1RuleHit[]
  /** Whether the heartbeat exceeded its timeout at inspection time. */
  heartbeatStale: boolean
  /** Output log path, when spill was enabled for this terminal. */
  spillPath?: string
}

/** Registry entry for one terminal this plugin has driven. */
export interface SupervisedSession {
  /** Terminal session id. */
  sessionId: TerminalSessionId
  /** Agent on whose behalf the terminal is being driven. */
  owner: Agent
  /** Owner-local display name, when the terminal reported one. */
  name?: string
  /** Hosted agent kind, when launched through this plugin. */
  agentKind?: AgentKind
  /** Task the terminal was launched for, when one was given. */
  taskId?: string
  /** Exact launch command used last. */
  lastLaunchCommand?: string
  /** Model requested at launch or through a switch command. */
  lastModel?: string
  /** Wait reason of the most recent settlement. */
  lastWaitReason: TerminalWaitReason
  /** Epoch milliseconds of the most recent observed output. */
  lastOutputAt: number
  /** Top-level session status observed most recently. */
  lastStatus: TerminalSessionStatus
  /** Output log path, when spill is enabled. */
  spillPath?: string
  /** Epoch milliseconds of the last watchdog alert, for the cooldown. */
  lastAlertAt?: number
  /** Per-session sliding windows. */
  readonly windows: SessionWindows
  /** Per-session progress breaker. */
  readonly breaker: ProgressBreaker
  /** Epoch milliseconds when a paused usage limit lets the agent resume; cleared once resumed. */
  limitResumeAt?: number | undefined
  /** Normalized text of the previous settlement, for the change comparison. */
  previousObservation?: string
}

/**
 * Resolve plugin configuration into absolute paths and effective values.
 * @param config - configuration as authored.
 * @returns the resolved configuration.
 * @throws TypeError when a path, threshold, or agent template is unusable.
 */
export function resolveConfig(config: SupervisorConfig): ResolvedConfig {
  const workspaceDir = resolve(config.workspaceDir ?? process.cwd())
  const stateDir = isAbsolute(config.stateDir ?? '')
    ? (config.stateDir as string)
    : resolve(workspaceDir, config.stateDir ?? '.supervisor')
  const thresholds: DetectionThresholds = { ...DEFAULT_THRESHOLDS, ...config.detection ?? {} }
  for (const [name, value] of Object.entries(thresholds)) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new TypeError(`supervisor detection threshold "${name}" must be a positive number`)
    }
  }
  return {
    stateDir,
    workspaceDir,
    worktreeBase: isAbsolute(config.worktreeBase ?? '')
      ? (config.worktreeBase as string)
      : resolve(workspaceDir, config.worktreeBase ?? '.worktrees'),
    agentTemplates: mergeTemplates(config.agents),
    defaultProfile: config.defaultProfile ?? 'headless',
    shellQuoting: config.shellQuoting ?? (process.platform === 'win32' ? 'powershell' : 'posix'),
    rules: resolveRules(config.rules ?? []),
    thresholds,
    breaker: resolveBreaker(config.breaker),
    limitResumeEnabled: config.limitResumeEnabled ?? true,
    spillEnabled: config.spillEnabled ?? true,
    spillMaxBytes: requirePositive(config.spillMaxBytes ?? 5 * 1024 * 1024 * 1024, 'spillMaxBytes'),
    runTimeoutSec: requirePositive(config.runTimeoutSec ?? 600, 'runTimeoutSec'),
    runPollIntervalMs: requirePositive(config.runPollIntervalMs ?? 500, 'runPollIntervalMs'),
    heartbeatTimeoutSec: requirePositive(config.heartbeatTimeoutSec ?? 300, 'heartbeatTimeoutSec'),
    watchdogIntervalSec: requirePositive(config.watchdogIntervalSec ?? 60, 'watchdogIntervalSec'),
    watchdogCooldownSec: requirePositive(config.watchdogCooldownSec ?? 300, 'watchdogCooldownSec'),
    watchdogEnabled: config.watchdogEnabled ?? true,
  }
}

/**
 * Resolve breaker limits, rejecting a ladder that can never reach HALF-OPEN.
 * @param config - configured breaker overrides.
 * @returns the effective policy.
 * @throws TypeError when a limit is non-positive or the ladder is inverted.
 */
function resolveBreaker(config: Partial<BreakerPolicy> | undefined): BreakerPolicy {
  const resolved: BreakerPolicy = { ...DEFAULT_BREAKER_POLICY, ...config ?? {} }
  for (const [name, value] of Object.entries(resolved)) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new TypeError(`supervisor breaker limit "${name}" must be a positive integer`)
    }
  }
  if (resolved.openLimit < resolved.noProgressLimit) {
    throw new TypeError('supervisor breaker "openLimit" must be at least "noProgressLimit" so the ladder can pass through half-open')
  }
  return resolved
}

/** Merge configured templates over the defaults, rejecting an empty launch command. */
function mergeTemplates(overrides: Partial<Record<AgentKind, AgentTemplate>> | undefined): Record<AgentKind, AgentTemplate> {
  const merged = { ...DEFAULT_AGENT_TEMPLATES }
  for (const [kind, template] of Object.entries(overrides ?? {})) {
    if (template.startCommand.trim() === '') {
      throw new TypeError(`supervisor agent template "${kind}" needs a non-empty startCommand`)
    }
    merged[kind as AgentKind] = { ...merged[kind as AgentKind], ...template }
  }
  return merged
}

/** Reject a non-positive or non-finite configured number. */
function requirePositive(value: number, field: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError(`supervisor configuration field "${field}" must be a positive number`)
  }
  return value
}

/**
 * Quote one substituted value for the configured shell dialect.
 * @param value - value to quote.
 * @param quoting - shell dialect of the terminal the text is sent to.
 * @returns the quoted literal, or the value unchanged when quoting is `none`.
 */
export function quote(value: string, quoting: ShellQuoting): string {
  if (quoting === 'none') return value
  if (quoting === 'powershell') return `'${value.replaceAll("'", "''")}'`
  return `'${value.replaceAll("'", "'\\''")}'`
}

/**
 * Substitute a launch template's placeholders.
 * @param template - configured command template.
 * @param values - model, prompt, and profile values.
 * @param quoting - shell dialect used to quote the prompt.
 * @returns the command text to send to the terminal.
 */
export function renderCommand(
  template: string,
  values: { model?: string; prompt: string; profile: string },
  quoting: ShellQuoting,
): string {
  return template
    .replaceAll('{model}', values.model ?? '')
    .replaceAll('{prompt}', quote(values.prompt, quoting))
    .replaceAll('{profile}', values.profile)
    .replaceAll(/\s+/g, ' ')
    .trim()
}
