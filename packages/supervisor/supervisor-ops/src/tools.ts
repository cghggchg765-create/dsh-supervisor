/**
 * The operations tool surface: usage budget accounting, chat notifications,
 * the shutdown decision, and delivery reports. Every tool here is
 * deterministic: it records what the supervising model reports, renders stored
 * records, or answers a policy question. None of them decides what the run
 * should do next.
 * @module @deepseek-ai/dsh-supervisor-ops/tools
 */

import type { Context } from '@deepseek-ai/cordis'
import { requireAgent, type SupervisorRuntime } from '@deepseek-ai/dsh-supervisor-core'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { parseUsage } from './budget.ts'
import { renderNotification } from './feishu.ts'
import { renderReport } from './report.ts'
import { shutdownDecision } from './shutdown.ts'
import type { SupervisorOpsService } from './index.ts'

/** Events a chat notification can carry. */
const NOTIFY_EVENT_ENUM = ['task-completed', 'task-abnormal', 'budget-alert', 'checkpoint-taken', 'limit-paused'] as const

/** Reasons a shutdown may be considered. */
const SHUTDOWN_TRIGGER_ENUM = ['all-tasks-completed', 'scheduled-time', 'idle-timeout'] as const

/**
 * Register the four operations tools.
 * @param ctx - plugin context carrying the supervisor, task, and ops services.
 * @param service - the operations service holding the ledger, reports, and chat bridge.
 */
export function registerTools(ctx: Context, service: SupervisorOpsService): void {
  registerBudget(ctx, service)
  registerNotify(ctx, service)
  registerShutdown(ctx, service)
  registerReport(ctx, service)
}

/** Register `supervisor_budget`. */
function registerBudget(ctx: Context, service: SupervisorOpsService): void {
  ctx.tools.register(defineTool({
    name: 'supervisor_budget',
    description:
      'Record what one hosted agent reported spending and read the running totals against the task and daily budgets. '
      + 'Record after every settlement that names a token count, and check the status before starting another expensive step.',
    parameters: {
      action: { type: 'string', required: true, enum: ['record', 'status'], description: 'Record usage, or read the totals.' },
      text: { type: 'string', description: 'Terminal output to parse a token count out of; used when `tokens` is absent.' },
      tokens: { type: 'integer', description: 'Token count the caller already knows.' },
      model: { type: 'string', description: 'Model that produced the usage; priced from the configured table.' },
      costUSD: { type: 'number', description: 'Cost the caller knows better than the price table.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          recorded: { type: 'boolean', required: true, description: 'True when this call added an observation.' },
          tokens: { type: 'integer' },
          taskUSD: { type: 'number', required: true },
          dailyUSD: { type: 'number', required: true },
          alert: { type: 'boolean', required: true },
          exceeded: { type: 'boolean', required: true },
          onExceed: { type: 'string', required: true, enum: ['downgrade-all', 'stop-task'] },
          entries: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        // Four decimals: a hosted agent's per-settlement spend is often far
        // below one cent, and two decimals would render it as $0.00.
        text: `task $${value.taskUSD.toFixed(4)} / day $${value.dailyUSD.toFixed(4)}`
          + `${value.exceeded ? ' EXCEEDED' : value.alert ? ' near limit' : ''} (${value.entries} record(s))`,
      }],
    },
    // The ledger lives in memory, so this executor computes its answer without
    // awaiting anything; the tool contract still hands the caller a promise.
    execute(args, exec) {
      requireAgent(exec)
      const now = Date.now()
      const parsed = args.tokens === undefined && args.text !== undefined ? parseUsage(args.text) : undefined
      const tokens = args.tokens ?? parsed?.tokens
      if (args.action === 'record') {
        if (tokens === undefined && args.costUSD === undefined) {
          throw new Error('supervisor_budget record needs a token count, parseable text, or an explicit cost')
        }
        service.recordUsage({
          at: now,
          tokens: tokens ?? 0,
          ...args.model === undefined ? {} : { model: args.model },
          ...args.costUSD === undefined ? {} : { costUSD: args.costUSD },
        })
      }
      const status = service.budgetStatus(now)
      return Promise.resolve({
        recorded: args.action === 'record',
        ...tokens === undefined ? {} : { tokens },
        ...status,
        entries: service.ledger.entries.length,
      })
    },
    presentCall: args => ({ card: 'generic', title: `Budget ${args.action}`, kind: 'read' }),
  }))
}

/** Register `supervisor_notify`. */
function registerNotify(ctx: Context, service: SupervisorOpsService): void {
  ctx.tools.register(defineTool({
    name: 'supervisor_notify',
    description:
      'Push one notification to a chat conversation through the transport the deployment registered. '
      + 'Use it for completion, abnormal endings, budget alerts, and to ask a human a question the run cannot answer itself.',
    parameters: {
      chatId: { type: 'string', required: true, description: 'Conversation to send to.' },
      event: { type: 'string', required: true, enum: NOTIFY_EVENT_ENUM, description: 'What happened.' },
      taskId: { type: 'string', description: 'Task the notification is about.' },
      detail: { type: 'string', description: 'Extra line appended to the notification.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          delivered: { type: 'boolean', required: true },
          text: { type: 'string', required: true, description: 'Rendered notification.' },
          reason: { type: 'string', description: 'Why nothing was delivered.' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.delivered ? `sent: ${value.text}` : `not sent: ${value.reason ?? 'unknown'}` }],
    },
    async execute(args, exec) {
      requireAgent(exec)
      const text = renderNotification(args.event, {
        ...args.taskId === undefined ? {} : { taskId: args.taskId },
        ...args.detail === undefined ? {} : { detail: args.detail },
      })
      const bridge = service.chat
      if (bridge === undefined) {
        return { delivered: false, text, reason: 'no chat transport is registered in this deployment' }
      }
      const delivered = await bridge.notify(args.chatId, text)
      return {
        delivered,
        text,
        ...delivered ? {} : { reason: 'the chat transport rejected the message' },
      }
    },
    presentCall: args => ({ card: 'generic', title: `Notify ${args.event}`, kind: 'other' }),
  }))
}

/**
 * Tasks whose stored plan still has a subtask that is neither completed nor skipped.
 * @param runtime - plugin runtime holding the plans.
 * @returns the task ids with unfinished work, in directory order.
 */
async function unfinishedTasks(runtime: SupervisorRuntime): Promise<string[]> {
  const plans = await runtime.plans.list()
  return plans
    .filter(plan => plan.subTasks.some(subTask => subTask.status !== 'completed' && subTask.status !== 'skipped'))
    .map(plan => plan.taskId)
}

/** Register `supervisor_shutdown`. */
function registerShutdown(ctx: Context, service: SupervisorOpsService): void {
  ctx.tools.register(defineTool({
    name: 'supervisor_shutdown',
    description:
      'Decide whether the machine may be shut down now. The plugin never runs the command itself: it reports the operator-configured command and whether this trigger permits it, so a deployment decides what to execute.',
    parameters: {
      trigger: { type: 'string', required: true, enum: SHUTDOWN_TRIGGER_ENUM, description: 'Why a shutdown is being considered.' },
      lastTaskFinishedAt: { type: 'string', description: 'ISO timestamp the last task finished, for the grace period.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          allowed: { type: 'boolean', required: true },
          command: { type: 'string', description: 'Operator-configured command, present only when allowed.' },
          reason: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.allowed ? `shutdown allowed: ${value.command ?? ''}` : `shutdown refused: ${value.reason}` }],
    },
    async execute(args, exec) {
      requireAgent(exec)
      const finishedAt = args.lastTaskFinishedAt === undefined ? undefined : Date.parse(args.lastTaskFinishedAt)
      if (finishedAt !== undefined && !Number.isFinite(finishedAt)) {
        throw new Error('supervisor_shutdown lastTaskFinishedAt must be an ISO timestamp')
      }
      if (args.trigger === 'all-tasks-completed') {
        const unfinished = await unfinishedTasks(ctx.supervisor)
        if (unfinished.length > 0) {
          return {
            allowed: false,
            reason: `the stored plans still have unfinished work: ${unfinished.join(', ')}`,
          }
        }
      }
      return shutdownDecision(service.config.shutdown, args.trigger, Date.now(), finishedAt)
    },
    presentCall: args => ({ card: 'generic', title: `Shutdown ${args.trigger}`, kind: 'other' }),
  }))
}

/** Register `supervisor_report`. */
function registerReport(ctx: Context, service: SupervisorOpsService): void {
  ctx.tools.register(defineTool({
    name: 'supervisor_report',
    description:
      'Render and store the delivery report for a finished task. The deterministic sections come from the stored plan, checkpoints, and git statistics; supply the review summary and follow-ups yourself.',
    parameters: {
      taskId: { type: 'string', required: true, description: 'Task the report covers.' },
      title: { type: 'string', required: true, description: 'Human-readable task title.' },
      outcome: { type: 'string', required: true, enum: ['completed', 'partial', 'aborted'], description: 'Final outcome.' },
      startedAt: { type: 'string', description: 'ISO timestamp the task started.' },
      baseCommit: { type: 'string', description: 'Revision the task started from, for the change summary.' },
      reviewSummary: { type: 'string', description: 'Review findings, in Markdown.' },
      followUps: { type: 'array', items: { type: 'string' }, description: 'Suggested follow-up work.' },
      rollback: { type: 'string', description: 'Rollback instructions shown in the report.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          markdown: { type: 'string', required: true },
          filesAdded: { type: 'integer', required: true },
          filesModified: { type: 'integer', required: true },
          filesDeleted: { type: 'integer', required: true },
          linesInserted: { type: 'integer', required: true },
          linesDeleted: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `report written to ${value.path}\n+${value.linesInserted}/-${value.linesDeleted} across ${value.filesAdded + value.filesModified + value.filesDeleted} file(s)` }],
    },
    async execute(args, exec) {
      requireAgent(exec)
      const now = Date.now()
      const plan = await ctx.supervisor.plans.read(args.taskId)
      const checkpoints = await ctx.supervisorTasks.checkpoints.list(args.taskId)
      const latest = checkpoints.at(-1)
      const repoPath = latest?.gitRef?.repoPath
      const diffStat = repoPath === undefined || args.baseCommit === undefined
        ? { filesAdded: 0, filesModified: 0, filesDeleted: 0, linesInserted: 0, linesDeleted: 0 }
        : await ctx.supervisorTasks.git.diffStat(repoPath, args.baseCommit, latest?.gitRef?.commitHash ?? '', exec.signal)
      const markdown = renderReport({
        taskId: args.taskId,
        title: args.title,
        outcome: args.outcome,
        completedAt: now,
        checkpoints,
        diffStat,
        budget: service.budgetStatus(now),
        ...plan === undefined ? {} : { plan },
        ...args.startedAt === undefined ? {} : { startedAt: Date.parse(args.startedAt) },
        ...args.reviewSummary === undefined ? {} : { reviewSummary: args.reviewSummary },
        ...args.followUps === undefined ? {} : { followUps: args.followUps },
        ...args.rollback === undefined ? {} : { rollback: args.rollback },
      })
      const path = await service.reports.write(args.taskId, markdown)
      return {
        path,
        markdown,
        filesAdded: diffStat.filesAdded,
        filesModified: diffStat.filesModified,
        filesDeleted: diffStat.filesDeleted,
        linesInserted: diffStat.linesInserted,
        linesDeleted: diffStat.linesDeleted,
      }
    },
    presentCall: args => ({ card: 'generic', title: `Delivery report: ${args.title}`, kind: 'other' }),
  }))
}
