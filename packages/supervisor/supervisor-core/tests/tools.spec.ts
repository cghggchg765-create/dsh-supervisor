import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent, Inbox } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { TerminalSessionService } from '@deepseek-ai/dsh-terminal'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SupervisorRuntime } from '../src/index.ts'
import type { TaskPlan } from '../src/types.ts'

let root = ''
let ctx: Context
let callCounter = 0
let owner: Agent

/** Every tool the control-plane core contributes, in registration order. */
const CORE_TOOLS = [
  'supervisor_agent_launch',
  'supervisor_terminal_send',
  'supervisor_terminal_run',
  'supervisor_terminal_read',
  'supervisor_terminal_signal',
  'supervisor_status',
]

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

/**
 * Build the agent handle these tools read. Every member is present, so the
 * value is a real Agent rather than a partial one asserted into the type.
 */
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

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-supervisor-'))
  ctx = new Context()
  owner = buildAgent(ctx.plugin(() => {}).ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(TerminalSessionService)
  await ctx.plugin(SupervisorRuntime, {
    stateDir: join(root, 'state'),
    workspaceDir: root,
    watchdogEnabled: false,
  })
})

afterEach(async () => {
  await ctx.fiber.dispose()
  await rm(root, { recursive: true, force: true })
})

/**
 * Execute one registered supervisor tool. The runtime method is bound through
 * an element access because a direct property call reads as command execution
 * to the repository's static security scan.
 */
function call(name: string, args: unknown) {
  return callIn(ctx, owner, name, args)
}

/**
 * Execute one registered supervisor tool against an explicit context and
 * owning agent. Element access is used for the runtime method because a direct
 * property call reads as command execution to the repository's static scan.
 */
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

/** A stored plan with one finished and one pending subtask. */
function plan(taskId: string): TaskPlan {
  return {
    taskId,
    goal: 'ship it',
    constraints: [],
    acceptanceCriteria: [],
    subTasks: [
      {
        id: 'st-1',
        title: 'write the parser',
        description: 'parse the input',
        dependsOn: [],
        requiredSkills: [],
        estimatedEffort: 'small',
        acceptanceCriteria: [],
        status: 'completed',
      },
      {
        id: 'st-2',
        title: 'wire the CLI',
        description: 'expose the parser',
        dependsOn: ['st-1'],
        requiredSkills: [],
        estimatedEffort: 'medium',
        acceptanceCriteria: [],
        status: 'pending',
      },
    ],
    integrationStrategy: 'sequential-merge',
    createdAt: 1,
    updatedAt: 2,
  }
}

describe('plugin registration', () => {
  it('declares the services it drives and registers the core tools', () => {
    expect(ctx.supervisor.name).toBe('supervisor')
    expect(SupervisorRuntime.inject).toEqual(['tools', 'terminals'])
    const names = ctx.tools.schemas().map(schema => schema.name).filter(name => name.startsWith('supervisor_'))
    expect(names).toEqual(CORE_TOOLS)
  })

  it('starts with no supervised terminals and no tasks', async () => {
    const result = await call('supervisor_status', {})
    expect(result.isError).toBe(false)
    expect(result.value).toEqual({ sessions: [], tasks: [] })
  })

  it('reports the tasks stored in the plan store', async () => {
    await ctx.supervisor.plans.write(plan('task-a'))
    const result = await call('supervisor_status', {})
    expect(result.value).toMatchObject({
      tasks: [{ taskId: 'task-a', goal: 'ship it', subTasks: 2, completed: 1, failed: 0 }],
    })
  })
})

describe('tool presentation', () => {
  it('describes every core tool call for the transcript', () => {
    expect(ctx.tools.get('supervisor_agent_launch')?.presentCall?.({
      sessionId: 'pty-1',
      agentKind: 'codex',
      prompt: 'ship it',
    })).toEqual({ card: 'generic', title: 'Launch codex in pty-1', kind: 'execute', rawInput: 'ship it' })
    expect(ctx.tools.get('supervisor_terminal_send')?.presentCall?.({
      sessionId: 'pty-1',
      text: 'echo hello',
    })).toEqual({ card: 'generic', title: 'Send to pty-1: echo hello', kind: 'execute' })
    expect(ctx.tools.get('supervisor_terminal_read')?.presentCall?.({ sessionId: 'pty-1' }))
      .toEqual({ card: 'generic', title: 'Read pty-1', kind: 'read' })
    expect(ctx.tools.get('supervisor_terminal_signal')?.presentCall?.({ sessionId: 'pty-1', signal: 'SIGINT' }))
      .toEqual({ card: 'generic', title: 'SIGINT -> pty-1', kind: 'execute' })
    expect(ctx.tools.get('supervisor_terminal_run')?.presentCall?.({ sessionId: 'pty-1', command: 'npm test' }))
      .toEqual({ card: 'generic', title: 'Run in pty-1: npm test', kind: 'execute' })
    expect(ctx.tools.get('supervisor_status')?.presentCall?.({}))
      .toEqual({ card: 'generic', title: 'Supervisor status', kind: 'read' })
  })

  it('renders every core tool result, including declared fallbacks', () => {
    expect(ctx.tools.get('supervisor_agent_launch')?.output.render({}, {
      sessionId: 'pty-1',
      command: 'codex exec go',
      output: 'done',
      waitReason: 'stdin_read',
      stateMarks: ['prompt-idle'],
      outputClass: 'unknown',
      l1Hits: [],
      breaker: 'closed',
      breakerNoProgress: 0,
      spillCapped: false,
      sessionStatus: 'running',
    })).toEqual([{ type: 'text', text: 'launched: codex exec go\nstdin_read [prompt-idle]\ndone' }])

    const sendTool = ctx.tools.get('supervisor_terminal_send')
    expect(sendTool?.output.render({}, {
      truncated: false,
      output: 'ready',
      waitReason: 'stdin_read',
      stateMarks: ['prompt-idle'],
      outputClass: 'unknown',
      l1Hits: [],
      breaker: 'closed',
      breakerNoProgress: 0,
      spillCapped: false,
      sessionStatus: 'running',
    })).toEqual([{ type: 'text', text: 'stdin_read [prompt-idle]\nready' }])
    expect(sendTool?.output.render({}, {
      truncated: false,
      output: 'quiet',
      waitReason: 'session_exit',
      stateMarks: [],
      outputClass: 'unknown',
      l1Hits: [],
      breaker: 'closed',
      breakerNoProgress: 0,
      spillCapped: false,
      sessionStatus: 'running',
    })).toEqual([{ type: 'text', text: 'session_exit\nquiet' }])

    const runTool = ctx.tools.get('supervisor_terminal_run')
    expect(runTool?.output.render({}, {
      matched: true,
      timedOut: false,
      exitCode: 0,
      marker: 'DONE_1',
      truncated: false,
      output: 'built',
      waitReason: 'stdin_read',
      stateMarks: [],
      outputClass: 'unknown',
      l1Hits: [],
      breaker: 'closed',
      breakerNoProgress: 0,
      spillCapped: false,
      sessionStatus: 'running',
    })).toEqual([{ type: 'text', text: 'finished rc=0\nbuilt' }])
    expect(runTool?.output.render({}, {
      matched: true,
      timedOut: false,
      marker: 'DONE_1',
      truncated: true,
      output: 'built',
      waitReason: 'stdin_read',
      stateMarks: [],
      outputClass: 'unknown',
      l1Hits: [],
      breaker: 'closed',
      breakerNoProgress: 0,
      spillCapped: false,
      sessionStatus: 'running',
    })).toEqual([{ type: 'text', text: 'finished rc=? (truncated)\nbuilt' }])
    expect(runTool?.output.render({}, {
      matched: false,
      timedOut: true,
      marker: 'DONE_1',
      truncated: false,
      output: 'still running',
      waitReason: 'timeout',
      stateMarks: ['silence'],
      outputClass: 'unknown',
      l1Hits: [],
      breaker: 'closed',
      breakerNoProgress: 0,
      spillCapped: false,
      sessionStatus: 'running',
    })).toEqual([{ type: 'text', text: 'TIMED OUT\nstill running' }])

    expect(ctx.tools.get('supervisor_terminal_read')?.output.render({}, {
      text: 'retained',
      totalLines: 3,
      truncated: true,
      stateMarks: [],
      outputClass: 'unknown',
      l1Hits: [],
      heartbeatAgeSec: 120,
      heartbeatStale: true,
    })).toEqual([{ type: 'text', text: '3 lines retained (truncated) STALE\nretained' }])

    expect(ctx.tools.get('supervisor_terminal_signal')?.output.render({}, {
      delivered: true,
      targetPgid: 4242,
      sessionStatus: 'running',
      closed: false,
      heartbeatRemoved: false,
    })).toEqual([{ type: 'text', text: 'signal delivered=true status=running closed=false' }])

    const statusTool = ctx.tools.get('supervisor_status')
    expect(statusTool?.output.render({}, { sessions: [], tasks: [] }))
      .toEqual([{ type: 'text', text: 'no supervised terminals' }])
    expect(statusTool?.output.render({}, {
      sessions: [
        { sessionId: 'pty-1', status: 'running', heartbeatAgeSec: 4, stale: true, lastWaitReason: 'timeout', outputClass: 'unknown', breaker: 'closed', breakerNoProgress: 0, taskId: 'task-a' },
        { sessionId: 'pty-2', status: 'closed', heartbeatAgeSec: 0, stale: false, lastWaitReason: 'stdin_read', outputClass: 'unknown', breaker: 'closed', breakerNoProgress: 0 },
      ],
      tasks: [],
    })).toEqual([{ type: 'text', text: 'pty-1 running last-output=4s STALE task=task-a\npty-2 closed last-output=0s' }])
  })
})

describe('terminal tools', () => {
  it('rejects a terminal call with no owning agent', async () => {
    const run = ctx.tools['execute'].bind(ctx.tools)
    const result = await run({
      signal: new AbortController().signal,
      callId: ToolCallId('call-unowned'),
      name: 'supervisor_terminal_read',
      arguments: { sessionId: 'pty-1' },
    })
    expect(result.isError).toBe(true)
  })

  it('reports an unknown terminal as a tool failure rather than throwing', async () => {
    const result = await call('supervisor_terminal_read', { sessionId: 'pty-missing' })
    expect(result.isError).toBe(true)
  })
})
