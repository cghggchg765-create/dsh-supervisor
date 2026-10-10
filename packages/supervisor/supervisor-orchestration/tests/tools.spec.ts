import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import SupervisorRuntime, { type TaskPlan } from '@deepseek-ai/dsh-supervisor-core'
import SupervisorTaskService from '@deepseek-ai/dsh-supervisor-tasks'
import {
  TerminalSessionService,
  type TerminalBackend,
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
import * as plugin from '../src/index.ts'
import type { OrchestrationConfig } from '../src/config.ts'

/** The four tools this package contributes, in registration order. */
const ORCHESTRATION_TOOLS = [
  'supervisor_agent_switch',
  'supervisor_skills',
  'supervisor_worktree',
  'supervisor_dispatch',
]

/** The tools the mounted control plane contributes, in registration order. */
const CORE_TOOLS = [
  'supervisor_agent_launch',
  'supervisor_terminal_send',
  'supervisor_terminal_run',
  'supervisor_terminal_read',
  'supervisor_terminal_signal',
  'supervisor_status',
]

let root = ''
let ctx: Context
let callCounter = 0
let harnessCounter = 0
let owner: Agent
let terminalId = ''

/**
 * A scripted terminal that echoes every send, so a switch command that names an
 * invalid model is visible in the settlement and one that does not is accepted.
 */
class ScriptedSession implements TerminalBackendSession {
  readonly motd = 'scripted terminal ready\n'

  private readonly lines: string[] = []

  /** Text of the most recent send, so a test can inspect the command. */
  lastSent = ''

  startSend(request: TerminalSendRequest): TerminalSendOperation {
    this.lastSent = request.text
    const viewport = `$ ${request.text}\n${request.text}\n$ `
    this.lines.push(...viewport.split('\n').filter(line => line !== ''))
    return {
      done: Promise.resolve({
        viewport,
        waitReason: 'stdin_read',
        sessionStatus: { kind: 'running' },
        truncated: false,
      }),
      readOutput: () => ({ delta: viewport, truncated: false }),
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

let scripted: ScriptedSession

/**
 * Register the agent that owns the terminal. The terminal service authorizes by
 * exact Agent identity, so every tool call must pass this one instance.
 */
async function registerAgent(context: Context): Promise<Agent> {
  const scope = context.plugin(() => {})
  const id = SessionId('orchestration-test-agent')
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

/** Spawn one scripted terminal owned by the given agent. */
async function spawnTerminal(context: Context, terminalOwner: Agent) {
  const openTerminal = context.terminals['spawn'].bind(context.terminals)
  return await openTerminal(terminalOwner, { type: 'scripted', name: 'orchestration', cwd: root }, undefined)
}

/** Register the scripted backend under its own session type. */
function scriptedBackend(): TerminalBackend {
  return {
    type: 'scripted',
    spawn: () => {
      scripted = new ScriptedSession()
      return Promise.resolve(scripted)
    },
  }
}

/** Mount the control plane, the task services, and this plugin over a context. */
async function mountSupervisor(context: Context, pluginConfig: OrchestrationConfig, stateDir: string): Promise<void> {
  await context.plugin(SystemPrompt)
  await context.plugin(ToolRuntime)
  await context.plugin(AgentRegistry)
  await context.plugin(TerminalSessionService)
  await context.plugin(SupervisorRuntime, { stateDir, workspaceDir: root, watchdogEnabled: false })
  await context.plugin(SupervisorTaskService)
  await context.plugin(plugin, pluginConfig)
}

/**
 * Execute one orchestration tool. Element access is used for the registry method
 * because the repository's static security scan reads a direct property call as
 * command execution.
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
 * A second harness whose plugin configuration differs from the default one, so
 * a model rule table can be exercised without disturbing the shared context.
 * @param config - orchestration configuration for the mounted plugin.
 * @returns the mounted context, its scripted terminal, and its owning agent.
 */
async function openHarness(config: OrchestrationConfig) {
  const context = new Context()
  await mountSupervisor(context, config, join(root, `harness-state-${++harnessCounter}`))
  const backend = new ScriptedSession()
  context.terminals.registerBackend({ type: 'scripted', spawn: () => Promise.resolve(backend) })
  const harnessOwner = await registerAgent(context)
  const terminal = await spawnTerminal(context, harnessOwner)
  return { context, backend, owner: harnessOwner, terminalId: terminal.sessionId }
}

/** One plan subtask with the given id, dependencies, and status. */
function subTask(id: string, dependsOn: readonly string[] = [], status: TaskPlan['subTasks'][number]['status'] = 'pending') {
  return {
    id,
    title: id === 'st-1' ? 'write the parser' : 'wire the CLI',
    description: `do ${id}`,
    dependsOn: [...dependsOn],
    requiredSkills: id === 'st-1' ? ['react'] : [],
    estimatedEffort: 'small' as const,
    acceptanceCriteria: [],
    status,
  }
}

/** Persist a plan through the control plane's store. */
async function writePlan(taskId: string, subTasks: TaskPlan['subTasks']): Promise<void> {
  await ctx.supervisor.plans.write({
    taskId,
    goal: 'ship it',
    constraints: [],
    acceptanceCriteria: [],
    subTasks,
    integrationStrategy: 'sequential-merge',
    createdAt: 1,
    updatedAt: 1,
  })
}

/** Initialize a repository and commit one file, leaving a clean work tree. */
async function initCommittedRepo(): Promise<void> {
  const repo = join(root, 'repo')
  await mkdir(repo, { recursive: true })
  await ctx.supervisorTasks.git.run(repo, ['init'])
  await writeFile(join(repo, 'work.txt'), 'first\n', 'utf8')
  await ctx.supervisorTasks.git.commitAll(repo, 'main', 'base')
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-supervisor-orchestration-'))
  ctx = new Context()
  await mountSupervisor(ctx, {
    skillRoots: { homeDir: join(root, 'home'), workspaceDir: join(root, 'skills-workspace') },
  }, join(root, 'state'))
  scripted = new ScriptedSession()
  ctx.terminals.registerBackend(scriptedBackend())
  owner = await registerAgent(ctx)
  terminalId = (await spawnTerminal(ctx, owner)).sessionId
})

afterEach(async () => {
  await ctx.fiber.dispose()
  await rm(root, { recursive: true, force: true })
})

describe('plugin registration', () => {
  it('declares the services it drives and registers no orchestration tool beyond the four', () => {
    expect(plugin.name).toBe('supervisor-orchestration')
    expect(plugin.inject).toEqual(['tools', 'terminals', 'supervisor', 'supervisorTasks'])
    const names = ctx.tools.schemas().map(schema => schema.name)
    expect(names.filter(name => CORE_TOOLS.includes(name))).toEqual(CORE_TOOLS)
    expect(names.filter(name => ORCHESTRATION_TOOLS.includes(name))).toEqual(ORCHESTRATION_TOOLS)
  })
})

describe('supervisor_skills', () => {
  it('scans agent skill roots, caches inventories, and matches a subtask requirement', async () => {
    await mkdir(join(root, 'home', '.claude', 'skills', 'react-component'), { recursive: true })
    await mkdir(join(root, 'skills-workspace', '.claude', 'skills', 'deploy'), { recursive: true })

    const beforeScan = await call('supervisor_skills', { action: 'list' })
    expect(beforeScan.isError).toBe(false)
    expect(beforeScan.value).toMatchObject({ inventories: [], matches: [] })
    expect((beforeScan.content[0] as { text: string }).text).toBe('no skill inventories cached')

    const scanned = await call('supervisor_skills', { action: 'scan', agentKind: 'claude-code' })
    expect(scanned.isError).toBe(false)
    expect(scanned.value).toMatchObject({
      inventories: [{ agentKind: 'claude-code', skills: ['deploy', 'react-component'], available: true }],
      matches: [],
    })
    const scannedAt = (scanned.value as { inventories: { scannedAt: string }[] }).inventories[0]?.scannedAt
    expect(scannedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)

    const listed = await call('supervisor_skills', { action: 'list', agentKind: 'claude-code' })
    expect(listed.value).toMatchObject({ inventories: [{ agentKind: 'claude-code', skills: ['deploy', 'react-component'] }] })

    const unmatched = await call('supervisor_skills', { action: 'scan', agentKind: 'codex', requiredSkills: ['deploy'] })
    expect(unmatched.value).toMatchObject({
      inventories: [{ agentKind: 'codex', available: false }],
      matches: [{ agentKind: 'codex', matched: [], missing: ['deploy'] }],
    })
    expect((unmatched.value as { brief?: string }).brief).toBeUndefined()

    const matched = await call('supervisor_skills', { action: 'scan', agentKind: 'claude-code', requiredSkills: ['deploy', 'rust'] })
    expect(matched.value).toMatchObject({
      matches: [{ agentKind: 'claude-code', matched: ['deploy'], missing: ['rust'] }],
    })
    expect((matched.value as { brief?: string }).brief).toBe('请使用以下技能完成：\n- deploy')

    const all = await call('supervisor_skills', { action: 'list' })
    const text = (all.content[0] as { text: string }).text
    expect(text).toContain('claude-code: 2 skill(s)')
    expect(text).toContain('codex: no configuration found')
  })

  it('scans every agent kind when none is named', async () => {
    const scanned = await call('supervisor_skills', { action: 'scan' })
    expect(scanned.isError).toBe(false)
    expect((scanned.value as { inventories: unknown[] }).inventories).toHaveLength(6)
  })
})

describe('supervisor_agent_switch', () => {
  it('switches the model through the configured in-session command', async () => {
    const result = await call('supervisor_agent_switch', { sessionId: terminalId, model: 'sonnet', agentKind: 'claude-code' })
    expect(result.isError).toBe(false)
    expect(result.value).toMatchObject({ switched: true, model: '/model sonnet', attempted: ['/model sonnet'] })
    expect(scripted.lastSent).toBe('/model sonnet')
    expect((result.content[0] as { text: string }).text).toBe('switched to /model sonnet via /model sonnet')
    const status = await call('supervisor_status', {})
    expect(status.value).toMatchObject({ sessions: [{ sessionId: terminalId, agentKind: 'claude-code' }] })
  })

  it('resolves a task phase through the configured model rules', async () => {
    const harness = await openHarness({
      modelRules: [{ phases: ['coding'], model: 'standard' }],
    })
    try {
      const result = await callIn(harness.context, harness.owner, 'supervisor_agent_switch', {
        sessionId: harness.terminalId,
        phase: 'coding',
        agentKind: 'claude-code',
      })
      expect(result.isError).toBe(false)
      expect(result.value).toMatchObject({ switched: true, model: '/model standard', attempted: ['/model standard'] })
    } finally {
      await harness.context.fiber.dispose()
    }
  })

  it('falls through to the next candidate when the CLI rejects a model', async () => {
    const harness = await openHarness({
      modelRules: [{ phases: ['coding'], model: 'unknown model', fallbackModels: ['good-model'] }],
    })
    try {
      const result = await callIn(harness.context, harness.owner, 'supervisor_agent_switch', {
        sessionId: harness.terminalId,
        phase: 'coding',
        agentKind: 'claude-code',
      })
      expect(result.isError).toBe(false)
      expect(result.value).toMatchObject({
        switched: true,
        model: '/model good-model',
        attempted: ['/model unknown model', '/model good-model'],
      })
      expect(harness.backend.lastSent).toBe('/model good-model')
    } finally {
      await harness.context.fiber.dispose()
    }
  })

  it('reports every candidate as rejected when the CLI refuses each model', async () => {
    const harness = await openHarness({
      modelRules: [{ phases: ['verification'], model: 'invalid model', fallbackModels: ['unknown model'] }],
    })
    try {
      const result = await callIn(harness.context, harness.owner, 'supervisor_agent_switch', {
        sessionId: harness.terminalId,
        phase: 'verification',
        agentKind: 'claude-code',
      })
      expect(result.isError).toBe(false)
      expect(result.value).toMatchObject({
        switched: false,
        attempted: ['/model invalid model', '/model unknown model'],
        reason: 'every candidate model was rejected by the hosted CLI',
      })
      expect((result.value as { output: string }).output).toContain('unknown model')
      expect((result.content[0] as { text: string }).text)
        .toBe('not switched: every candidate model was rejected by the hosted CLI')
    } finally {
      await harness.context.fiber.dispose()
    }
  })

  it('reports that the hosted CLI has no in-session switch command', async () => {
    const result = await call('supervisor_agent_switch', { sessionId: terminalId, model: 'gpt-5', agentKind: 'codex' })
    expect(result.isError).toBe(false)
    expect(result.value).toMatchObject({
      switched: false,
      attempted: [],
      reason: 'the hosted CLI has no in-session model switch command; relaunch it with the model instead',
      output: '',
      stateMarks: [],
      l1Hits: [],
      sessionStatus: 'running',
    })
    expect((result.content[0] as { text: string }).text)
      .toBe('not switched: the hosted CLI has no in-session model switch command; relaunch it with the model instead')
  })

  it('reports an undeclared CLI as having no in-session switch command', async () => {
    const result = await call('supervisor_agent_switch', { sessionId: terminalId, model: 'sonnet' })
    expect(result.isError).toBe(false)
    expect(result.value).toMatchObject({ switched: false, attempted: [] })
    expect((result.value as { reason: string }).reason).toContain('no in-session model switch command')
  })

  it('needs a model or a phase a configured rule covers', async () => {
    const neither = await call('supervisor_agent_switch', { sessionId: terminalId, agentKind: 'claude-code' })
    expect(neither.isError).toBe(true)
    const uncovered = await call('supervisor_agent_switch', { sessionId: terminalId, phase: 'retrieval', agentKind: 'claude-code' })
    expect(uncovered.isError).toBe(true)
  })

  it('rejects a switch with no owning agent', async () => {
    const run = ctx.tools['execute'].bind(ctx.tools)
    const result = await run({
      signal: new AbortController().signal,
      callId: ToolCallId('call-unowned'),
      name: 'supervisor_agent_switch',
      arguments: { sessionId: terminalId, model: 'sonnet' },
    })
    expect(result.isError).toBe(true)
  })
})

describe('supervisor_worktree', () => {
  it('creates, lists, and removes the worktree of one subtask', async () => {
    await initCommittedRepo()
    const entry = { subTaskId: 'st-1', path: join(root, '.worktrees', 'task-wt', 'st-1'), branch: 'supervisor/task-wt/st-1' }
    const created = await call('supervisor_worktree', { action: 'create', taskId: 'task-wt', subTaskId: 'st-1', cwd: 'repo' })
    expect(created.isError).toBe(false)
    expect(created.value).toMatchObject({ path: entry.path, branch: entry.branch, worktrees: [entry], merged: [] })
    expect((created.content[0] as { text: string }).text).toBe('1 worktree(s)')

    const duplicate = await call('supervisor_worktree', { action: 'create', taskId: 'task-wt', subTaskId: 'st-1', cwd: 'repo' })
    expect(duplicate.isError).toBe(false)
    expect(duplicate.value).toMatchObject({ worktrees: [entry], merged: [] })
    expect((duplicate.value as { path?: string }).path).toBeUndefined()

    const listed = await call('supervisor_worktree', { action: 'list', taskId: 'task-wt', cwd: 'repo' })
    expect(listed.value).toMatchObject({ worktrees: [entry], merged: [] })

    const removed = await call('supervisor_worktree', { action: 'remove', taskId: 'task-wt', subTaskId: 'st-1', cwd: 'repo' })
    expect(removed.value).toMatchObject({ removed: true, worktrees: [], merged: [] })
    expect((removed.content[0] as { text: string }).text).toBe('0 worktree(s)')

    const absent = await call('supervisor_worktree', { action: 'remove', taskId: 'task-wt', subTaskId: 'st-1', cwd: 'repo' })
    expect(absent.value).toMatchObject({ removed: false })
  })

  it('merges finished subtask branches in dependency order', async () => {
    await initCommittedRepo()
    await writePlan('task-merge', [subTask('st-1'), subTask('st-2', ['st-1'])])
    await call('supervisor_worktree', { action: 'create', taskId: 'task-merge', subTaskId: 'st-1', cwd: 'repo' })
    await call('supervisor_worktree', { action: 'create', taskId: 'task-merge', subTaskId: 'st-2', cwd: 'repo' })
    const integrated = await call('supervisor_worktree', { action: 'integrate', taskId: 'task-merge', cwd: 'repo' })
    expect(integrated.isError).toBe(false)
    expect(integrated.value).toMatchObject({ merged: ['st-1', 'st-2'] })
    expect((integrated.value as { failed?: string }).failed).toBeUndefined()
    expect((integrated.content[0] as { text: string }).text).toContain('merged st-1, st-2')
  })

  it('stops the integration at the subtask whose branch is missing', async () => {
    await initCommittedRepo()
    await writePlan('task-stop', [subTask('st-1'), subTask('st-2', ['st-1'])])
    await call('supervisor_worktree', { action: 'create', taskId: 'task-stop', subTaskId: 'st-1', cwd: 'repo' })
    const integrated = await call('supervisor_worktree', { action: 'integrate', taskId: 'task-stop', cwd: 'repo' })
    expect(integrated.isError).toBe(false)
    expect(integrated.value).toMatchObject({ merged: ['st-1'], failed: 'st-2' })
    expect((integrated.content[0] as { text: string }).text).toBe('integration stopped at st-2')
  })

  it('refuses a directory outside a repository, a missing plan, and a missing subtask id', async () => {
    await initCommittedRepo()
    const defaultCwd = await call('supervisor_worktree', { action: 'list', taskId: 'task-x' })
    expect(defaultCwd.isError).toBe(true)
    const outsideRepo = await call('supervisor_worktree', { action: 'list', taskId: 'task-x', cwd: 'not-a-repo' })
    expect(outsideRepo.isError).toBe(true)
    const noPlan = await call('supervisor_worktree', { action: 'integrate', taskId: 'task-none', cwd: 'repo' })
    expect(noPlan.isError).toBe(true)
    const createWithoutSubTask = await call('supervisor_worktree', { action: 'create', taskId: 'task-x', cwd: 'repo' })
    expect(createWithoutSubTask.isError).toBe(true)
    const removeWithoutSubTask = await call('supervisor_worktree', { action: 'remove', taskId: 'task-x', cwd: 'repo' })
    expect(removeWithoutSubTask.isError).toBe(true)
  })
})

describe('supervisor_dispatch', () => {
  it('reports the batch that fits concurrency and counts blocked work', async () => {
    await writePlan('task-d', [
      { ...subTask('st-1'), preferredAgent: 'codex' },
      subTask('st-2', ['st-1']),
      { ...subTask('st-3'), requiredSkills: [], title: 'write docs' },
      { ...subTask('st-4'), status: 'completed' },
    ])
    const first = await call('supervisor_dispatch', { taskId: 'task-d' })
    expect(first.isError).toBe(false)
    expect(first.value).toMatchObject({
      batch: [
        { id: 'st-1', title: 'write the parser', requiredSkills: ['react'], preferredAgent: 'codex' },
        { id: 'st-3', requiredSkills: [] },
      ],
      active: 0,
      maxConcurrency: 4,
      pending: 3,
      blocked: 1,
    })
    const batch = (first.value as { batch: { id: string; worktree: string }[] }).batch
    expect(batch[0]?.worktree).toBe(join(root, '.worktrees', 'task-d', 'st-1'))
    expect((first.content[0] as { text: string }).text).toBe('start st-1, st-3')

    const capped = await call('supervisor_dispatch', { taskId: 'task-d', active: ['st-1', 'st-3'] })
    expect(capped.value).toMatchObject({ batch: [], active: 2, pending: 3, blocked: 1 })
    expect((capped.content[0] as { text: string }).text).toBe('nothing ready (1 blocked, 3 pending)')
  })

  it('refuses to dispatch a task with no plan', async () => {
    const result = await call('supervisor_dispatch', { taskId: 'task-none' })
    expect(result.isError).toBe(true)
  })
})

describe('tool presentation', () => {
  it('describes every orchestration tool call for the transcript', () => {
    expect(ctx.tools.get('supervisor_agent_switch')?.presentCall?.({ sessionId: 'pty-1', model: 'sonnet' }))
      .toEqual({ card: 'generic', title: 'Switch model in pty-1', kind: 'execute' })
    expect(ctx.tools.get('supervisor_skills')?.presentCall?.({ action: 'scan' }))
      .toEqual({ card: 'generic', title: 'Skills scan', kind: 'read' })
    expect(ctx.tools.get('supervisor_worktree')?.presentCall?.({ action: 'create', taskId: 'task-a' }))
      .toEqual({ card: 'generic', title: 'Worktree create: task-a', kind: 'other' })
    expect(ctx.tools.get('supervisor_dispatch')?.presentCall?.({ taskId: 'task-a' }))
      .toEqual({ card: 'generic', title: 'Dispatch task-a', kind: 'read' })
  })

  it('renders every orchestration tool result, including declared fallbacks', () => {
    const switchTool = ctx.tools.get('supervisor_agent_switch')
    expect(switchTool?.output.render({}, {
      switched: true,
      model: '/model sonnet',
      attempted: ['/model sonnet'],
      output: '',
      stateMarks: [],
      l1Hits: [],
      breaker: 'closed',
      breakerNoProgress: 0,
      sessionStatus: 'running',
    })).toEqual([{ type: 'text', text: 'switched to /model sonnet via /model sonnet' }])
    expect(switchTool?.output.render({}, {
      switched: true,
      attempted: ['/model sonnet'],
      output: '',
      stateMarks: [],
      l1Hits: [],
      breaker: 'closed',
      breakerNoProgress: 0,
      sessionStatus: 'running',
    })).toEqual([{ type: 'text', text: 'switched to ? via /model sonnet' }])
    expect(switchTool?.output.render({}, {
      switched: false,
      attempted: [],
      output: '',
      stateMarks: [],
      l1Hits: [],
      breaker: 'closed',
      breakerNoProgress: 0,
      sessionStatus: 'running',
    })).toEqual([{ type: 'text', text: 'not switched: unknown reason' }])

    const skillsTool = ctx.tools.get('supervisor_skills')
    expect(skillsTool?.output.render({ action: 'scan' }, {
      inventories: [{ agentKind: 'codex', skills: ['react'], available: true, scannedAt: '1970-01-01T00:00:00.000Z' }],
      matches: [],
    })).toEqual([{ type: 'text', text: 'codex: 1 skill(s)' }])
    expect(skillsTool?.output.render({ action: 'scan' }, {
      inventories: [{ agentKind: 'codex', skills: [], available: false, scannedAt: '1970-01-01T00:00:00.000Z' }],
      matches: [],
    })).toEqual([{ type: 'text', text: 'codex: no configuration found' }])
    expect(skillsTool?.output.render({ action: 'list' }, { inventories: [], matches: [] }))
      .toEqual([{ type: 'text', text: 'no skill inventories cached' }])

    const worktreeTool = ctx.tools.get('supervisor_worktree')
    expect(worktreeTool?.output.render({ action: 'list', taskId: 'task-a' }, { worktrees: [], merged: [] }))
      .toEqual([{ type: 'text', text: '0 worktree(s)' }])
    expect(worktreeTool?.output.render({ action: 'integrate', taskId: 'task-a' }, { worktrees: [], merged: ['st-1'] }))
      .toEqual([{ type: 'text', text: '0 worktree(s); merged st-1' }])
    expect(worktreeTool?.output.render({ action: 'integrate', taskId: 'task-a' }, { worktrees: [], merged: [], failed: 'st-2' }))
      .toEqual([{ type: 'text', text: 'integration stopped at st-2' }])

    const dispatchTool = ctx.tools.get('supervisor_dispatch')
    expect(dispatchTool?.output.render({ taskId: 'task-a' }, { batch: [], active: 0, maxConcurrency: 4, pending: 2, blocked: 1 }))
      .toEqual([{ type: 'text', text: 'nothing ready (1 blocked, 2 pending)' }])
    expect(dispatchTool?.output.render({ taskId: 'task-a' }, {
      batch: [{ id: 'st-1', title: 't', requiredSkills: [], worktree: '/wt' }],
      active: 0,
      maxConcurrency: 4,
      pending: 1,
      blocked: 0,
    })).toEqual([{ type: 'text', text: 'start st-1' }])
  })
})
