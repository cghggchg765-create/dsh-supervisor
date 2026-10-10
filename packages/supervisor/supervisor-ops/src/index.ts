/**
 * Operations for supervised runs: usage budget accounting with a model price
 * table and a downgrade-or-stop policy, delivery reports assembled from plans,
 * checkpoints, and git statistics, chat notifications over a deployment-provided
 * transport, and the shutdown gate that never runs an OS command itself.
 *
 * The service owns no intelligence and no durability of its own: plan and
 * terminal facts come from `ctx.supervisor`, checkpoint and git facts from
 * `ctx.supervisorTasks`, and the model decides what any of it means.
 * @module @deepseek-ai/dsh-supervisor-ops
 */

import { join } from 'node:path'
import { Service, type Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import z from '@deepseek-ai/schemastery'
import {
  DEFAULT_BUDGET_POLICY,
  UsageLedger,
  type BudgetPolicy,
  type BudgetStatus,
  type ModelPrice,
  type UsageEntry,
} from './budget.ts'
import {
  ChatBridge,
  type ChatCommand,
  type ChatMessage,
  type ChatTransport,
} from './feishu.ts'
import { ReportStore } from './report.ts'
import { DEFAULT_SHUTDOWN_POLICY, type ShutdownPolicy } from './shutdown.ts'
import { registerTools } from './tools.ts'

/** Operations configuration as authored in cordis.yml. */
export interface SupervisorOpsConfig {
  /** Budget limits, merged over the defaults. */
  budget?: Partial<BudgetPolicy>
  /** Model price table used to turn token counts into money. */
  modelPrices?: ModelPrice[]
  /** Shutdown policy, merged over the defaults. */
  shutdown?: Partial<ShutdownPolicy>
}

/** Operations configuration after defaults are applied. */
export interface ResolvedOpsConfig {
  /** Absolute state directory, shared with the supervisor control plane. */
  stateDir: string
  /** Effective budget limits. */
  budget: BudgetPolicy
  /** Model price table. */
  modelPrices: ModelPrice[]
  /** Effective shutdown policy. */
  shutdown: ShutdownPolicy
}

/**
 * The operations service: the usage ledger, the delivery report store, the
 * chat bridge seam, and the four operations tools.
 */
export class SupervisorOpsService extends Service {
  /** Services the operations tools read and register against. */
  static inject = ['tools', 'supervisor', 'supervisorTasks']

  /** Plugin configuration schema. */
  static Config: z<SupervisorOpsConfig> = z.object({
    budget: z.object({
      taskBudgetUSD: z.number().min(0.01).default(DEFAULT_BUDGET_POLICY.taskBudgetUSD),
      dailyBudgetUSD: z.number().min(0.01).default(DEFAULT_BUDGET_POLICY.dailyBudgetUSD),
      alertThresholdPct: z.number().min(1).max(100).default(DEFAULT_BUDGET_POLICY.alertThresholdPct),
      onExceed: z.union([
        z.const('downgrade-all'),
        z.const('stop-task'),
      ]).default(DEFAULT_BUDGET_POLICY.onExceed),
    }).default({}),
    modelPrices: z.array(z.object({
      model: z.string().required(),
      usdPerMillionTokens: z.number().min(0.01).required(),
    })).default([]),
    shutdown: z.object({
      enabled: z.boolean().default(DEFAULT_SHUTDOWN_POLICY.enabled),
      command: z.string().default(DEFAULT_SHUTDOWN_POLICY.command),
      gracePeriodMin: z.number().step(1).min(1).default(DEFAULT_SHUTDOWN_POLICY.gracePeriodMin),
    }).default({}),
  })

  /** Resolved configuration. */
  readonly config: ResolvedOpsConfig

  /** Running spend for the current task and the day. */
  readonly ledger: UsageLedger

  /** Delivery reports, one directory per task. */
  readonly reports: ReportStore

  /** Chat bridge, once a deployment registers a transport. */
  private bridge: ChatBridge | undefined

  /** Task the ledger's window belongs to; undefined before one is identified. */
  private ledgerTask: string | undefined

  /**
   * @param ctx - the context the service registers itself in.
   * @param config - validated plugin configuration.
   */
  constructor(ctx: Context, config: SupervisorOpsConfig = {}) {
    super(ctx, 'supervisorOps')
    const stateDir = this.ctx.supervisor.config.stateDir
    this.config = {
      stateDir,
      budget: resolveBudget(config.budget),
      modelPrices: resolvePrices(config.modelPrices ?? []),
      shutdown: resolveShutdown(config.shutdown),
    }
    this.ledger = new UsageLedger(this.config.budget, this.config.modelPrices)
    this.reports = new ReportStore(join(stateDir, 'deliverables'))
    registerTools(this.ctx, this)
  }

  /**
   * Register the deployment's chat transport. The plugin owns the default
   * routing: an inbound message reaches the agents that own supervised
   * terminals as a steer, so a human can ask for status or redirect the run
   * from the chat. A deployment that needs its own routing passes a handler and
   * takes over that job. This is the documented extension point a chat
   * connector mounts through.
   * @param transport - chat provider supplied by the deployment.
   * @param handler - optional routing override receiving every parsed message.
   * @returns the disposer that unsubscribes and forgets the transport.
   */
  useChatTransport(
    transport: ChatTransport,
    handler?: (message: ChatMessage, command: { command: ChatCommand; argument: string }) => void,
  ): () => void {
    const bridge = new ChatBridge(transport, handler ?? ((message, command) => {
      this.routeChat(message, command)
    }))
    this.bridge = bridge
    const stop = bridge.start()
    return () => {
      stop()
      if (this.bridge === bridge) this.bridge = undefined
    }
  }

  /**
   * Deliver one inbound chat message to the supervised agents.
   * @param message - inbound message.
   * @param command - the command the message carried.
   */
  private routeChat(message: ChatMessage, command: { command: ChatCommand; argument: string }): void {
    const text = `[chat] ${message.senderId}: ${command.command === 'chat' ? command.argument : `/${command.command} ${command.argument}`.trim()}`
    for (const owner of new Set([...this.ctx.supervisor.sessions.values()].map(session => session.owner))) {
      try {
        owner.steer(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
      } catch {
        // A disposed or already-driving agent rejects the steer; the message is
        // dropped because the transport already acknowledged it to the sender.
      }
    }
  }

  /** The registered chat bridge, or undefined when no transport was supplied. */
  get chat(): ChatBridge | undefined {
    return this.bridge
  }

  /**
   * Record one usage observation under the task the supervised terminals are
   * currently on, moving the ledger's task window first so the observation is
   * never dropped by the move.
   * @param entry - usage to record.
   */
  recordUsage(entry: UsageEntry): void {
    this.followSupervisedTask()
    this.ledger.record(entry)
  }

  /**
   * Current budget state, read from the ledger.
   * @param now - epoch milliseconds the day and the alert thresholds are evaluated against.
   * @returns the task and daily spend with their alert and exceeded flags.
   */
  budgetStatus(now: number): BudgetStatus {
    this.followSupervisedTask()
    return this.ledger.status(now)
  }

  /**
   * Move the ledger to the task the supervised terminals currently work on,
   * dropping the previous task's spend when it changed. Terminals that name no
   * task, or disagree on one, leave the window alone, so a report written after
   * the terminals were forgotten still shows the finished task's spend.
   */
  private followSupervisedTask(): void {
    const taskId = this.currentTaskId()
    if (taskId === undefined || taskId === this.ledgerTask) return
    this.ledger.resetTask()
    this.ledgerTask = taskId
  }

  /** Task id every task-bound supervised terminal agrees on, when they agree on one. */
  private currentTaskId(): string | undefined {
    let current: string | undefined
    for (const session of this.ctx.supervisor.sessions.values()) {
      const taskId = session.taskId
      if (taskId === undefined || taskId === '') continue
      if (current === undefined) current = taskId
      else if (current !== taskId) return undefined
    }
    return current
  }
}

/**
 * Resolve operations configuration into effective values.
 * @param config - configured budget overrides.
 * @returns the effective policy.
 * @throws TypeError when a budget or threshold is unusable.
 */
function resolveBudget(config: Partial<BudgetPolicy> | undefined): BudgetPolicy {
  const resolved: BudgetPolicy = { ...DEFAULT_BUDGET_POLICY, ...config ?? {} }
  for (const field of ['taskBudgetUSD', 'dailyBudgetUSD'] as const) {
    if (!Number.isFinite(resolved[field]) || resolved[field] <= 0) {
      throw new TypeError(`supervisor budget field "${field}" must be a positive number`)
    }
  }
  if (!Number.isFinite(resolved.alertThresholdPct) || resolved.alertThresholdPct <= 0 || resolved.alertThresholdPct > 100) {
    throw new TypeError('supervisor budget field "alertThresholdPct" must be greater than 0 and at most 100')
  }
  return resolved
}

/**
 * Reject a price entry that could never produce a cost.
 * @param prices - configured model prices.
 * @returns the same entries, validated.
 * @throws TypeError when a model name is blank or a price is not a positive number.
 */
function resolvePrices(prices: readonly ModelPrice[]): ModelPrice[] {
  for (const price of prices) {
    if (price.model.trim() === '') {
      throw new TypeError('supervisor model price entries need a non-empty model name')
    }
    if (!Number.isFinite(price.usdPerMillionTokens) || price.usdPerMillionTokens <= 0) {
      throw new TypeError(`supervisor model price for "${price.model}" must be a positive number`)
    }
  }
  return [...prices]
}

/**
 * Resolve the shutdown policy, which stays disabled unless an operator enables it.
 * @param config - configured shutdown overrides.
 * @returns the effective policy.
 * @throws TypeError when the grace period is not a positive number.
 */
function resolveShutdown(config: Partial<ShutdownPolicy> | undefined): ShutdownPolicy {
  const resolved: ShutdownPolicy = { ...DEFAULT_SHUTDOWN_POLICY, ...config ?? {} }
  if (!Number.isFinite(resolved.gracePeriodMin) || resolved.gracePeriodMin <= 0) {
    throw new TypeError('supervisor shutdown field "gracePeriodMin" must be a positive number')
  }
  return resolved
}

export default SupervisorOpsService

export {
  DEFAULT_BUDGET_POLICY,
  UsageLedger,
  estimateCostUSD,
  parseUsage,
  priceOf,
} from './budget.ts'
export type { BudgetPolicy, BudgetStatus, ModelPrice, UsageEntry } from './budget.ts'
export {
  ChatBridge,
  parseCommand,
  renderNotification,
} from './feishu.ts'
export type { ChatCommand, ChatMessage, ChatTransport, NotifyEvent } from './feishu.ts'
export { ReportStore, renderReport } from './report.ts'
export type { ReportInput } from './report.ts'
export { DEFAULT_SHUTDOWN_POLICY, shutdownDecision } from './shutdown.ts'
export type { ShutdownDecision, ShutdownPolicy, ShutdownTrigger } from './shutdown.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    supervisorOps: SupervisorOpsService
  }
}
