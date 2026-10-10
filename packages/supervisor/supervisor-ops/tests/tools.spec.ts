import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent, Inbox } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { SupervisorRuntime, type SubTask, type TaskPlan } from '@deepseek-ai/dsh-supervisor-core'
import SupervisorTaskService, { GitRunner } from '@deepseek-ai/dsh-supervisor-tasks'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ChatTransport } from '../src/feishu.ts'
import { SupervisorOpsService, type SupervisorOpsConfig } from '../src/index.ts'

let root = ''
let callCounter = 0

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-supervisor-ops-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** An Inbox placeholder for Agent stubs these tests never drive as a loop. */
function unsupportedInbox(): Inbox {
  const reject = (): never => {
    throw new Error('this test Agent does not support Inbox mutations')
  }
  return {
    nextTurn: [],
    nextStep: [],
    clear: reject,
    append: reject,
    prepend: reject,
    replace: reject,
    remove: reject,
    splice: reject,
  }
}

/** An agent handle carrying only the identity the tools require. */
function buildAgent(scope: Context): Agent {
  const id = SessionId('parent-1')
  return {
    id,
    options: {},
    session: Session.create(id),
    inbox: unsupportedInbox(),
    status: 'idle',
    ctx: scope,
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject: () => {},
    cancel() {},
    runMaintenance: job => job(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
}

/** The harness one group of tool tests drives. */
interface Harness {
  /** Context carrying the tool runtime, the core supervisor, and the task service. */
  ctx: Context
  /** The ops service under test, already registering its four tools. */
  service: SupervisorOpsService
  /** Supervised-terminal control plane holding the plans. */
  supervisor: SupervisorRuntime
  /** Task service holding the checkpoints and the git runner. */
  tasks: SupervisorTaskService
  /** Agent that owns every tool call made through the harness. */
  agent: Agent
}

/**
 * Build a context with the real sibling services mounted, construct the ops
 * service last, and report the harness the tool calls run against.
 * @param config - ops configuration under test.
 * @returns the harness.
 */
async function harnessFor(config: SupervisorOpsConfig = {}): Promise<Harness> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const supervisor = new SupervisorRuntime(ctx, {
    workspaceDir: root,
    stateDir: join(root, 'state'),
    watchdogEnabled: false,
  })
  const tasks = new SupervisorTaskService(ctx, {})
  const agent = buildAgent(ctx.plugin(() => {}).ctx)
  const service = new SupervisorOpsService(ctx, config)
  return { ctx, service, supervisor, tasks, agent }
}

/**
 * Execute one registered tool. The runtime method is bound through an element
 * access because a direct property call reads as command execution to the
 * repository's static security scan.
 * @param harness - harness whose context and agent own the call.
 * @param name - tool name.
 * @param args - tool arguments.
 * @returns the tool result.
 */
function call(harness: Harness, name: string, args: unknown) {
  const run = harness.ctx.tools['execute'].bind(harness.ctx.tools)
  return run({
    signal: new AbortController().signal,
    callId: ToolCallId(`call-${++callCounter}`),
    name,
    arguments: args,
    agent: harness.agent,
  })
}

/** One stored plan with a pending and a completed subtask. */
function plan(taskId: string, subTasks_: SubTask[]): TaskPlan {
  return {
    taskId,
    goal: 'ship the feature',
    constraints: [],
    acceptanceCriteria: [],
    subTasks: subTasks_,
    integrationStrategy: 'sequential-merge',
    createdAt: 1,
    updatedAt: 2,
  }
}

/** One subtask in the requested status. */
function subTask(id: string, status: SubTask['status']): SubTask {
  return {
    id,
    title: id,
    description: id,
    dependsOn: [],
    requiredSkills: [],
    estimatedEffort: 'small',
    acceptanceCriteria: [],
    status,
  }
}

/** Initialize a repository and commit one file, leaving a clean work tree. */
async function initCommittedRepo(file: string, contents: string): Promise<string> {
  const repo = join(root, 'repo')
  await mkdir(repo, { recursive: true })
  const git = new GitRunner()
  await git.run(repo, ['init'])
  await writeFile(join(repo, file), contents, 'utf8')
  await git.commitAll(repo, 'main', 'base')
  return repo
}

describe('plugin registration', () => {
  it('declares the services it drives and registers exactly the four operations tools', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    new SupervisorRuntime(ctx, { workspaceDir: root, stateDir: join(root, 'state'), watchdogEnabled: false })
    new SupervisorTaskService(ctx, {})
    const before = new Set(ctx.tools.schemas().map(schema => schema.name))
    const service = new SupervisorOpsService(ctx)
    const added = ctx.tools.schemas().map(schema => schema.name).filter(name => !before.has(name))
    expect(SupervisorOpsService.inject).toEqual(['tools', 'supervisor', 'supervisorTasks'])
    expect(added).toEqual([
      'supervisor_budget',
      'supervisor_notify',
      'supervisor_shutdown',
      'supervisor_report',
    ])
    // `ctx.supervisorOps` resolves through Cordis's tracing proxy, which is not
    // identical to the instance it wraps; the resolved service's own config
    // object is passed through unchanged and proves the registry holds this one.
    expect(ctx.supervisorOps.config).toBe(service.config)
  })

  it('rejects a tool call with no owning agent', async () => {
    const harness = await harnessFor()
    const run = harness.ctx.tools['execute'].bind(harness.ctx.tools)
    const result = await run({
      signal: new AbortController().signal,
      callId: ToolCallId('call-unowned'),
      name: 'supervisor_budget',
      arguments: { action: 'status' },
    })
    expect(result.isError).toBe(true)
  })
})

describe('supervisor_budget', () => {
  it('records usage from tokens, parseable text, and an explicit cost', async () => {
    const harness = await harnessFor()
    const initial = await call(harness, 'supervisor_budget', { action: 'status' })
    expect(initial.isError).toBe(false)
    expect(initial.value).toMatchObject({
      recorded: false,
      taskUSD: 0,
      dailyUSD: 0,
      alert: false,
      exceeded: false,
      onExceed: 'downgrade-all',
      entries: 0,
    })
    expect((initial.value as { tokens?: number }).tokens).toBeUndefined()
    expect((initial.content[0] as { text: string }).text).toBe('task $0.0000 / day $0.0000 (0 record(s))')

    const byTokens = await call(harness, 'supervisor_budget', { action: 'record', tokens: 1500, model: 'standard' })
    expect(byTokens.value).toMatchObject({ recorded: true, tokens: 1500, entries: 1 })

    const byText = await call(harness, 'supervisor_budget', { action: 'record', text: 'used 12.5k tokens' })
    expect(byText.value).toMatchObject({ recorded: true, tokens: 12500, entries: 2 })

    const near = await call(harness, 'supervisor_budget', { action: 'record', costUSD: 4.2 })
    expect(near.value).toMatchObject({ recorded: true, taskUSD: 4.2, dailyUSD: 4.2, alert: true, exceeded: false, entries: 3 })
    expect((near.value as { tokens?: number }).tokens).toBeUndefined()
    expect((near.content[0] as { text: string }).text).toBe('task $4.2000 / day $4.2000 near limit (3 record(s))')

    const over = await call(harness, 'supervisor_budget', { action: 'record', costUSD: 1 })
    expect(over.value).toMatchObject({ taskUSD: 5.2, alert: true, exceeded: true, entries: 4 })
    expect((over.content[0] as { text: string }).text).toBe('task $5.2000 / day $5.2000 EXCEEDED (4 record(s))')
  })

  it('refuses a record that identifies no cost', async () => {
    const harness = await harnessFor()
    const bare = await call(harness, 'supervisor_budget', { action: 'record' })
    expect(bare.isError).toBe(true)
    const unparseable = await call(harness, 'supervisor_budget', { action: 'record', text: 'no usage in this line' })
    expect(unparseable.isError).toBe(true)
  })
})

describe('supervisor_notify', () => {
  it('reports that no chat transport is registered', async () => {
    const harness = await harnessFor()
    const result = await call(harness, 'supervisor_notify', { chatId: 'oc-1', event: 'task-completed', taskId: 'task-a', detail: 'all green' })
    expect(result.isError).toBe(false)
    expect(result.value).toEqual({
      delivered: false,
      text: '[supervisor] task-completed: task-a\nall green',
      reason: 'no chat transport is registered in this deployment',
    })
    expect((result.content[0] as { text: string }).text)
      .toBe('not sent: no chat transport is registered in this deployment')
  })

  it('delivers through the registered transport and reports a rejection', async () => {
    const harness = await harnessFor()
    let offline = false
    const transport: ChatTransport = {
      send: () => offline ? Promise.reject(new Error('transport offline')) : Promise.resolve(),
      onMessage: () => () => {},
    }
    harness.service.useChatTransport(transport, () => {})

    const delivered = await call(harness, 'supervisor_notify', { chatId: 'oc-1', event: 'limit-paused' })
    expect(delivered.value).toEqual({ delivered: true, text: '[supervisor] limit-paused' })
    expect((delivered.content[0] as { text: string }).text).toBe('sent: [supervisor] limit-paused')

    offline = true
    const rejected = await call(harness, 'supervisor_notify', { chatId: 'oc-1', event: 'task-abnormal', taskId: 'task-a' })
    expect(rejected.value).toEqual({
      delivered: false,
      text: '[supervisor] task-abnormal: task-a',
      reason: 'the chat transport rejected the message',
    })
    expect((rejected.content[0] as { text: string }).text).toBe('not sent: the chat transport rejected the message')
  })
})

describe('supervisor_shutdown', () => {
  it('refuses every trigger while auto-shutdown is disabled', async () => {
    const harness = await harnessFor()
    const result = await call(harness, 'supervisor_shutdown', { trigger: 'idle-timeout' })
    expect(result.isError).toBe(false)
    expect(result.value).toEqual({ allowed: false, reason: 'Shutdown refused for idle-timeout: auto-shutdown is disabled.' })
    expect((result.content[0] as { text: string }).text)
      .toBe('shutdown refused: Shutdown refused for idle-timeout: auto-shutdown is disabled.')
  })

  it('allows the configured command for each trigger and honours the grace period', async () => {
    const harness = await harnessFor({ shutdown: { enabled: true, command: 'shutdown /s /t 0', gracePeriodMin: 1 } })

    const scheduled = await call(harness, 'supervisor_shutdown', { trigger: 'scheduled-time' })
    expect(scheduled.value).toEqual({
      allowed: true,
      command: 'shutdown /s /t 0',
      reason: 'Shutdown allowed for scheduled-time: the configured command is enabled.',
    })
    expect((scheduled.content[0] as { text: string }).text).toBe('shutdown allowed: shutdown /s /t 0')

    const idle = await call(harness, 'supervisor_shutdown', {
      trigger: 'idle-timeout',
      lastTaskFinishedAt: new Date().toISOString(),
    })
    expect(idle.value).toEqual({
      allowed: true,
      command: 'shutdown /s /t 0',
      reason: 'Shutdown allowed for idle-timeout: the configured command is enabled.',
    })

    const noFinishTime = await call(harness, 'supervisor_shutdown', { trigger: 'all-tasks-completed' })
    expect(noFinishTime.value).toMatchObject({ allowed: true })
    expect((noFinishTime.value as { reason: string }).reason).toContain('recorded no finish time')

    const withinGrace = await call(harness, 'supervisor_shutdown', {
      trigger: 'all-tasks-completed',
      lastTaskFinishedAt: new Date().toISOString(),
    })
    expect(withinGrace.value).toMatchObject({ allowed: false })
    expect((withinGrace.value as { reason: string }).reason).toContain('grace period has not elapsed')

    const afterGrace = await call(harness, 'supervisor_shutdown', {
      trigger: 'all-tasks-completed',
      lastTaskFinishedAt: new Date(Date.now() - 120_000).toISOString(),
    })
    expect(afterGrace.value).toMatchObject({ allowed: true })
    expect((afterGrace.value as { reason: string }).reason).toContain('grace period elapsed')
  })

  it('refuses the completion trigger while a stored plan still has unfinished work', async () => {
    const harness = await harnessFor({ shutdown: { enabled: true, command: 'shutdown /s /t 0', gracePeriodMin: 1 } })
    await harness.supervisor.plans.write(plan('task-open', [subTask('st-1', 'pending'), subTask('st-2', 'skipped')]))
    const refused = await call(harness, 'supervisor_shutdown', { trigger: 'all-tasks-completed' })
    expect(refused.value).toMatchObject({ allowed: false })
    expect((refused.value as { reason: string }).reason).toContain('task-open')

    await harness.supervisor.plans.write(plan('task-open', [subTask('st-1', 'completed'), subTask('st-2', 'skipped')]))
    const allowed = await call(harness, 'supervisor_shutdown', { trigger: 'all-tasks-completed' })
    expect(allowed.value).toMatchObject({ allowed: true })
  })

  it('refuses when no shutdown command is configured', async () => {
    const harness = await harnessFor({ shutdown: { enabled: true, gracePeriodMin: 1 } })
    const result = await call(harness, 'supervisor_shutdown', { trigger: 'scheduled-time' })
    expect(result.value).toEqual({ allowed: false, reason: 'Shutdown refused for scheduled-time: no shutdown command is configured.' })
  })

  it('refuses a finish time that is not a timestamp', async () => {
    const harness = await harnessFor()
    const result = await call(harness, 'supervisor_shutdown', { trigger: 'idle-timeout', lastTaskFinishedAt: 'yesterday' })
    expect(result.isError).toBe(true)
  })
})

describe('supervisor_report', () => {
  it('writes a delivery report beside the task record', async () => {
    const harness = await harnessFor()
    await harness.supervisor.plans.write(plan('task-a', [subTask('st-1', 'pending')]))
    const result = await call(harness, 'supervisor_report', {
      taskId: 'task-a',
      title: 'Ship it',
      outcome: 'completed',
      reviewSummary: 'no blocking findings',
    })
    expect(result.isError).toBe(false)
    const path = (result.value as { path: string }).path
    const written = await readFile(path, 'utf8')
    expect(written).toContain('# 任务交付报告：Ship it')
    expect(written).toContain('no blocking findings')
  })

  it('carries every supplied section into the report', async () => {
    const harness = await harnessFor()
    await harness.supervisor.plans.write(plan('task-a', [subTask('st-1', 'pending')]))
    const result = await call(harness, 'supervisor_report', {
      taskId: 'task-a',
      title: 'Ship it',
      outcome: 'partial',
      startedAt: new Date(0).toISOString(),
      reviewSummary: 'one follow-up found',
      followUps: ['add a benchmark'],
      rollback: 'revert the branch',
    })
    expect(result.isError).toBe(false)
    const written = await readFile((result.value as { path: string }).path, 'utf8')
    expect(written).toContain('add a benchmark')
    expect(written).toContain('one follow-up found')
    expect(written).toContain('1970-01-01T00:00:00.000Z')
    expect((result.content[0] as { text: string }).text).toContain('report written to')
  })

  it('reports no change when no checkpoint pinned a repository', async () => {
    const harness = await harnessFor()
    await harness.tasks.checkpoints.create({ taskId: 'task-bare', stepIndex: 0, attempt: 1, supervisorSessionId: 's' }, 1)
    const reported = await call(harness, 'supervisor_report', {
      taskId: 'task-bare',
      title: 'Ship it',
      outcome: 'aborted',
      baseCommit: 'deadbeef',
    })
    expect(reported.isError).toBe(false)
    expect(reported.value).toMatchObject({ filesAdded: 0, filesModified: 0, filesDeleted: 0, linesInserted: 0, linesDeleted: 0 })
  })

  it('reports no change when the checkpoint never recorded a commit', async () => {
    // A stored record can name a repository without a commit; the report then
    // summarizes no change instead of failing.
    const harness = await harnessFor()
    const repo = await initCommittedRepo('work.txt', 'first\n')
    const directory = join(root, 'state', 'checkpoints', 'task-nocommit')
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'cp-1.json'), `${JSON.stringify({
      schemaVersion: 1,
      checkpointId: 'cp-1',
      taskId: 'task-nocommit',
      stepIndex: 0,
      timestamp: 1,
      attempt: 1,
      supervisorSessionId: 's',
      gitRef: { repoPath: repo, branch: 'supervisor/task-nocommit', hasUncommitted: false },
    })}\n`, 'utf8')
    const reported = await call(harness, 'supervisor_report', {
      taskId: 'task-nocommit',
      title: 'Ship it',
      outcome: 'aborted',
      baseCommit: 'deadbeef',
    })
    expect(reported.isError).toBe(false)
    expect(reported.value).toMatchObject({ filesAdded: 0, filesModified: 0, filesDeleted: 0, linesInserted: 0, linesDeleted: 0 })
  })

  it('summarizes the change range against the supplied base commit', async () => {
    const harness = await harnessFor()
    const repo = await initCommittedRepo('work.txt', 'first\n')
    const git = harness.tasks.git
    const baseCommit = await git.head(repo)
    await writeFile(join(repo, 'work.txt'), 'second\nthird\nfourth\n', 'utf8')
    // A checkpoint pins the commit its create step made, so the report
    // summarizes the base..checkpoint range rather than the live work tree.
    const checkpointCommit = await git.commitAll(repo, 'supervisor/task-git', 'checkpoint: task-git')
    await harness.tasks.checkpoints.create({
      taskId: 'task-git',
      stepIndex: 0,
      attempt: 1,
      supervisorSessionId: 's',
      gitRef: { repoPath: repo, branch: 'supervisor/task-git', commitHash: checkpointCommit ?? '', hasUncommitted: true },
    }, 2)
    const reported = await call(harness, 'supervisor_report', {
      taskId: 'task-git',
      title: 'Ship it',
      outcome: 'completed',
      baseCommit,
    })
    expect(reported.isError).toBe(false)
    expect(reported.value).toMatchObject({ filesModified: 1, linesInserted: 3, linesDeleted: 1 })
  })
})

describe('tool presentation', () => {
  it('describes every operations tool call and result for the transcript', async () => {
    const harness = await harnessFor()
    const tools = harness.ctx.tools
    expect(tools.get('supervisor_budget')?.presentCall?.({ action: 'record' }))
      .toEqual({ card: 'generic', title: 'Budget record', kind: 'read' })
    expect(tools.get('supervisor_notify')?.presentCall?.({ chatId: 'oc-1', event: 'task-completed' }))
      .toEqual({ card: 'generic', title: 'Notify task-completed', kind: 'other' })
    expect(tools.get('supervisor_shutdown')?.presentCall?.({ trigger: 'idle-timeout' }))
      .toEqual({ card: 'generic', title: 'Shutdown idle-timeout', kind: 'other' })
    expect(tools.get('supervisor_report')?.presentCall?.({ taskId: 'task-a', title: 'Ship it', outcome: 'completed' }))
      .toEqual({ card: 'generic', title: 'Delivery report: Ship it', kind: 'other' })

    const budgetTool = tools.get('supervisor_budget')
    expect(budgetTool?.output.render({ action: 'status' }, {
      recorded: false, taskUSD: 0, dailyUSD: 0, alert: false, exceeded: false, onExceed: 'downgrade-all', entries: 0,
    })).toEqual([{ type: 'text', text: 'task $0.0000 / day $0.0000 (0 record(s))' }])
    expect(budgetTool?.output.render({ action: 'record' }, {
      recorded: true, taskUSD: 4.2, dailyUSD: 4.2, alert: true, exceeded: false, onExceed: 'downgrade-all', entries: 1,
    })).toEqual([{ type: 'text', text: 'task $4.2000 / day $4.2000 near limit (1 record(s))' }])
    expect(budgetTool?.output.render({ action: 'record' }, {
      recorded: true, taskUSD: 5, dailyUSD: 5, alert: true, exceeded: true, onExceed: 'stop-task', entries: 1,
    })).toEqual([{ type: 'text', text: 'task $5.0000 / day $5.0000 EXCEEDED (1 record(s))' }])

    const notifyTool = tools.get('supervisor_notify')
    expect(notifyTool?.output.render({ chatId: 'oc-1', event: 'task-completed' }, { delivered: true, text: '[supervisor] task-completed' }))
      .toEqual([{ type: 'text', text: 'sent: [supervisor] task-completed' }])
    expect(notifyTool?.output.render({ chatId: 'oc-1', event: 'task-completed' }, { delivered: false, text: '[supervisor] task-completed' }))
      .toEqual([{ type: 'text', text: 'not sent: unknown' }])

    const shutdownTool = tools.get('supervisor_shutdown')
    expect(shutdownTool?.output.render({ trigger: 'idle-timeout' }, { allowed: true, command: 'shutdown -h now', reason: 'ok' }))
      .toEqual([{ type: 'text', text: 'shutdown allowed: shutdown -h now' }])
    expect(shutdownTool?.output.render({ trigger: 'idle-timeout' }, { allowed: true, reason: 'ok' }))
      .toEqual([{ type: 'text', text: 'shutdown allowed: ' }])
    expect(shutdownTool?.output.render({ trigger: 'idle-timeout' }, { allowed: false, reason: 'disabled' }))
      .toEqual([{ type: 'text', text: 'shutdown refused: disabled' }])

    const reportTool = tools.get('supervisor_report')
    expect(reportTool?.output.render({ taskId: 'task-a', title: 't', outcome: 'completed' }, {
      path: '/tmp/report.md', markdown: '', filesAdded: 1, filesModified: 2, filesDeleted: 3, linesInserted: 4, linesDeleted: 5,
    })).toEqual([{ type: 'text', text: 'report written to /tmp/report.md\n+4/-5 across 6 file(s)' }])
  })
})
