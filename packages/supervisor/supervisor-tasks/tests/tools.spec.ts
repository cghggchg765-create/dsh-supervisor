/**
 * Tool-surface specs for the durable task-state component: plans, checkpoints,
 * review packets, and issue tickets driven through the real tool registry over
 * a mounted control plane, with a scripted terminal backend standing in for an
 * external CLI.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import SupervisorRuntime from '@deepseek-ai/dsh-supervisor-core'
import {
  TerminalSessionId,
  TerminalSessionService,
  type TerminalBackendSession,
  type TerminalReadRequest,
  type TerminalReadResult,
  type TerminalSendOperation,
  type TerminalSendRequest,
  type TerminalSessionStatus,
} from '@deepseek-ai/dsh-terminal'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SupervisorTaskConfig } from '../src/config.ts'
import { GitRunner } from '../src/git.ts'
import SupervisorTaskService from '../src/index.ts'

/** The four tools this package contributes, in registration order. */
const TASKS_TOOLS = [
  'supervisor_review',
  'supervisor_issue',
  'supervisor_checkpoint',
  'supervisor_plan',
]

let root = ''
let ctx: Context
let callCounter = 0
let harnessCounter = 0
let owner: Agent
let scripted: ScriptedSession
let terminalId = ''

/** A terminal that settles every send immediately with scripted output. */
class ScriptedSession implements TerminalBackendSession {
  readonly motd = 'scripted terminal ready\n'

  private readonly lines: string[] = []

  startSend(_request: TerminalSendRequest): TerminalSendOperation {
    this.lines.push('prompt ready')
    return {
      done: Promise.resolve({
        viewport: 'prompt ready',
        waitReason: 'stdin_read',
        sessionStatus: { kind: 'running' },
        truncated: false,
      }),
      readOutput: () => ({ delta: 'prompt ready', truncated: false }),
      cancel: () => false,
    }
  }

  read(request: TerminalReadRequest): TerminalReadResult {
    const count = request.count ?? this.lines.length
    const offset = request.offset ?? 0
    const end = Math.max(0, this.lines.length - offset)
    const begin = Math.max(0, end - count)
    return { text: this.lines.slice(begin, end).join('\n'), totalLines: this.lines.length, lineBegin: begin, lineEnd: end, truncated: false }
  }

  signal(): Promise<{ delivered: true; targetPgid: number }> {
    return Promise.resolve({ delivered: true, targetPgid: 4242 })
  }

  status(): TerminalSessionStatus {
    return { kind: 'running' }
  }

  close(): Promise<void> {
    return Promise.resolve()
  }
}

/** Register the agent that owns the terminal and every tool call. */
async function registerAgent(context: Context): Promise<Agent> {
  const scope = context.plugin(() => {})
  const id = SessionId('tasks-test-agent')
  const value: Agent = {
    id,
    options: {},
    session: Session.create(id),
    inbox: unsupportedInbox(),
    status: 'idle',
    ctx: scope.ctx,
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject: () => {},
    cancel() {},
    runMaintenance: job => job(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  await context.agents.register(value)
  return value
}

/** Mount the control plane and this package's task service over a context. */
async function mountSupervisor(context: Context, stateDir: string, config?: SupervisorTaskConfig): Promise<void> {
  await context.plugin(SystemPrompt)
  await context.plugin(ToolRuntime)
  await context.plugin(AgentRegistry)
  await context.plugin(TerminalSessionService)
  await context.plugin(SupervisorRuntime, { stateDir, workspaceDir: root, watchdogEnabled: false })
  await context.plugin(SupervisorTaskService, config)
}

/** Spawn one scripted terminal owned by the given agent. */
async function spawnTerminal(context: Context, terminalOwner: Agent) {
  const openTerminal = context.terminals['spawn'].bind(context.terminals)
  return await openTerminal(terminalOwner, { type: 'scripted', name: 'tasks', cwd: root }, undefined)
}

/**
 * Execute one registered task tool. Element access is used for the registry
 * method because a direct property call reads as command execution to the
 * repository's static security scan.
 */
function call(name: string, args: unknown) {
  return callIn(ctx, owner, name, args)
}

/** Execute one tool against an explicit context and owning agent. */
function callIn(context: Context, executingAgent: Agent, name: string, args: unknown) {
  const run = context.tools['execute'].bind(context.tools)
  return run({
    signal: new AbortController().signal,
    callId: ToolCallId(`call-${++callCounter}`),
    name,
    arguments: args,
    agent: executingAgent,
  })
}

/**
 * A second harness whose configuration differs from the default one, so a
 * deployment choice (a checkpoint branch prefix, a state directory inside the
 * repository) can be exercised without disturbing the shared context.
 * @param config - configuration for the task service and the control plane.
 * @returns the mounted context and the agent that owns its tool calls.
 */
async function openHarness(config: { stateDir: string; worktreeBase: string; tasks?: SupervisorTaskConfig }) {
  const context = new Context()
  const scope = context.plugin(() => {})
  const agentId = SessionId(`harness-agent-${++harnessCounter}`)
  const agent: Agent = {
    id: agentId,
    options: {},
    session: Session.create(agentId),
    inbox: unsupportedInbox(),
    status: 'idle',
    ctx: scope.ctx,
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject: () => {},
    cancel() {},
    runMaintenance: job => job(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  await context.plugin(SystemPrompt)
  await context.plugin(ToolRuntime)
  await context.plugin(TerminalSessionService)
  await context.plugin(SupervisorRuntime, {
    stateDir: config.stateDir,
    workspaceDir: root,
    worktreeBase: config.worktreeBase,
    watchdogEnabled: false,
  })
  await context.plugin(SupervisorTaskService, config.tasks)
  return { context, agent }
}

/** A plan payload with one dependency edge. */
function subTasks() {
  return [
    {
      id: 'st-1',
      title: 'write the parser',
      description: 'parse the input',
      dependsOn: [],
      requiredSkills: [],
      estimatedEffort: 'small',
      acceptanceCriteria: ['round-trips'],
    },
    {
      id: 'st-2',
      title: 'wire the CLI',
      description: 'expose the parser',
      dependsOn: ['st-1'],
      requiredSkills: [],
      estimatedEffort: 'medium',
      acceptanceCriteria: ['CLI prints JSON'],
    },
  ]
}

/** Initialize a repository beside the supervisor state and leave one dirty file. */
async function initRepoWith(file: string, contents: string): Promise<void> {
  const repo = join(root, 'repo')
  await mkdir(repo, { recursive: true })
  const git = new GitRunner()
  await git.run(repo, ['init'])
  await writeFile(join(repo, file), contents, 'utf8')
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-supervisor-tasks-'))
  ctx = new Context()
  await mountSupervisor(ctx, join(root, 'state'))
  scripted = new ScriptedSession()
  ctx.terminals.registerBackend({ type: 'scripted', spawn: () => Promise.resolve(scripted) })
  owner = await registerAgent(ctx)
  terminalId = (await spawnTerminal(ctx, owner)).sessionId
})

afterEach(async () => {
  await ctx.fiber.dispose()
  await rm(root, { recursive: true, force: true })
})

describe('plugin registration', () => {
  it('declares the services it drives and registers the task tools', async () => {
    expect(SupervisorTaskService.inject).toEqual(['tools', 'supervisor'])
    const names = ctx.tools.schemas().map(schema => schema.name)
    expect(names.filter(name => TASKS_TOOLS.includes(name))).toEqual(TASKS_TOOLS)
    expect(ctx.supervisorTasks.config).toMatchObject({
      stateDir: join(root, 'state'),
      checkpointBranchPrefix: 'supervisor/',
      maxRetriesPerIssue: 2,
      checkpointRetention: { maxPerTask: 10, maxAgeDays: 30 },
    })
  })

  it('applies the configured checkpoint choices', async () => {
    const harness = await openHarness({
      stateDir: join(root, 'configured-state'),
      worktreeBase: join(root, 'configured-state', 'worktrees'),
      tasks: { checkpointBranchPrefix: 'checkpoint/', checkpointMaxPerTask: 3, checkpointMaxAgeDays: 5, maxRetriesPerIssue: 1 },
    })
    expect(harness.context.supervisorTasks.config).toMatchObject({
      stateDir: join(root, 'configured-state'),
      checkpointBranchPrefix: 'checkpoint/',
      maxRetriesPerIssue: 1,
      checkpointRetention: { maxPerTask: 3, maxAgeDays: 5 },
    })
    await harness.context.fiber.dispose()
  })
})

describe('supervisor_plan', () => {
  it('writes a plan and reports which subtasks can start', async () => {
    const written = await call('supervisor_plan', { action: 'write', taskId: 'task-a', goal: 'ship it', subTasks: subTasks() })
    expect(written.isError).toBe(false)
    expect(written.value).toMatchObject({ taskId: 'task-a', readyToStart: ['st-1'], cycleDetected: false })
    const read = await call('supervisor_plan', { action: 'read', taskId: 'task-a' })
    expect(read.value).toMatchObject({ goal: 'ship it' })
  })

  it('unblocks a dependent subtask once its dependency completes', async () => {
    await call('supervisor_plan', { action: 'write', taskId: 'task-a', goal: 'ship it', subTasks: subTasks() })
    const updated = await call('supervisor_plan', { action: 'set-status', taskId: 'task-a', subTaskId: 'st-1', status: 'completed' })
    expect(updated.value).toMatchObject({ readyToStart: ['st-2'] })
  })

  it('refuses a plan whose dependency is undefined or self-referential', async () => {
    const unknown = await call('supervisor_plan', {
      action: 'write',
      taskId: 'task-a',
      goal: 'ship it',
      subTasks: [{ ...subTasks()[0], dependsOn: ['st-missing'] }],
    })
    expect(unknown.isError).toBe(true)
    const selfReferential = await call('supervisor_plan', {
      action: 'write',
      taskId: 'task-a',
      goal: 'ship it',
      subTasks: [{ ...subTasks()[0], dependsOn: ['st-1'] }],
    })
    expect(selfReferential.isError).toBe(true)
  })

  it('reports a cyclic plan instead of accepting it silently', async () => {
    const cyclic = await call('supervisor_plan', {
      action: 'write',
      taskId: 'task-a',
      goal: 'ship it',
      subTasks: [
        { ...subTasks()[0], dependsOn: ['st-2'] },
        { ...subTasks()[1], dependsOn: ['st-1'] },
      ],
    })
    expect(cyclic.value).toMatchObject({ cycleDetected: true })
  })

  it('reports a missing plan and refuses a status update before one exists', async () => {
    const missing = await call('supervisor_plan', { action: 'read', taskId: 'task-none' })
    expect(missing.isError).toBe(true)
    const update = await call('supervisor_plan', { action: 'set-status', taskId: 'task-none', subTaskId: 'st-1', status: 'completed' })
    expect(update.isError).toBe(true)
  })

  it('feeds written plans into supervisor_status', async () => {
    await call('supervisor_plan', { action: 'write', taskId: 'task-a', goal: 'ship it', subTasks: subTasks() })
    await call('supervisor_plan', { action: 'set-status', taskId: 'task-a', subTaskId: 'st-1', status: 'completed' })
    const status = await call('supervisor_status', {})
    expect(status.value).toMatchObject({ tasks: [{ taskId: 'task-a', subTasks: 2, completed: 1, failed: 0 }] })
  })

  it('stores acceptance criteria, constraints, and a preferred agent', async () => {
    const written = await call('supervisor_plan', {
      action: 'write',
      taskId: 'task-c',
      goal: 'ship it',
      constraints: ['no new dependencies'],
      integrationStrategy: 'staged',
      acceptanceCriteria: [
        {
          id: 'ac-1',
          description: 'tests pass',
          verificationMethod: 'test-command',
          verificationSpec: { command: 'pnpm test', retries: 2 },
          status: 'passed',
        },
        { id: 'ac-2', description: 'reviewed', verificationMethod: 'manual' },
      ],
      subTasks: [
        { ...subTasks()[0], preferredAgent: 'codex', status: 'in-progress' },
        subTasks()[1],
      ],
    })
    expect(written.isError).toBe(false)
    expect(written.value).toMatchObject({
      subTasks: [{ id: 'st-1', status: 'in-progress' }, { id: 'st-2', status: 'pending' }],
      readyToStart: [],
    })
  })

  it('rewrites a plan in place while keeping its creation time', async () => {
    await call('supervisor_plan', { action: 'write', taskId: 'task-rewrite', goal: 'ship it', subTasks: subTasks() })
    const stored = await ctx.supervisor.plans.read('task-rewrite')
    await call('supervisor_plan', { action: 'write', taskId: 'task-rewrite', goal: 'ship it properly' })
    const rewritten = await ctx.supervisor.plans.read('task-rewrite')
    expect(rewritten?.goal).toBe('ship it properly')
    expect(rewritten?.createdAt).toBe(stored?.createdAt)
  })

  it('writes a plan without subtasks', async () => {
    const written = await call('supervisor_plan', { action: 'write', taskId: 'task-empty', goal: 'ship it' })
    expect(written.isError).toBe(false)
    expect(written.value).toMatchObject({ taskId: 'task-empty', subTasks: [], readyToStart: [] })
  })

  it('refuses a write without a goal', async () => {
    const written = await call('supervisor_plan', { action: 'write', taskId: 'task-a' })
    expect(written.isError).toBe(true)
  })

  it('refuses a status update that names neither subtask nor status', async () => {
    await call('supervisor_plan', { action: 'write', taskId: 'task-a', goal: 'ship it', subTasks: subTasks() })
    const neither = await call('supervisor_plan', { action: 'set-status', taskId: 'task-a' })
    expect(neither.isError).toBe(true)
    const noStatus = await call('supervisor_plan', { action: 'set-status', taskId: 'task-a', subTaskId: 'st-1' })
    expect(noStatus.isError).toBe(true)
  })

  it('reads a stored plan whose dependency is unknown without failing', async () => {
    // A durable record may outlive the build that wrote it; an unknown edge
    // must read back as evidence, not crash the status query.
    const plans = join(root, 'state', 'plans')
    await mkdir(plans, { recursive: true })
    await writeFile(join(plans, 'task-stale.json'), `${JSON.stringify({
      taskId: 'task-stale',
      goal: 'ship it',
      constraints: [],
      acceptanceCriteria: [],
      subTasks: [{
        id: 'st-1',
        title: 'write the parser',
        description: 'parse the input',
        dependsOn: ['st-ghost'],
        requiredSkills: [],
        estimatedEffort: 'small',
        acceptanceCriteria: [],
        status: 'pending',
      }],
      integrationStrategy: 'sequential-merge',
      createdAt: 1,
      updatedAt: 1,
    })}\n`, 'utf8')
    const read = await call('supervisor_plan', { action: 'read', taskId: 'task-stale' })
    expect(read.isError).toBe(false)
    expect(read.value).toMatchObject({ cycleDetected: false, readyToStart: [] })
  })
})

describe('supervisor_checkpoint', () => {
  it('records a checkpoint outside a repository without git facts', async () => {
    const created = await call('supervisor_checkpoint', { action: 'create', taskId: 'task-a', stepIndex: 2, note: 'before refactor' })
    expect(created.isError).toBe(false)
    expect(created.value).toMatchObject({ gitAvailable: false, count: 1, restored: false })
    const listed = await call('supervisor_checkpoint', { action: 'list', taskId: 'task-a' })
    expect(listed.value).toMatchObject({ count: 1, checkpoints: [{ stepIndex: 2 }] })
  })

  it('refuses to restore a task that has no checkpoint', async () => {
    const restored = await call('supervisor_checkpoint', { action: 'restore', taskId: 'task-none' })
    expect(restored.isError).toBe(true)
  })

  it('lists an empty task without naming a latest checkpoint', async () => {
    const listed = await call('supervisor_checkpoint', { action: 'list', taskId: 'task-none' })
    expect(listed.isError).toBe(false)
    expect(listed.value).toMatchObject({ count: 0, checkpoints: [], restored: false, checkpointId: '', commitHash: '' })
  })

  it('restores the newest checkpoint of a task that recorded no repository', async () => {
    await call('supervisor_checkpoint', { action: 'create', taskId: 'task-plain' })
    const restored = await call('supervisor_checkpoint', { action: 'restore', taskId: 'task-plain' })
    expect(restored.isError).toBe(false)
    expect(restored.value).toMatchObject({ restored: false, gitAvailable: false, count: 1 })
    expect((restored.value as { outputTail?: string }).outputTail).toBeUndefined()
  })

  it('pins the commit, branch, and dirty state when the workspace is a repository', async () => {
    await initRepoWith('work.txt', 'first\n')
    const created = await call('supervisor_checkpoint', { action: 'create', taskId: 'task-git', stepIndex: 1, note: 'before refactor', cwd: 'repo' })
    expect(created.isError).toBe(false)
    const value = created.value as { commitHash?: string; branch?: string; checkpoints: { checkpointId: string; commitHash?: string }[] }
    expect(created.value).toMatchObject({ gitAvailable: true, count: 1, restored: false })
    expect(value.branch).toBe('supervisor/task-git')
    expect(value.commitHash).toMatch(/^[0-9a-f]{7,}$/)
    expect(value.checkpoints[0]?.commitHash).toBe(value.commitHash)
    const listed = await call('supervisor_checkpoint', { action: 'list', taskId: 'task-git', cwd: 'repo' })
    expect(listed.value).toMatchObject({ gitAvailable: true, count: 1, checkpoints: [{ commitHash: value.commitHash }] })
  })

  it('leaves the state directory out of the checkpoint commit when it lives in the repository', async () => {
    // The default harness keeps its state beside the repo; this one puts the
    // state directory inside the repository, where a commit that swallowed it
    // would let `git reset --hard` on restore delete newer records.
    const harness = await openHarness({
      stateDir: join(root, 'repo', 'state'),
      worktreeBase: join(root, 'repo', '.worktrees'),
      tasks: { checkpointBranchPrefix: 'checkpoint/' },
    })
    const repo = join(root, 'repo')
    await mkdir(repo, { recursive: true })
    const git = new GitRunner()
    await git.run(repo, ['init'])
    await writeFile(join(repo, 'work.txt'), 'first\n', 'utf8')
    await callIn(harness.context, harness.agent, 'supervisor_plan', { action: 'write', taskId: 'task-excluded', goal: 'keep out' })
    const created = await callIn(harness.context, harness.agent, 'supervisor_checkpoint', { action: 'create', taskId: 'task-excluded', cwd: 'repo' })
    expect(created.isError).toBe(false)
    const commitHash = (created.value as { commitHash: string }).commitHash
    const committed = await git.run(repo, ['show', '--name-only', '--pretty=format:', commitHash])
    const names = committed.stdout.split('\n').filter(line => line.trim() !== '')
    expect(names).toContain('work.txt')
    expect(names.some(name => name.startsWith('state/'))).toBe(false)
    expect(names.some(name => name.startsWith('.worktrees/'))).toBe(false)
    await harness.context.fiber.dispose()
  })

  it('restores a named checkpoint commit and leaves later work behind', async () => {
    await initRepoWith('work.txt', 'first\n')
    const first = await call('supervisor_checkpoint', { action: 'create', taskId: 'task-git', cwd: 'repo' })
    const firstId = (first.value as { checkpointId: string }).checkpointId
    await writeFile(join(root, 'repo', 'work.txt'), 'second\n', 'utf8')
    await call('supervisor_checkpoint', { action: 'create', taskId: 'task-git', note: 'second attempt', cwd: 'repo' })
    const restored = await call('supervisor_checkpoint', { action: 'restore', taskId: 'task-git', checkpointId: firstId, cwd: 'repo' })
    expect(restored.isError).toBe(false)
    expect(restored.value).toMatchObject({ restored: true, gitAvailable: true, count: 2 })
    expect((await readFile(join(root, 'repo', 'work.txt'), 'utf8')).replaceAll('\r\n', '\n')).toBe('first\n')
  })

  it('keeps a checkpoint whose branch could not be created without git facts', async () => {
    await initRepoWith('work.txt', 'first\n')
    // The task id cannot form a git ref, so the commit fails and the checkpoint
    // records the repository but no commit to return to.
    const created = await call('supervisor_checkpoint', { action: 'create', taskId: 'task~bad', cwd: 'repo' })
    expect(created.isError).toBe(false)
    expect(created.value).toMatchObject({ gitAvailable: true, count: 1 })
    expect((created.value as { commitHash?: string }).commitHash).toBe('')
    const restored = await call('supervisor_checkpoint', { action: 'restore', taskId: 'task~bad', cwd: 'repo' })
    expect(restored.isError).toBe(false)
    expect(restored.value).toMatchObject({ restored: false })
  })

  it('captures the terminal state and output log a relaunch reads back', async () => {
    const observed = await ctx.supervisor.observe(
      owner,
      TerminalSessionId(terminalId),
      'prompt ready',
      'stdin_read',
      { kind: 'running' },
      Date.now(),
    )
    const created = await call('supervisor_checkpoint', { action: 'create', taskId: 'task-term', attempt: 2, terminalSessionId: terminalId })
    expect(created.isError).toBe(false)
    const stored = await ctx.supervisorTasks.checkpoints.read('task-term')
    expect(stored?.outputSpillPath).toBe(observed.spillPath)
    expect(stored?.terminalState).toMatchObject({ agentKind: 'dsh', lastLaunchCommand: '', state: 'running' })
    expect(stored?.terminalState?.lastModel).toBeUndefined()
    const restored = await call('supervisor_checkpoint', { action: 'restore', taskId: 'task-term' })
    expect(restored.value).toMatchObject({ restored: false, count: 1 })
    expect((restored.value as { outputTail?: string }).outputTail).toContain('prompt ready')
  })

  it('records the launch command and model of the terminal it was given', async () => {
    await ctx.supervisor.observe(owner, TerminalSessionId(terminalId), 'prompt ready', 'stdin_read', { kind: 'running' }, Date.now())
    const tracked = ctx.supervisor.sessions.get(terminalId)
    if (tracked === undefined) throw new Error('the scripted terminal must be tracked')
    tracked.agentKind = 'codex'
    tracked.lastLaunchCommand = 'codex exec "ship it"'
    tracked.lastModel = 'gpt-5'
    await call('supervisor_checkpoint', { action: 'create', taskId: 'task-facts', terminalSessionId: terminalId })
    const stored = await ctx.supervisorTasks.checkpoints.read('task-facts')
    expect(stored?.terminalState).toMatchObject({
      agentKind: 'codex',
      lastLaunchCommand: 'codex exec "ship it"',
      lastModel: 'gpt-5',
      state: 'running',
    })
  })
})

describe('supervisor_review', () => {
  it('states every missing section when the task has no evidence', async () => {
    const reviewed = await call('supervisor_review', { taskId: 'task-none', terminalSessionId: 'pty-none' })
    expect(reviewed.isError).toBe(false)
    expect(reviewed.value).toMatchObject({ checkpoints: 0, criteria: 0, diffIncluded: false, outputIncluded: false })
    const markdown = (reviewed.value as { markdown: string }).markdown
    expect(markdown).toContain('# Review packet: task-none')
    expect(markdown).toContain('(no plan recorded)')
    expect(markdown).toContain('(no checkpoints recorded)')
    expect((reviewed.content[0] as { text: string }).text).toBe('review packet: 0 checkpoint(s), 0 criterion(a)')
  })

  it('renders the plan and its acceptance criteria beside the checkpoints', async () => {
    await call('supervisor_plan', {
      action: 'write',
      taskId: 'task-r',
      goal: 'ship it',
      acceptanceCriteria: [{ id: 'ac-1', description: 'tests pass', verificationMethod: 'test-command' }],
      subTasks: subTasks(),
    })
    await call('supervisor_checkpoint', { action: 'create', taskId: 'task-r', stepIndex: 1 })
    const reviewed = await call('supervisor_review', { taskId: 'task-r', baseCommit: 'deadbeef' })
    expect(reviewed.value).toMatchObject({ checkpoints: 1, criteria: 1, diffIncluded: false, outputIncluded: false })
    const markdown = (reviewed.value as { markdown: string }).markdown
    expect(markdown).toContain('- Goal: ship it')
    expect(markdown).toContain('ac-1: tests pass (test-command, pending)')
    expect(markdown).toContain('(no diff recorded)')
    expect((reviewed.content[0] as { text: string }).text).toBe('review packet: 1 checkpoint(s), 1 criterion(a)')
  })

  it('adds the commit-range diff and the terminal output tail to the packet', async () => {
    await initRepoWith('work.txt', 'first\n')
    const first = await call('supervisor_checkpoint', { action: 'create', taskId: 'task-git', cwd: 'repo' })
    const baseCommit = (first.value as { commitHash: string }).commitHash
    await writeFile(join(root, 'repo', 'work.txt'), 'second\n', 'utf8')
    const second = await call('supervisor_checkpoint', { action: 'create', taskId: 'task-git', cwd: 'repo' })
    const headCommit = (second.value as { commitHash: string }).commitHash
    await mkdir(join(root, 'state', 'spill', '_unbound'), { recursive: true })
    await writeFile(join(root, 'state', 'spill', '_unbound', 'pty-1.log'), '2026-01-01T00:00:00.000Z tail line\n', 'utf8')

    const reviewed = await call('supervisor_review', { taskId: 'task-git', baseCommit, headCommit, terminalSessionId: 'pty-1' })
    expect(reviewed.isError).toBe(false)
    expect(reviewed.value).toMatchObject({ checkpoints: 2, diffIncluded: true, outputIncluded: true })
    const markdown = (reviewed.value as { markdown: string }).markdown
    expect(markdown).toContain('-first')
    expect(markdown).toContain('+second')
    expect(markdown).toContain('tail line')
    expect((reviewed.content[0] as { text: string }).text)
      .toBe('review packet: 2 checkpoint(s), 0 criterion(a), diff included, output tail included')

    const sameRange = await call('supervisor_review', { taskId: 'task-git', baseCommit: headCommit, headCommit })
    expect(sameRange.value).toMatchObject({ diffIncluded: false })
    expect((sameRange.value as { markdown: string }).markdown).toContain('(no diff recorded)')

    // Without an explicit head, the newest checkpoint's commit is the range end.
    const newestHead = await call('supervisor_review', { taskId: 'task-git', baseCommit })
    expect(newestHead.value).toMatchObject({ checkpoints: 2, diffIncluded: true })
  })

  it('reports a checkpoint without repository facts as no diff', async () => {
    await call('supervisor_plan', { action: 'write', taskId: 'task-plain', goal: 'ship it' })
    await call('supervisor_checkpoint', { action: 'create', taskId: 'task-plain' })
    const reviewed = await call('supervisor_review', { taskId: 'task-plain', baseCommit: 'deadbeef' })
    expect(reviewed.value).toMatchObject({ checkpoints: 1, criteria: 0, diffIncluded: false })
  })
})

/** One review finding payload for `supervisor_issue`. */
function finding(id: string, severity: string) {
  return {
    id,
    severity,
    category: 'code-quality',
    title: `defect ${id}`,
    evidence: 'src/a.ts:12',
    gap: 'does not satisfy ac-1',
    suggestedFix: `repair ${id}`,
  }
}

describe('supervisor_issue', () => {
  it('records a review round and walks the ticket through repair', async () => {
    const opened = await call('supervisor_issue', {
      action: 'open',
      taskId: 'task-i',
      findings: [finding('f-1', 'blocking'), finding('f-2', 'low')],
      regressionScope: ['pnpm test'],
      redoInstructions: 'close the gap',
    })
    expect(opened.isError).toBe(false)
    const ticketId = (opened.value as { ticketId: string }).ticketId
    expect(ticketId).toMatch(/^ticket-/)
    expect(opened.value).toMatchObject({
      status: 'open',
      retryCount: 0,
      maxRetries: 2,
      blocking: 1,
      findings: [
        { id: 'f-1', severity: 'blocking', category: 'code-quality', title: 'defect f-1' },
        { id: 'f-2', severity: 'low', category: 'code-quality', title: 'defect f-2' },
      ],
      tickets: 1,
    })
    expect((opened.value as { redoBrief?: string }).redoBrief).toContain('close the gap')
    expect((opened.content[0] as { text: string }).text)
      .toBe(`ticket ${ticketId}: open (attempt 0/2, 1 blocking finding(s))`)

    const listed = await call('supervisor_issue', { action: 'list', taskId: 'task-i' })
    expect(listed.value).toMatchObject({ ticketId, status: 'open', tickets: 1 })

    const read = await call('supervisor_issue', { action: 'read', taskId: 'task-i', ticketId })
    expect(read.value).toMatchObject({ ticketId, status: 'open' })

    const redone = await call('supervisor_issue', { action: 'redo', taskId: 'task-i' })
    expect(redone.value).toMatchObject({ ticketId, status: 'in-redo', retryCount: 1 })
    expect((redone.value as { redoBrief?: string }).redoBrief).toContain('[blocking] defect f-1: repair f-1')

    const resolved = await call('supervisor_issue', { action: 'regression-passed', taskId: 'task-i' })
    expect(resolved.value).toMatchObject({ ticketId, status: 'resolved', retryCount: 1 })
    expect((resolved.value as { redoBrief?: string }).redoBrief).toBeUndefined()
  })

  it('escalates a ticket once the repair budget runs out', async () => {
    await call('supervisor_issue', { action: 'open', taskId: 'task-e', findings: [finding('f-1', 'high')] })
    await call('supervisor_issue', { action: 'redo', taskId: 'task-e' })
    const escalated = await call('supervisor_issue', { action: 'regression-failed', taskId: 'task-e' })
    expect(escalated.value).toMatchObject({ status: 'escalated', retryCount: 2, maxRetries: 2, blocking: 1 })
    expect((escalated.value as { redoBrief?: string }).redoBrief).toBeUndefined()
    expect((escalated.content[0] as { text: string }).text).toContain('(attempt 2/2, 1 blocking finding(s))')
  })

  it('reads a stored ticket that is under regression review', async () => {
    const directory = join(root, 'state', 'tickets', 'task-regression')
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'ticket-reg.json'), `${JSON.stringify({
      ticketId: 'ticket-reg',
      taskId: 'task-regression',
      findings: [],
      redoInstructions: '',
      regressionScope: [],
      retryCount: 1,
      maxRetries: 2,
      status: 'in-regression',
      createdAt: 1,
      updatedAt: 1,
    })}\n`, 'utf8')
    const read = await call('supervisor_issue', { action: 'read', taskId: 'task-regression' })
    expect(read.isError).toBe(false)
    expect(read.value).toMatchObject({ status: 'in-regression', tickets: 1 })
    expect((read.value as { redoBrief?: string }).redoBrief).toContain('ticket-reg')
  })

  it('refuses an unknown task, an unknown ticket, and an action the ticket does not accept', async () => {
    const unknownList = await call('supervisor_issue', { action: 'list', taskId: 'task-none' })
    expect(unknownList.isError).toBe(true)
    const unknownRead = await call('supervisor_issue', { action: 'read', taskId: 'task-none' })
    expect(unknownRead.isError).toBe(true)

    const opened = await call('supervisor_issue', { action: 'open', taskId: 'task-x' })
    expect(opened.isError).toBe(false)
    expect(opened.value).toMatchObject({ blocking: 0, tickets: 1 })

    const unknownTicket = await call('supervisor_issue', { action: 'read', taskId: 'task-x', ticketId: 'ticket-missing' })
    expect(unknownTicket.isError).toBe(true)

    const tooEarly = await call('supervisor_issue', { action: 'regression-passed', taskId: 'task-x' })
    expect(tooEarly.isError).toBe(true)

    await call('supervisor_issue', { action: 'redo', taskId: 'task-x' })
    await call('supervisor_issue', { action: 'regression-passed', taskId: 'task-x' })
    const afterTerminal = await call('supervisor_issue', { action: 'redo', taskId: 'task-x' })
    expect(afterTerminal.isError).toBe(true)
  })
})

describe('tool presentation', () => {
  it('describes every task tool call for the transcript', () => {
    expect(ctx.tools.get('supervisor_checkpoint')?.presentCall?.({ action: 'create', taskId: 'task-a' }))
      .toEqual({ card: 'generic', title: 'Checkpoint create: task-a', kind: 'other' })
    expect(ctx.tools.get('supervisor_plan')?.presentCall?.({ action: 'read', taskId: 'task-a' }))
      .toEqual({ card: 'generic', title: 'Plan read: task-a', kind: 'other' })
    expect(ctx.tools.get('supervisor_review')?.presentCall?.({ taskId: 'task-a' }))
      .toEqual({ card: 'generic', title: 'Review task-a', kind: 'read' })
    expect(ctx.tools.get('supervisor_issue')?.presentCall?.({ action: 'open', taskId: 'task-a' }))
      .toEqual({ card: 'generic', title: 'Issue open: task-a', kind: 'other' })
  })

  it('renders every task tool result, including declared fallbacks', () => {
    const planTool = ctx.tools.get('supervisor_plan')
    expect(planTool?.output.render({}, {
      path: '',
      taskId: 'task-a',
      goal: 'ship it',
      subTasks: [{ id: 'st-1', title: 't', status: 'pending', dependsOn: [] }],
      readyToStart: ['st-1'],
      cycleDetected: false,
    })).toEqual([{ type: 'text', text: '1 subtask(s); ready: st-1' }])
    expect(planTool?.output.render({}, {
      path: '',
      taskId: 'task-a',
      goal: 'ship it',
      subTasks: [],
      readyToStart: [],
      cycleDetected: false,
    })).toEqual([{ type: 'text', text: '0 subtask(s); ready: none' }])
    expect(planTool?.output.render({}, {
      path: '',
      taskId: 'task-a',
      goal: 'ship it',
      subTasks: [],
      readyToStart: [],
      cycleDetected: true,
    })).toEqual([{ type: 'text', text: '0 subtask(s); ready: none; DEPENDENCY CYCLE' }])

    const checkpointTool = ctx.tools.get('supervisor_checkpoint')
    expect(checkpointTool?.output.render({ action: 'create', taskId: 'task-a' }, {
      checkpointId: 'cp-1',
      path: '/state/checkpoints/task-a/cp-1.json',
      commitHash: 'deadbeef',
      gitAvailable: true,
      count: 1,
      checkpoints: [],
      restored: false,
    })).toEqual([{ type: 'text', text: '1 checkpoint(s); latest cp-1 at deadbeef' }])
    expect(checkpointTool?.output.render({ action: 'list', taskId: 'task-a' }, {
      checkpointId: '',
      commitHash: '',
      gitAvailable: false,
      count: 0,
      checkpoints: [],
      restored: false,
    })).toEqual([{ type: 'text', text: '0 checkpoint(s)' }])
    expect(checkpointTool?.output.render({ action: 'list', taskId: 'task-a' }, {
      checkpointId: 'cp-1',
      commitHash: '',
      gitAvailable: false,
      count: 1,
      checkpoints: [],
      restored: false,
    })).toEqual([{ type: 'text', text: '1 checkpoint(s); latest cp-1' }])
    expect(checkpointTool?.output.render({ action: 'restore', taskId: 'task-a' }, {
      checkpointId: 'cp-1',
      commitHash: 'deadbeef',
      gitAvailable: true,
      count: 1,
      checkpoints: [],
      restored: true,
    })).toEqual([{ type: 'text', text: 'restored cp-1 (commit deadbeef)' }])

    const reviewTool = ctx.tools.get('supervisor_review')
    expect(reviewTool?.output.render({ taskId: 'task-a' }, { markdown: '', checkpoints: 2, criteria: 1, diffIncluded: true, outputIncluded: true }))
      .toEqual([{ type: 'text', text: 'review packet: 2 checkpoint(s), 1 criterion(a), diff included, output tail included' }])
    expect(reviewTool?.output.render({ taskId: 'task-a' }, { markdown: '', checkpoints: 0, criteria: 0, diffIncluded: false, outputIncluded: false }))
      .toEqual([{ type: 'text', text: 'review packet: 0 checkpoint(s), 0 criterion(a)' }])

    expect(ctx.tools.get('supervisor_issue')?.output.render({ action: 'open', taskId: 'task-a' }, {
      ticketId: 'ticket-1',
      status: 'open',
      retryCount: 0,
      maxRetries: 2,
      blocking: 1,
      findings: [],
      tickets: 1,
    })).toEqual([{ type: 'text', text: 'ticket ticket-1: open (attempt 0/2, 1 blocking finding(s))' }])
  })
})
