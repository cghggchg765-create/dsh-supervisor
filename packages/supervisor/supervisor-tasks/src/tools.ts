/**
 * The model-facing tool surface for plans and durable task state. Every tool
 * here is deterministic: it reads or writes a record, lists checkpoints, or
 * assembles the evidence a review round reads. None of them decide whether the
 * hosted agent is healthy — they return evidence and let the supervising model
 * judge inside the agent loop.
 * @module @deepseek-ai/dsh-supervisor-tasks/tools
 */

import { relative, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import {
  AGENT_KINDS,
  describeStatus,
  requireAgent,
  type ResolvedConfig,
  type SubTask,
  type SubTaskStatus,
  type SupervisorCheckpoint,
  type TaskPlan,
} from '@deepseek-ai/dsh-supervisor-core'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { CheckpointDraft } from './checkpoint.ts'
import { advanceTicket, blockingFindings, openTicket, renderRedoBrief, renderReviewPacket, type IssueTicket } from './review.ts'
import type { SupervisorTaskService } from './index.ts'

/** Subtask statuses. */
const SUBTASK_STATUS_ENUM = ['pending', 'in-progress', 'completed', 'failed', 'skipped'] as const

/** Verification methods an acceptance criterion may declare. */
const VERIFICATION_ENUM = ['test-command', 'file-exists', 'output-contains', 'manual', 'llm-judge'] as const

/** Effort estimates. */
const EFFORT_ENUM = ['small', 'medium', 'large'] as const

/** Integration strategies. */
const INTEGRATION_ENUM = ['sequential-merge', 'parallel-merge', 'staged'] as const

/**
 * Register the plan and durable-task-state tools.
 * @param ctx - plugin context with the tools service and the control plane.
 * @param service - the task-state service owning the checkpoint and ticket stores.
 */
export function registerTools(ctx: Context, service: SupervisorTaskService): void {
  registerReview(ctx, service)
  registerIssue(ctx, service)
  registerCheckpoint(ctx, service)
  registerPlan(ctx)
}

/** Register `supervisor_review`. */
function registerReview(ctx: Context, service: SupervisorTaskService): void {
  ctx.tools.register(defineTool({
    name: 'supervisor_review',
    description:
      'Assemble the evidence one review round reads: the plan and its acceptance criteria, the checkpoints taken, the diff of the task\'s commit range, and the tail of the supervised terminal\'s log. '
      + 'Judge the returned packet yourself, then record the findings with supervisor_issue.',
    parameters: {
      taskId: { type: 'string', required: true, description: 'Task under review.' },
      baseCommit: { type: 'string', description: 'Revision the task started from; with a repository this adds the diff.' },
      headCommit: { type: 'string', description: 'Revision to diff against; defaults to the newest checkpoint commit.' },
      terminalSessionId: { type: 'string', description: 'Supervised terminal whose output log to include.' },
      cwd: { type: 'string', description: 'Directory whose repository is diffed; defaults to the workspace directory.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          markdown: { type: 'string', required: true, description: 'The review packet.' },
          checkpoints: { type: 'integer', required: true },
          criteria: { type: 'integer', required: true, description: 'Acceptance criteria the plan declares.' },
          diffIncluded: { type: 'boolean', required: true },
          outputIncluded: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `review packet: ${value.checkpoints} checkpoint(s), ${value.criteria} criterion(a)`
          + `${value.diffIncluded ? ', diff included' : ''}${value.outputIncluded ? ', output tail included' : ''}`,
      }],
    },
    async execute(args, exec) {
      requireAgent(exec)
      const plan = await ctx.supervisor.plans.read(args.taskId)
      const checkpoints = await service.checkpoints.list(args.taskId)
      const latest = checkpoints.at(-1)
      const repoPath = latest?.gitRef?.repoPath
      const head = args.headCommit ?? latest?.gitRef?.commitHash
      const diff = args.baseCommit === undefined || repoPath === undefined || head === undefined
        ? undefined
        : await service.git.diff(repoPath, args.baseCommit, head, exec.signal)
      const tailPath = args.terminalSessionId === undefined
        ? undefined
        : ctx.supervisor.spill.pathFor(args.terminalSessionId, ctx.supervisor.sessions.get(args.terminalSessionId)?.taskId)
      const outputTail = tailPath === undefined ? undefined : await ctx.supervisor.spill.readTail(tailPath, 8000)
      const markdown = renderReviewPacket({
        taskId: args.taskId,
        checkpoints,
        ...plan === undefined ? {} : { plan },
        ...diff === undefined || diff === '' ? {} : { diff },
        ...outputTail === undefined ? {} : { outputTail },
      })
      return {
        markdown,
        checkpoints: checkpoints.length,
        criteria: plan?.acceptanceCriteria.length ?? 0,
        diffIncluded: diff !== undefined && diff !== '',
        outputIncluded: outputTail !== undefined,
      }
    },
    presentCall: args => ({ card: 'generic', title: `Review ${args.taskId}`, kind: 'read' }),
  }))
}

/** Register `supervisor_issue`. */
function registerIssue(ctx: Context, service: SupervisorTaskService): void {
  ctx.tools.register(defineTool({
    name: 'supervisor_issue',
    description:
      'Record a review round as an issue ticket and walk it through repair: open it with the findings, '
      + 'then mark each repair attempt and each regression result. The ticket escalates by itself once the repair budget runs out, '
      + 'and the redo brief is what you send back to the responsible agent.',
    parameters: {
      action: { type: 'string', required: true, enum: ['open', 'list', 'read', 'redo', 'regression-passed', 'regression-failed'], description: 'What to do.' },
      taskId: { type: 'string', required: true, description: 'Task the findings belong to.' },
      ticketId: { type: 'string', description: 'Ticket to act on; defaults to the newest for the task.' },
      findings: {
        type: 'array',
        description: 'Findings for `open`.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true },
            severity: { type: 'string', required: true, enum: ['blocking', 'high', 'medium', 'low', 'nitpick'] },
            category: { type: 'string', required: true, enum: ['requirement-gap', 'test-failure', 'code-quality', 'security', 'computer-use'] },
            title: { type: 'string', required: true },
            evidence: { type: 'string', required: true },
            gap: { type: 'string', required: true },
            suggestedFix: { type: 'string', required: true },
            acceptanceCriterionId: { type: 'string' },
          },
        },
      },
      regressionScope: { type: 'array', items: { type: 'string' }, description: 'Checks the repair must re-run.' },
      redoInstructions: { type: 'string', description: 'Instructions handed to the responsible agent.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string' },
          ticketId: { type: 'string', required: true },
          status: { type: 'string', required: true, enum: ['open', 'in-redo', 'in-regression', 'resolved', 'escalated'] },
          retryCount: { type: 'integer', required: true },
          maxRetries: { type: 'integer', required: true },
          blocking: { type: 'integer', required: true, description: 'Findings at `blocking` or `high` severity.' },
          findings: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                severity: { type: 'string', required: true },
                category: { type: 'string', required: true },
                title: { type: 'string', required: true },
              },
            },
          },
          redoBrief: { type: 'string', description: 'Instructions to send to the responsible agent, present while the ticket is under repair.' },
          tickets: { type: 'integer', required: true, description: 'Tickets stored for this task.' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `ticket ${value.ticketId}: ${value.status} (attempt ${value.retryCount}/${value.maxRetries}, ${value.blocking} blocking finding(s))`,
      }],
    },
    async execute(args, exec) {
      requireAgent(exec)
      const now = Date.now()
      if (args.action === 'open') {
        const ticket = openTicket(args.taskId, args.findings ?? [], {
          maxRetries: service.config.maxRetriesPerIssue,
          ...args.regressionScope === undefined ? {} : { regressionScope: args.regressionScope },
          ...args.redoInstructions === undefined ? {} : { redoInstructions: args.redoInstructions },
        }, now)
        const { path } = await service.tickets.create(ticket)
        return { ...ticketResult(ticket, await service.tickets.list(args.taskId)), path }
      }
      if (args.action === 'list') {
        const tickets = await service.tickets.list(args.taskId)
        const newest = tickets.at(-1)
        if (newest === undefined) throw new Error(`no issue ticket for task "${args.taskId}"`)
        return ticketResult(newest, tickets)
      }
      const ticket = await service.tickets.read(args.taskId, args.ticketId)
      if (!ticket) throw new Error(`no issue ticket for task "${args.taskId}"`)
      if (args.action === 'read') return ticketResult(ticket, await service.tickets.list(args.taskId))
      const advanced = advanceTicket(ticket, args.action, now)
      await service.tickets.write(advanced)
      return { ...ticketResult(advanced, await service.tickets.list(args.taskId)), path: '' }
    },
    presentCall: args => ({ card: 'generic', title: `Issue ${args.action}: ${args.taskId}`, kind: 'other' }),
  }))
}

/** One ticket as the tool result reports it. */
function ticketResult(ticket: IssueTicket, all: readonly IssueTicket[]) {
  const repairing = ticket.status === 'open' || ticket.status === 'in-redo' || ticket.status === 'in-regression'
  return {
    ticketId: ticket.ticketId,
    status: ticket.status,
    retryCount: ticket.retryCount,
    maxRetries: ticket.maxRetries,
    blocking: blockingFindings(ticket.findings).length,
    findings: ticket.findings.map(finding => ({
      id: finding.id,
      severity: finding.severity,
      category: finding.category,
      title: finding.title,
    })),
    ...repairing ? { redoBrief: renderRedoBrief(ticket) } : {},
    tickets: all.length,
  }
}

/**
 * Paths a checkpoint commit must leave out: the directories this plugin owns
 * must not enter the checkpoint, because `supervisor_checkpoint restore` runs
 * `git reset --hard`, which deletes tracked files — a state directory inside the
 * repository would lose every newer plan, checkpoint, and ticket on restore.
 * A directory outside the repository contributes no path.
 * @param config - resolved control-plane configuration carrying the state and worktree roots.
 * @param repoPath - repository root the commit runs in.
 * @returns repo-relative, POSIX-separated paths; `GitRunner.commitAll` turns them
 *   into exclusion pathspecs.
 */
function checkpointExcludes(config: ResolvedConfig, repoPath: string): string[] {
  return [config.stateDir, config.worktreeBase]
    .map(directory => relative(repoPath, directory))
    .filter(relativePath => relativePath !== '' && !relativePath.startsWith('..'))
    .map(relativePath => relativePath.split(sep).join('/'))
}

/** Register `supervisor_checkpoint`. */
function registerCheckpoint(ctx: Context, service: SupervisorTaskService): void {
  ctx.tools.register(defineTool({
    name: 'supervisor_checkpoint',
    description:
      'Create, list, or restore a task checkpoint. A checkpoint pins the git commit, the terminal state, and the output log so a crashed or aborted run can resume. '
      + 'Take one at every step boundary and before any risky action.',
    parameters: {
      action: { type: 'string', required: true, enum: ['create', 'list', 'restore'], description: 'What to do.' },
      taskId: { type: 'string', required: true, description: 'Task the checkpoint belongs to.' },
      stepIndex: { type: 'integer', description: 'Plan step index; defaults to 0.' },
      attempt: { type: 'integer', description: '1-based attempt number; defaults to 1.' },
      note: { type: 'string', description: 'Free-form note stored in the checkpoint commit message.' },
      terminalSessionId: { type: 'string', description: 'Supervised terminal this checkpoint refers to.' },
      cwd: { type: 'string', description: 'Directory whose repository is snapshotted; defaults to the workspace directory.' },
      checkpointId: { type: 'string', description: 'Checkpoint to restore; defaults to the newest for the task.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          checkpointId: { type: 'string', required: true, description: 'Checkpoint the action produced, restored, or listed as newest; empty when the task has none.' },
          path: { type: 'string' },
          commitHash: { type: 'string', required: true, description: 'Commit the checkpoint pinned, or an empty string when no commit was made.' },
          branch: { type: 'string' },
          gitAvailable: { type: 'boolean', required: true },
          count: { type: 'integer', required: true, description: 'Checkpoints currently stored for the task.' },
          checkpoints: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                checkpointId: { type: 'string', required: true },
                stepIndex: { type: 'integer', required: true },
                attempt: { type: 'integer', required: true },
                timestamp: { type: 'string', required: true },
                commitHash: { type: 'string' },
              },
            },
          },
          restored: { type: 'boolean', required: true },
          outputTail: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.restored
          ? `restored ${value.checkpointId} (commit ${value.commitHash})`
          : `${value.count} checkpoint(s)${value.checkpointId === '' ? '' : `; latest ${value.checkpointId}`}${value.commitHash === '' ? '' : ` at ${value.commitHash}`}`,
      }],
    },
    async execute(args, exec) {
      const agent = requireAgent(exec)
      const now = Date.now()
      const cwd = resolve(ctx.supervisor.config.workspaceDir, args.cwd ?? '.')
      const repoPath = await service.git.topLevel(cwd, exec.signal)
      const gitAvailable = repoPath !== undefined
      if (args.action === 'create') {
        const step = args.stepIndex ?? 0
        const attempt = args.attempt ?? 1
        const session = args.terminalSessionId === undefined ? undefined : ctx.supervisor.sessions.get(args.terminalSessionId)
        let gitRef: CheckpointDraft['gitRef']
        if (repoPath !== undefined) {
          const branch = `${service.config.checkpointBranchPrefix}${args.taskId}`
          const message = `checkpoint: ${args.taskId}@step-${step}${args.note === undefined ? '' : ` ${args.note}`}`
          // Dirty state is captured before the commit: afterwards the commit has
          // already staged everything, so the same call would always answer false.
          const hasUncommitted = await service.git.hasUncommitted(repoPath, exec.signal)
          const excludes = checkpointExcludes(ctx.supervisor.config, repoPath)
          const commitHash = await service.git.commitAll(repoPath, branch, message, exec.signal, excludes)
          gitRef = {
            repoPath,
            branch,
            commitHash: commitHash ?? '',
            hasUncommitted,
          }
        }
        const draft: CheckpointDraft = {
          taskId: args.taskId,
          stepIndex: step,
          attempt,
          supervisorSessionId: agent.id,
          ...args.terminalSessionId === undefined ? {} : { terminalSessionId: args.terminalSessionId },
          ...gitRef === undefined ? {} : { gitRef },
          ...session?.spillPath === undefined ? {} : { outputSpillPath: session.spillPath },
          ...session === undefined ? {} : {
            terminalState: {
              agentKind: session.agentKind ?? 'dsh',
              lastLaunchCommand: session.lastLaunchCommand ?? '',
              ...session.lastModel === undefined ? {} : { lastModel: session.lastModel },
              state: describeStatus(session.lastStatus),
            },
          },
        }
        const { checkpoint, path } = await service.checkpoints.create(draft, now)
        const all = await service.checkpoints.list(args.taskId)
        return {
          checkpointId: checkpoint.checkpointId,
          path,
          commitHash: checkpoint.gitRef?.commitHash ?? '',
          ...checkpoint.gitRef === undefined ? {} : { branch: checkpoint.gitRef.branch },
          gitAvailable,
          count: all.length,
          checkpoints: summarize(all),
          restored: false,
        }
      }
      if (args.action === 'list') {
        const all = await service.checkpoints.list(args.taskId)
        const latest = all.at(-1)
        return {
          checkpointId: latest?.checkpointId ?? '',
          commitHash: latest?.gitRef?.commitHash ?? '',
          ...latest?.gitRef === undefined ? {} : { branch: latest.gitRef.branch },
          gitAvailable,
          count: all.length,
          checkpoints: summarize(all),
          restored: false,
        }
      }
      const checkpoint = await service.checkpoints.read(args.taskId, args.checkpointId)
      if (!checkpoint) throw new Error(`no checkpoint for task "${args.taskId}"`)
      let restored = false
      if (checkpoint.gitRef && checkpoint.gitRef.commitHash !== '') {
        const { repoPath, branch, commitHash } = checkpoint.gitRef
        restored = await service.git.resetHard(repoPath, branch, commitHash, exec.signal)
      }
      const outputTail = checkpoint.outputSpillPath === undefined
        ? undefined
        : await ctx.supervisor.spill.readTail(checkpoint.outputSpillPath, 8000)
      return {
        checkpointId: checkpoint.checkpointId,
        gitAvailable,
        count: (await service.checkpoints.list(args.taskId)).length,
        checkpoints: summarize(await service.checkpoints.list(args.taskId)),
        restored,
        commitHash: checkpoint.gitRef?.commitHash ?? '',
        ...checkpoint.gitRef === undefined ? {} : { branch: checkpoint.gitRef.branch },
        ...outputTail === undefined ? {} : { outputTail },
      }
    },
    presentCall: args => ({ card: 'generic', title: `Checkpoint ${args.action}: ${args.taskId}`, kind: 'other' }),
  }))
}

/** Compact checkpoint list for tool output. */
function summarize(records: readonly SupervisorCheckpoint[]) {
  return records.map(record => ({
    checkpointId: record.checkpointId,
    stepIndex: record.stepIndex,
    attempt: record.attempt,
    timestamp: new Date(record.timestamp).toISOString(),
    ...record.gitRef === undefined || record.gitRef.commitHash === '' ? {} : { commitHash: record.gitRef.commitHash },
  }))
}

/** Register `supervisor_plan`. */
function registerPlan(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'supervisor_plan',
    description:
      'Persist, read, or update the plan for a task. Write the plan once after decomposing the goal into independently verifiable subtasks, then update subtask statuses as they complete. '
      + 'The plan is what the checkpoint restore and the delivery report read back.',
    parameters: {
      action: { type: 'string', required: true, enum: ['write', 'read', 'set-status'], description: 'What to do.' },
      taskId: { type: 'string', required: true, description: 'Task the plan belongs to.' },
      goal: { type: 'string', description: 'Task goal; required for write.' },
      constraints: { type: 'array', items: { type: 'string' }, description: 'Constraints the hosted agents must respect.' },
      integrationStrategy: { type: 'string', enum: INTEGRATION_ENUM, description: 'How subtask work is merged.' },
      acceptanceCriteria: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true },
            description: { type: 'string', required: true },
            verificationMethod: { type: 'string', required: true, enum: VERIFICATION_ENUM },
            verificationSpec: { type: 'object', additionalProperties: true, properties: {} },
            status: { type: 'string', enum: ['pending', 'passed', 'failed'] },
          },
        },
        description: 'Task-level acceptance criteria.',
      },
      subTasks: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true },
            title: { type: 'string', required: true },
            description: { type: 'string', required: true },
            dependsOn: { type: 'array', required: true, items: { type: 'string' } },
            requiredSkills: { type: 'array', required: true, items: { type: 'string' } },
            preferredAgent: { type: 'string', enum: AGENT_KINDS },
            estimatedEffort: { type: 'string', required: true, enum: EFFORT_ENUM },
            acceptanceCriteria: { type: 'array', required: true, items: { type: 'string' } },
            status: { type: 'string', enum: SUBTASK_STATUS_ENUM },
          },
        },
        description: 'Independently verifiable subtasks; dependsOn edges must form a DAG.',
      },
      subTaskId: { type: 'string', description: 'Subtask to update for set-status.' },
      status: { type: 'string', enum: SUBTASK_STATUS_ENUM, description: 'New status for set-status.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          taskId: { type: 'string', required: true },
          goal: { type: 'string', required: true },
          subTasks: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                title: { type: 'string', required: true },
                status: { type: 'string', required: true },
                dependsOn: { type: 'array', required: true, items: { type: 'string' } },
              },
            },
          },
          readyToStart: { type: 'array', required: true, items: { type: 'string' }, description: 'Pending subtasks whose dependencies are all complete.' },
          cycleDetected: { type: 'boolean', required: true, description: 'True when dependsOn edges are not a DAG.' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `${value.subTasks.length} subtask(s); ready: ${value.readyToStart.join(', ') || 'none'}${value.cycleDetected ? '; DEPENDENCY CYCLE' : ''}`,
      }],
    },
    async execute(args, exec) {
      requireAgent(exec)
      const now = Date.now()
      if (args.action === 'read') {
        const plan = await ctx.supervisor.plans.read(args.taskId)
        if (!plan) throw new Error(`no plan for task "${args.taskId}"`)
        return planResult(plan)
      }
      const existing = await ctx.supervisor.plans.read(args.taskId)
      if (args.action === 'set-status') {
        if (!existing) throw new Error(`no plan for task "${args.taskId}"; write the plan first`)
        if (args.subTaskId === undefined || args.status === undefined) {
          throw new Error('set-status needs subTaskId and status')
        }
        const updated = {
          ...existing,
          subTasks: existing.subTasks.map(subTask => (
            subTask.id === args.subTaskId ? { ...subTask, status: args.status as SubTaskStatus } : subTask
          )),
          updatedAt: now,
        }
        return planResult(updated, await ctx.supervisor.plans.write(updated))
      }
      if (args.goal === undefined) throw new Error('write needs a goal')
      const subTasks: SubTask[] = (args.subTasks ?? []).map(subTask => ({
        id: subTask.id,
        title: subTask.title,
        description: subTask.description,
        dependsOn: [...subTask.dependsOn],
        requiredSkills: [...subTask.requiredSkills],
        ...subTask.preferredAgent === undefined ? {} : { preferredAgent: subTask.preferredAgent },
        estimatedEffort: subTask.estimatedEffort,
        acceptanceCriteria: [...subTask.acceptanceCriteria],
        status: subTask.status ?? 'pending',
      }))
      assertKnownDependencies(subTasks)
      const plan = {
        taskId: args.taskId,
        goal: args.goal,
        constraints: [...(args.constraints ?? [])],
        acceptanceCriteria: (args.acceptanceCriteria ?? []).map(criterion => ({
          id: criterion.id,
          description: criterion.description,
          verificationMethod: criterion.verificationMethod,
          ...criterion.verificationSpec === undefined ? {} : { verificationSpec: stringRecord(criterion.verificationSpec) },
          status: criterion.status ?? 'pending',
        })),
        subTasks,
        integrationStrategy: args.integrationStrategy ?? 'sequential-merge',
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      }
      return planResult(plan, await ctx.supervisor.plans.write(plan))
    },
    presentCall: args => ({ card: 'generic', title: `Plan ${args.action}: ${args.taskId}`, kind: 'other' }),
  }))
}

/** The tool's view of one stored plan. */
function planResult(plan: TaskPlan, path: string = '') {
  return {
    path,
    taskId: plan.taskId,
    goal: plan.goal,
    subTasks: plan.subTasks.map(subTask => ({
      id: subTask.id,
      title: subTask.title,
      status: subTask.status,
      dependsOn: subTask.dependsOn,
    })),
    readyToStart: readySubTasks(plan.subTasks),
    cycleDetected: hasCycle(plan.subTasks),
  }
}

/** Pending subtasks whose dependencies are all complete. */
function readySubTasks(subTasks: readonly SubTask[]): string[] {
  const completed = new Set(subTasks.filter(subTask => subTask.status === 'completed').map(subTask => subTask.id))
  return subTasks
    .filter(subTask => subTask.status === 'pending' && subTask.dependsOn.every(dependency => completed.has(dependency)))
    .map(subTask => subTask.id)
}

/** Reject a plan whose dependencies do not form a DAG. */
function hasCycle(subTasks: readonly SubTask[]): boolean {
  const byId = new Map(subTasks.map(subTask => [subTask.id, subTask]))
  const state = new Map<string, 'visiting' | 'done'>()
  const visit = (id: string): boolean => {
    const current = state.get(id)
    if (current === 'visiting') return true
    if (current === 'done') return false
    state.set(id, 'visiting')
    for (const dependency of byId.get(id)?.dependsOn ?? []) {
      if (visit(dependency)) return true
    }
    state.set(id, 'done')
    return false
  }
  return subTasks.some(subTask => visit(subTask.id))
}

/** Fail loud when a subtask depends on an id the plan does not define. */
function assertKnownDependencies(subTasks: readonly SubTask[]): void {
  const ids = new Set(subTasks.map(subTask => subTask.id))
  for (const subTask of subTasks) {
    for (const dependency of subTask.dependsOn) {
      if (!ids.has(dependency)) {
        throw new Error(`subtask "${subTask.id}" depends on unknown subtask "${dependency}"`)
      }
    }
    if (subTask.dependsOn.includes(subTask.id)) {
      throw new Error(`subtask "${subTask.id}" depends on itself`)
    }
  }
}

/** Keep only string-valued entries of a model-supplied record. */
function stringRecord(value: Record<string, unknown>): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') result[key] = entry
  }
  return result
}
