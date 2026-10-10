/**
 * The orchestration tool surface: per-agent skill inventories, phase-based
 * model switching, per-subtask worktrees, and bounded parallel dispatch. Every
 * tool here is deterministic — it scans a directory, reads a record, or drives
 * a terminal — and returns evidence for the supervising model to judge.
 * @module @deepseek-ai/dsh-supervisor-orchestration/tools
 */

import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { TerminalSessionStatus, TerminalWaitReason } from '@deepseek-ai/dsh-terminal'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  AGENT_KINDS,
  BREAKER_STATE_ENUM,
  MARK_ENUM,
  RULE_HIT_SCHEMA,
  WAIT_REASON_ENUM,
  declaredTerminal,
  describeStatus,
  requireAgent,
  ruleHits,
  sanitize,
  type SettlementReport,
  type SupervisorRuntime,
} from '@deepseek-ai/dsh-supervisor-core'
import type { GitRunner } from '@deepseek-ai/dsh-supervisor-tasks'
import { matchAgents, renderSkillBrief, scanSkills, type SkillInventory, type SkillScanRoots, type SkillStore } from './skills.ts'
import { TASK_PHASES, modelsForPhase, switchCommands, type ResolvedModelRule } from './switch.ts'
import { integrationOrder, nextBatch, type WorktreeManager } from './worktree.ts'

/**
 * Everything the four orchestration tools read from the plugin that registered
 * them: the mounted control plane, the git runner and stores owned by the
 * sibling packages, and this package's resolved settings.
 */
export interface OrchestrationDeps {
  /** Control plane holding the supervised sessions, plans, and core configuration. */
  runtime: SupervisorRuntime
  /** Runner every worktree operation goes through. */
  git: GitRunner
  /** Cached skill inventories. */
  skills: SkillStore
  /** Roots the skill scan reads. */
  skillRoots: SkillScanRoots
  /** Effective phase-to-model rules. */
  modelRules: ResolvedModelRule[]
  /** Worktrees the worktree tool creates, lists, and removes. */
  worktrees: WorktreeManager
  /** Prefix of the branch each worktree checks out. */
  worktreeBranchPrefix: string
  /** Terminals the dispatcher may start at once. */
  maxConcurrency: number
}

/**
 * Register the four orchestration tools.
 * @param ctx - plugin context with the tools and terminals services.
 * @param deps - the mounted services and resolved settings the tools read.
 */
export function registerTools(ctx: Context, deps: OrchestrationDeps): void {
  registerAgentSwitch(ctx, deps)
  registerSkills(ctx, deps)
  registerWorktree(ctx, deps)
  registerDispatch(ctx, deps)
}

/** Register `supervisor_agent_switch`. */
function registerAgentSwitch(ctx: Context, deps: OrchestrationDeps): void {
  ctx.tools.register(defineTool({
    name: 'supervisor_agent_switch',
    description:
      'Switch the model a hosted CLI agent is using, by sending its configured in-session switch command and checking the answer for a rejection. '
      + 'Give either an explicit model or a task phase; a phase resolves through the configured model rules. '
      + 'A CLI without an in-session switch command reports that the terminal must be relaunched instead.',
    parameters: {
      sessionId: { type: 'string', required: true, description: 'Terminal session id.' },
      model: { type: 'string', description: 'Model to switch to; takes precedence over `phase`.' },
      phase: { type: 'string', enum: TASK_PHASES, description: 'Task phase whose configured model to switch to.' },
      agentKind: { type: 'string', enum: AGENT_KINDS, description: 'Hosted CLI, declared when the supervisor did not launch this terminal.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          switched: { type: 'boolean', required: true, description: 'True when a switch command was accepted.' },
          model: { type: 'string', description: 'Model the terminal is now using.' },
          attempted: { type: 'array', required: true, items: { type: 'string' }, description: 'Commands sent, in order.' },
          reason: { type: 'string', description: 'Why no switch happened, when none did.' },
          output: { type: 'string', required: true, description: 'Bounded output of the last settlement, empty when nothing was sent.' },
          waitReason: { type: 'string', enum: WAIT_REASON_ENUM },
          stateMarks: { type: 'array', required: true, items: { type: 'string', enum: MARK_ENUM } },
          l1Hits: { type: 'array', required: true, items: RULE_HIT_SCHEMA },
          breaker: { type: 'string', required: true, enum: BREAKER_STATE_ENUM },
          breakerNoProgress: { type: 'integer', required: true },
          sessionStatus: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.switched
          ? `switched to ${value.model ?? '?'} via ${value.attempted.join(' -> ')}`
          : `not switched: ${value.reason ?? 'unknown reason'}`,
      }],
    },
    async execute(args, exec) {
      const { agent, sessionId } = declaredTerminal(deps.runtime, exec, args)
      const session = deps.runtime.track(agent, sessionId, { kind: 'running' })
      const candidates = args.model !== undefined
        ? [args.model]
        : args.phase === undefined
          ? []
          : modelsForPhase(args.phase, deps.modelRules) ?? []
      if (candidates.length === 0) {
        throw new Error('supervisor_agent_switch needs a model, or a phase a configured model rule covers')
      }
      const template = session.agentKind === undefined ? undefined : deps.runtime.config.agentTemplates[session.agentKind]
      const commands = switchCommands(template?.modelSwitchCommand, candidates)
      const attempted: string[] = []
      let lastAttempt: SwitchAttempt | undefined
      for (const command of commands) {
        attempted.push(command)
        const operation = ctx.terminals.startSend(agent, sessionId, { text: command, submit: true, signal: exec.signal })
        const settled = await operation.done
        const report = await deps.runtime.observe(agent, sessionId, settled.viewport, settled.waitReason, settled.sessionStatus, Date.now())
        lastAttempt = { command, settled, report }
        if (!report.hits.some(hit => hit.ruleId === 'model-switch-fail')) {
          session.lastModel = command
          return switchResult(attempted, lastAttempt)
        }
      }
      // No command was sent either because the CLI cannot switch while running
      // or because every candidate was rejected; the settlement facts differ, so
      // the caller is told which of the two happened.
      return lastAttempt === undefined
        ? {
          switched: false,
          attempted,
          reason: 'the hosted CLI has no in-session model switch command; relaunch it with the model instead',
          output: '',
          stateMarks: [],
          l1Hits: [],
          breaker: session.breaker.report(Date.now()).state,
          breakerNoProgress: session.breaker.report(Date.now()).consecutiveNoProgress,
          sessionStatus: 'running',
        }
        : switchResult(attempted, lastAttempt)
    },
    presentCall: args => ({ card: 'generic', title: `Switch model in ${args.sessionId}`, kind: 'execute' }),
  }))
}

/** Register `supervisor_skills`. */
function registerSkills(ctx: Context, deps: OrchestrationDeps): void {
  ctx.tools.register(defineTool({
    name: 'supervisor_skills',
    description:
      'Scan the hosted CLIs for the skills they have loaded, cache the inventories, and rank them against a subtask\'s required skills. '
      + 'Call it before assigning work, then name the chosen skills in the launch prompt.',
    parameters: {
      action: { type: 'string', required: true, enum: ['scan', 'list'], description: 'Scan the agent roots, or read the cached inventories.' },
      agentKind: { type: 'string', enum: AGENT_KINDS, description: 'Restrict a scan or listing to one agent.' },
      requiredSkills: { type: 'array', items: { type: 'string' }, description: 'Skills a subtask needs; ranked matches come back in `matches`.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          inventories: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                agentKind: { type: 'string', required: true },
                skills: { type: 'array', required: true, items: { type: 'string' } },
                available: { type: 'boolean', required: true },
                scannedAt: { type: 'string', required: true },
              },
            },
          },
          matches: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                agentKind: { type: 'string', required: true },
                matched: { type: 'array', required: true, items: { type: 'string' } },
                missing: { type: 'array', required: true, items: { type: 'string' } },
              },
            },
          },
          brief: { type: 'string', description: 'Launch-prompt block naming the matched skills, when `requiredSkills` was given.' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.inventories.length === 0
          ? 'no skill inventories cached'
          : value.inventories.map(row => `${row.agentKind}: ${row.available ? `${row.skills.length} skill(s)` : 'no configuration found'}`).join('\n'),
      }],
    },
    async execute(args, exec) {
      requireAgent(exec)
      const now = Date.now()
      const kinds = args.agentKind === undefined ? AGENT_KINDS : [args.agentKind]
      const inventories: SkillInventory[] = []
      for (const kind of kinds) {
        if (args.action === 'scan') {
          const scanned = await scanSkills(kind, deps.skillRoots, now)
          await deps.skills.write(scanned)
          inventories.push(scanned)
          continue
        }
        const cached = await deps.skills.read(kind)
        if (cached) inventories.push(cached)
      }
      const matches = args.requiredSkills === undefined ? [] : matchAgents(args.requiredSkills, inventories)
      const best = matches[0]
      return {
        inventories: inventories.map(inventory => ({
          agentKind: inventory.agentKind,
          skills: inventory.skills,
          available: inventory.available,
          scannedAt: new Date(inventory.scannedAt).toISOString(),
        })),
        matches,
        ...best === undefined || best.matched.length === 0 ? {} : { brief: renderSkillBrief(best.matched) },
      }
    },
    presentCall: args => ({ card: 'generic', title: `Skills ${args.action}`, kind: 'read' }),
  }))
}

/** Register `supervisor_worktree`. */
function registerWorktree(ctx: Context, deps: OrchestrationDeps): void {
  ctx.tools.register(defineTool({
    name: 'supervisor_worktree',
    description:
      'Give each subtask its own git worktree so parallel agents never edit the same files, and merge finished branches back in dependency order. '
      + 'Create one worktree per subtask before dispatching it, and integrate once every subtask reports complete.',
    parameters: {
      action: { type: 'string', required: true, enum: ['create', 'list', 'remove', 'integrate'], description: 'What to do.' },
      taskId: { type: 'string', required: true, description: 'Task the worktrees belong to.' },
      subTaskId: { type: 'string', description: 'Subtask to create or remove a worktree for.' },
      baseRef: { type: 'string', description: 'Revision a new worktree starts from; defaults to HEAD.' },
      cwd: { type: 'string', description: 'Directory whose repository is used; defaults to the workspace directory.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string' },
          branch: { type: 'string' },
          removed: { type: 'boolean' },
          worktrees: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                subTaskId: { type: 'string', required: true },
                path: { type: 'string', required: true },
                branch: { type: 'string', required: true },
              },
            },
          },
          merged: { type: 'array', required: true, items: { type: 'string' }, description: 'Subtask branches merged in order.' },
          failed: { type: 'string', description: 'Subtask whose merge stopped the integration.' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.failed === undefined
          ? `${value.worktrees.length} worktree(s)${value.merged.length === 0 ? '' : `; merged ${value.merged.join(', ')}`}`
          : `integration stopped at ${value.failed}`,
      }],
    },
    async execute(args, exec) {
      requireAgent(exec)
      const cwd = resolve(deps.runtime.config.workspaceDir, args.cwd ?? '.')
      const repoPath = await deps.git.topLevel(cwd, exec.signal)
      if (repoPath === undefined) throw new Error(`supervisor_worktree needs a git repository; "${cwd}" is not one`)
      if (args.action === 'create') {
        if (args.subTaskId === undefined) throw new Error('create needs a subTaskId')
        const record = await deps.worktrees.create(repoPath, args.taskId, args.subTaskId, args.baseRef ?? 'HEAD', exec.signal)
        return {
          ...record === undefined ? {} : { path: record.path, branch: record.branch },
          worktrees: await summarizeWorktrees(deps, repoPath, args.taskId, exec.signal),
          merged: [],
        }
      }
      if (args.action === 'remove') {
        if (args.subTaskId === undefined) throw new Error('remove needs a subTaskId')
        const records = await deps.worktrees.list(repoPath, exec.signal)
        const record = records.find(entry => entry.subTaskId === args.subTaskId)
        const removed = record === undefined ? false : await deps.worktrees.remove(repoPath, record, exec.signal)
        return { removed, worktrees: await summarizeWorktrees(deps, repoPath, args.taskId, exec.signal), merged: [] }
      }
      if (args.action === 'list') {
        return { worktrees: await summarizeWorktrees(deps, repoPath, args.taskId, exec.signal), merged: [] }
      }
      const plan = await deps.runtime.plans.read(args.taskId)
      if (!plan) throw new Error(`no plan for task "${args.taskId}"; write the plan before integrating`)
      const merged: string[] = []
      for (const subTaskId of integrationOrder(plan.subTasks)) {
        const branch = `${deps.worktreeBranchPrefix}${args.taskId}/${sanitize(subTaskId)}`
        const result = await deps.git.merge(repoPath, branch, exec.signal)
        if (!result) return { worktrees: await summarizeWorktrees(deps, repoPath, args.taskId, exec.signal), merged, failed: subTaskId }
        merged.push(subTaskId)
      }
      return { worktrees: await summarizeWorktrees(deps, repoPath, args.taskId, exec.signal), merged }
    },
    presentCall: args => ({ card: 'generic', title: `Worktree ${args.action}: ${args.taskId}`, kind: 'other' }),
  }))
}

/** The worktrees registered for one task, as the tool reports them. */
async function summarizeWorktrees(
  deps: OrchestrationDeps,
  repoPath: string,
  taskId: string,
  signal: AbortSignal | undefined,
): Promise<{ subTaskId: string; path: string; branch: string }[]> {
  const records = await deps.worktrees.list(repoPath, signal)
  return records
    .filter(record => record.taskId === taskId)
    .map(record => ({ subTaskId: record.subTaskId, path: record.path, branch: record.branch }))
}

/** Register `supervisor_dispatch`. */
function registerDispatch(ctx: Context, deps: OrchestrationDeps): void {
  ctx.tools.register(defineTool({
    name: 'supervisor_dispatch',
    description:
      'Report the next batch of subtasks to start: those whose dependencies are complete, capped by the configured concurrency and the subtasks already running. '
      + 'Launch each returned subtask in its own terminal and worktree, then call this again.',
    parameters: {
      taskId: { type: 'string', required: true, description: 'Task whose plan is dispatched.' },
      active: { type: 'array', items: { type: 'string' }, description: 'Subtask ids currently running.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          batch: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                title: { type: 'string', required: true },
                requiredSkills: { type: 'array', required: true, items: { type: 'string' } },
                preferredAgent: { type: 'string' },
                worktree: { type: 'string' },
              },
            },
          },
          active: { type: 'integer', required: true },
          maxConcurrency: { type: 'integer', required: true },
          pending: { type: 'integer', required: true },
          blocked: { type: 'integer', required: true, description: 'Pending subtasks still waiting on a dependency.' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.batch.length === 0
          ? `nothing ready (${value.blocked} blocked, ${value.pending} pending)`
          : `start ${value.batch.map(subTask => subTask.id).join(', ')}`,
      }],
    },
    async execute(args, exec) {
      requireAgent(exec)
      const plan = await deps.runtime.plans.read(args.taskId)
      if (!plan) throw new Error(`no plan for task "${args.taskId}"; write the plan before dispatching`)
      const active = args.active ?? []
      const batch = nextBatch(plan.subTasks, active, deps.maxConcurrency)
      const pending = plan.subTasks.filter(subTask => subTask.status === 'pending').length
      const done = new Set(plan.subTasks.filter(subTask => subTask.status === 'completed').map(subTask => subTask.id))
      const blocked = plan.subTasks.filter(subTask => (
        subTask.status === 'pending' && subTask.dependsOn.some(dependency => !done.has(dependency))
      )).length
      return {
        batch: batch.map(subTask => ({
          id: subTask.id,
          title: subTask.title,
          requiredSkills: subTask.requiredSkills,
          ...subTask.preferredAgent === undefined ? {} : { preferredAgent: subTask.preferredAgent },
          worktree: deps.worktrees.pathFor(args.taskId, subTask.id),
        })),
        active: active.length,
        maxConcurrency: deps.maxConcurrency,
        pending,
        blocked,
      }
    },
    presentCall: args => ({ card: 'generic', title: `Dispatch ${args.taskId}`, kind: 'read' }),
  }))
}

/** One attempted model switch: the command, the settlement, and its detection report. */
interface SwitchAttempt {
  /** Command that was sent. */
  command: string
  /** Terminal settlement the command produced. */
  settled: { viewport: string; waitReason: TerminalWaitReason; sessionStatus: TerminalSessionStatus }
  /** Detection output for that settlement. */
  report: SettlementReport
}

/**
 * Project one attempted switch into the tool result.
 * @param attempted - commands sent so far, in order.
 * @param attempt - the attempt the result describes.
 * @returns the tool result, switched or not.
 */
function switchResult(attempted: readonly string[], attempt: SwitchAttempt) {
  const switched = !attempt.report.hits.some(hit => hit.ruleId === 'model-switch-fail')
  return {
    switched,
    attempted: [...attempted],
    ...switched ? { model: attempt.command } : { reason: 'every candidate model was rejected by the hosted CLI' },
    output: attempt.settled.viewport,
    waitReason: attempt.settled.waitReason,
    stateMarks: attempt.report.marks,
    l1Hits: ruleHits(attempt.report),
    breaker: attempt.report.breaker.state,
    breakerNoProgress: attempt.report.breaker.consecutiveNoProgress,
    sessionStatus: describeStatus(attempt.settled.sessionStatus),
  }
}
