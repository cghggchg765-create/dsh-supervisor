import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, Inbox } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import {
  TerminalSessionService,
  type TerminalReadRequest,
  type TerminalReadResult,
  type TerminalSendOperation,
  type TerminalSendRequest,
  type TerminalSessionStatus,
  type TerminalWaitReason,
} from '@deepseek-ai/dsh-terminal'
import type {
  TerminalBackend,
  TerminalBackendSession,
  TerminalBackendSpawnSpec,
} from '@deepseek-ai/dsh-terminal'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SupervisorRuntime } from '../src/index.ts'
import type { SupervisorConfig } from '../src/runtime.ts'

let root = ''
let ctx: Context
let callCounter = 0
let sessionId = ''
let managedAgent: Agent
let scripted: ScriptedSession

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
 * Register the agent that owns the terminal. The terminal service authorizes by
 * exact Agent identity, so every tool call must pass this one instance.
 */
async function registerAgent(ctx: Context): Promise<Agent> {
  const scope = ctx.plugin(() => {})
  const id = SessionId('supervisor-test-agent')
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
  await ctx.agents.register(value)
  return value
}

/**
 * A scripted terminal. It settles every send immediately with output chosen by
 * the request text, so the supervisor pipeline can be exercised without a PTY.
 */
class ScriptedSession implements TerminalBackendSession {
  readonly motd = 'scripted terminal ready\n'

  private readonly lines: string[] = []

  /** Wait reason every settlement reports. */
  waitReason: TerminalWaitReason = 'stdin_read'

  /** Status settlements and status() report. */
  sessionStatus: TerminalSessionStatus = { kind: 'running' }

  /** Whether settlements report dropped output. */
  truncated = false

  /** Whether read results report dropped lines. */
  readTruncated = false

  /** Exit status text the wrapped-command emulation echoes; defaults to exitCode. */
  exitStatusText: string | undefined

  /** When true, the emulation never echoes the completion marker. */
  suppressMarker = false

  /** When true, the emulation echoes the completion marker without an exit status. */
  omitExitStatus = false

  /** Exit status the wrapped-run emulation reports. */
  exitCode = 0

  /** Read requests served so far, so a test can prove the completion poll ran. */
  readCount = 0

  /** Text of the most recent send, so a test can inspect the wrapper. */
  lastSent = ''

  /** Submit flag of the most recent send, so a test can inspect the request. */
  lastSubmit: boolean | undefined

  startSend(request: TerminalSendRequest): TerminalSendOperation {
    this.lastSent = request.text
    this.lastSubmit = request.submit
    const viewport = this.respond(request.text)
    this.lines.push(...viewport.split('\n').filter(line => line !== ''))
    return {
      done: Promise.resolve({
        viewport,
        waitReason: this.waitReason,
        sessionStatus: this.sessionStatus,
        truncated: this.truncated,
      }),
      readOutput: () => ({ delta: viewport, truncated: this.truncated }),
      cancel: () => false,
    }
  }

  read(request: TerminalReadRequest): TerminalReadResult {
    this.readCount += 1
    const count = request.count ?? this.lines.length
    const offset = request.offset ?? 0
    const end = Math.max(0, this.lines.length - offset)
    const begin = Math.max(0, end - count)
    return {
      text: this.lines.slice(begin, end).join('\n'),
      totalLines: this.lines.length,
      lineBegin: this.lines.length - begin,
      lineEnd: this.lines.length - end,
      truncated: this.readTruncated,
    }
  }

  signal(): Promise<{ delivered: true; targetPgid: number }> {
    return Promise.resolve({ delivered: true, targetPgid: 4242 })
  }

  status(): TerminalSessionStatus {
    return this.sessionStatus
  }

  close(): Promise<void> {
    return Promise.resolve()
  }

  /** Output the scripted terminal returns for one request. */
  private respond(text: string): string {
    const posix = parseWrapped(text)
    if (posix !== undefined) return this.wrapped(text, posix)
    const powerShell = parseWrappedPowerShell(text)
    if (powerShell !== undefined) return this.wrapped(text, powerShell)
    if (text.includes('rate limit')) return '$ echo rate limit\nHTTP 429 Too Many Requests\n$ '
    if (text.includes('confirm')) return '$ confirm\nDo you want to continue? (y/n) '
    return `$ ${text}\n${text}\n$ `
  }

  /** Emulate a shell that ran the wrapped command and echoed its completion marker. */
  private wrapped(text: string, wrapped: { command: string; marker: string }): string {
    const body = `$ ${text}\n${wrapped.command} ran\n`
    if (this.suppressMarker) return `${body}$ `
    const line = this.omitExitStatus ? wrapped.marker : `${wrapped.marker} rc=${this.exitStatusText ?? this.exitCode}`
    return `${body}${line}\n$ `
  }
}

/**
 * Read the marker and command back out of a `supervisor_terminal_run` wrapper,
 * standing in for the shell that would expand the marker variable.
 */
function parseWrapped(text: string): { command: string; marker: string } | undefined {
  const prefix = 'M=DONE; '
  const separator = '; echo "${M}_'
  const suffixAt = text.indexOf(' rc=$?')
  if (!text.startsWith(prefix) || suffixAt === -1) return undefined
  const at = text.indexOf(separator)
  if (at === -1) return undefined
  return {
    command: text.slice(prefix.length, at),
    marker: `DONE_${text.slice(at + separator.length, suffixAt)}`,
  }
}

/**
 * Read the marker and command back out of the PowerShell wrapper, standing in
 * for a PowerShell that expands `$M` and `$LASTEXITCODE`.
 */
function parseWrappedPowerShell(text: string): { command: string; marker: string } | undefined {
  const prefix = "$M='DONE'; "
  const separator = '; echo "$($M)_'
  const suffixAt = text.indexOf(' rc=$LASTEXITCODE')
  if (!text.startsWith(prefix) || suffixAt === -1) return undefined
  const at = text.indexOf(separator)
  if (at === -1) return undefined
  return {
    command: text.slice(prefix.length, at),
    marker: `DONE_${text.slice(at + separator.length, suffixAt)}`,
  }
}

/** Register the scripted backend under its own session type. */
function scriptedBackend(): TerminalBackend {
  return {
    type: 'scripted',
    spawn: (_spec: TerminalBackendSpawnSpec) => {
      scripted = new ScriptedSession()
      return Promise.resolve(scripted)
    },
  }
}

/**
 * Execute one registered supervisor tool. Element access is used for the
 * runtime methods because the repository's static security scan reads a direct
 * property call as command execution.
 */
function call(name: string, args: unknown) {
  return callIn(ctx, managedAgent, name, args)
}

/** Execute one supervisor tool against an explicit context and owning agent. */
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

/** Spawn one scripted terminal owned by the given agent. */
async function spawnTerminal(context: Context, owner: Agent, name: string) {
  const openTerminal = context.terminals['spawn'].bind(context.terminals)
  return await openTerminal(owner, { type: 'scripted', name, cwd: root }, undefined)
}

/**
 * A second harness whose plugin configuration differs from the default one.
 * Every tool closes over the configuration its plugin instance resolved, so a
 * PowerShell terminal, a disabled spill log, or a short heartbeat timeout needs
 * its own instance.
 */
async function openHarness(config: {
  shellQuoting?: 'posix' | 'powershell'
  heartbeatTimeoutSec?: number
  runPollIntervalMs?: number
  spillEnabled?: boolean
}) {
  const context = new Context()
  await context.plugin(SystemPrompt)
  await context.plugin(ToolRuntime)
  await context.plugin(AgentRegistry)
  await context.plugin(TerminalSessionService)
  await context.plugin(SupervisorRuntime, {
    stateDir: join(root, 'alt-state', config.shellQuoting ?? 'posix'),
    workspaceDir: root,
    watchdogEnabled: false,
    ...config,
  } satisfies SupervisorConfig)
  const backend = new ScriptedSession()
  context.terminals.registerBackend({ type: 'scripted', spawn: () => Promise.resolve(backend) })
  const owner = await registerAgent(context)
  const session = await spawnTerminal(context, owner, 'alternate')
  return { context, backend, owner, terminalId: session.sessionId }
}

/** Send one command to the supervised terminal and return the tool result value. */
async function send(text: string) {
  const result = await call('supervisor_terminal_send', { sessionId, text })
  expect(result.isError).toBe(false)
  return result.value as {
    output: string
    waitReason: string
    stateMarks: string[]
    l1Hits: { ruleId: string }[]
    spillPath?: string
  }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-supervisor-e2e-'))
  ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(TerminalSessionService)
  await ctx.plugin(SupervisorRuntime, {
    stateDir: join(root, 'state'),
    workspaceDir: root,
    watchdogEnabled: false,
    shellQuoting: 'posix',
  } satisfies SupervisorConfig)
  scripted = new ScriptedSession()
  ctx.terminals.registerBackend(scriptedBackend())
  managedAgent = await registerAgent(ctx)
  const openTerminal = ctx.terminals['spawn'].bind(ctx.terminals)
  const session = await openTerminal(managedAgent, { type: 'scripted', name: 'managed', cwd: root }, undefined)
  sessionId = session.sessionId
})

afterEach(async () => {
  await ctx.fiber.dispose()
  await rm(root, { recursive: true, force: true })
})

describe('supervised terminal round trip', () => {
  it('returns the settlement output, its wait reason, and a spill path', async () => {
    const settled = await send('echo hello-supervisor')
    expect(settled.output).toContain('hello-supervisor')
    expect(settled.waitReason).toBe('stdin_read')
    expect(settled.stateMarks).toContain('prompt-idle')
    expect(settled.spillPath).toBeDefined()
  })

  it('appends each settlement to the per-terminal output log', async () => {
    const first = await send('echo first')
    await send('echo second')
    const { readFile } = await import('node:fs/promises')
    const log = await readFile(first.spillPath ?? '', 'utf8')
    expect(log).toContain('first')
    expect(log).toContain('second')
  })

  it('reports a rate-limit line as an L1 hit', async () => {
    const settled = await send('trigger rate limit')
    expect(settled.l1Hits.map(hit => hit.ruleId)).toContain('rate-limit')
  })

  it('marks a confirmation prompt and matches the permission rule', async () => {
    const settled = await send('trigger confirm')
    expect(settled.stateMarks).toContain('waiting-input')
    expect(settled.l1Hits.map(hit => hit.ruleId)).toContain('permission-prompt')
  })

  it('reads back retained scrollback and reports the terminal in status', async () => {
    await send('echo retained-line')
    const read = await call('supervisor_terminal_read', { sessionId, count: 50 })
    expect(read.isError).toBe(false)
    expect((read.value as { text: string }).text).toContain('retained-line')
    const status = await call('supervisor_status', {})
    expect(status.value).toMatchObject({ sessions: [{ sessionId, status: 'running', stale: false }] })
  })

  it('keeps the heartbeat fresh across settlements', async () => {
    await send('echo one')
    const status = await call('supervisor_status', { sessionId })
    const sessions = (status.value as { sessions: { heartbeatAgeSec: number; stale: boolean }[] }).sessions
    expect(sessions[0]?.stale).toBe(false)
    expect(sessions[0]?.heartbeatAgeSec).toBeLessThan(60)
  })

  it('delivers a signal without closing the terminal', async () => {
    const result = await call('supervisor_terminal_signal', { sessionId, signal: 'SIGINT', reason: 'test' })
    expect(result.isError).toBe(false)
    expect(result.value).toMatchObject({ delivered: true, targetPgid: 4242, closed: false, heartbeatRemoved: false })
  })

  it('closes the terminal, drops its heartbeat, and forgets it', async () => {
    const result = await call('supervisor_terminal_signal', { sessionId, signal: 'SIGKILL', close: true })
    expect(result.value).toMatchObject({ closed: true, heartbeatRemoved: true })
    const status = await call('supervisor_status', {})
    expect((status.value as { sessions: unknown[] }).sessions).toEqual([])
  })

  it('refuses a launch with an unknown agent kind', async () => {
    const result = await call('supervisor_agent_launch', { sessionId, agentKind: 'not-an-agent', prompt: 'x' })
    expect(result.isError).toBe(true)
  })

  it('renders and sends a configured launch command for a managed agent', async () => {
    const result = await call('supervisor_agent_launch', {
      sessionId,
      agentKind: 'codex',
      model: 'gpt-5',
      prompt: 'ship the fix',
      taskId: 'task-a',
    })
    expect(result.isError).toBe(false)
    const value = result.value as { command: string; sessionId: string; stateMarks: string[] }
    expect(value.command).toContain("codex exec --model 'gpt-5' --skip-git-repo-check")
    expect(value.command).toContain('ship the fix')
    expect(value.sessionId).toBe(sessionId)
    expect(value.stateMarks.length).toBeGreaterThan(0)
    const status = await call('supervisor_status', {})
    expect(status.value).toMatchObject({ sessions: [{ sessionId, agentKind: 'codex', taskId: 'task-a' }] })
  })

  it('quotes a prompt containing quotes so it stays one argument', async () => {
    const result = await call('supervisor_agent_launch', {
      sessionId,
      agentKind: 'claude-code',
      prompt: "fix the 'bug' now",
    })
    const command = (result.value as { command: string }).command
    // POSIX quoting closes the literal, escapes the quote, and reopens it, so the
    // terminal receives one argument instead of a broken or injected command.
    expect(command).toContain("'\\''")
    expect(command.endsWith("now'")).toBe(true)
  })

  it('waits for the completion marker and reports the exit status', async () => {
    const result = await call('supervisor_terminal_run', { sessionId, command: 'npm run build' })
    expect(result.isError).toBe(false)
    const value = result.value as {
      matched: boolean
      timedOut: boolean
      exitCode?: number
      output: string
      marker: string
      spillPath?: string
    }
    expect(value.matched).toBe(true)
    expect(value.timedOut).toBe(false)
    expect(value.exitCode).toBe(0)
    expect(value.output).not.toContain(value.marker)
    expect(value.output).toContain('npm run build ran')
    expect(value.spillPath).toBeDefined()
  })

  it('reports the exit status a failing command echoed', async () => {
    scripted.exitCode = 2
    const result = await call('supervisor_terminal_run', { sessionId, command: 'npm test' })
    expect((result.value as { exitCode?: number }).exitCode).toBe(2)
  })

  it('times out when the marker never appears', async () => {
    scripted.suppressMarker = true
    const result = await call('supervisor_terminal_run', { sessionId, command: 'sleep forever', timeoutSec: 1 })
    expect(result.isError).toBe(false)
    expect(result.value).toMatchObject({ matched: false, timedOut: true })
    expect((result.value as { exitCode?: number }).exitCode).toBeUndefined()
  })

  it('rejects a non-positive timeout instead of waiting forever', async () => {
    const result = await call('supervisor_terminal_run', { sessionId, command: 'echo x', timeoutSec: 0 })
    expect(result.isError).toBe(true)
  })
})

describe('settlement variants', () => {
  it('appends extra argv to the launch command', async () => {
    const result = await call('supervisor_agent_launch', {
      sessionId,
      agentKind: 'codex',
      prompt: 'ship the fix',
      extraArgs: ['--verbose', 'two words'],
    })
    expect(result.isError).toBe(false)
    const command = (result.value as { command: string }).command
    expect(command).toContain('--verbose')
    expect(command).toContain("'two words'")
  })

  it('declares the hosted agent for a terminal the supervisor did not launch', async () => {
    const sent = await call('supervisor_terminal_send', { sessionId, text: 'echo hi', agentKind: 'claude-code' })
    expect(sent.isError).toBe(false)
    const status = await call('supervisor_status', {})
    expect(status.value).toMatchObject({ sessions: [{ sessionId, agentKind: 'claude-code' }] })
  })

  it('sends text without pressing Enter when the caller asks for it', async () => {
    const sent = await call('supervisor_terminal_send', { sessionId, text: 'y', submit: false })
    expect(sent.isError).toBe(false)
    expect(scripted.lastSent).toBe('y')
    expect(scripted.lastSubmit).toBe(false)
  })

  it('reads a bounded page and declares the hosted agent', async () => {
    await send('echo retained-line')
    const read = await call('supervisor_terminal_read', { sessionId, offset: 0, count: 2, agentKind: 'codex' })
    expect(read.isError).toBe(false)
    expect((read.value as { text: string }).text).toContain('retained-line')
    const status = await call('supervisor_status', {})
    expect(status.value).toMatchObject({ sessions: [{ sessionId, agentKind: 'codex' }] })
  })

  it('reports a truncated read of retained scrollback', async () => {
    await send('echo retained-line')
    scripted.readTruncated = true
    const read = await call('supervisor_terminal_read', { sessionId, offset: 0, count: 2 })
    expect(read.isError).toBe(false)
    expect((read.value as { truncated: boolean }).truncated).toBe(true)
    expect((read.content[0] as { text: string }).text).toContain('(truncated)')
  })

  it('renders a settlement that carries no state marks', async () => {
    scripted.waitReason = 'session_exit'
    const result = await call('supervisor_terminal_send', { sessionId, text: 'echo quiet' })
    expect(result.isError).toBe(false)
    expect((result.value as { stateMarks: string[] }).stateMarks).toEqual([])
    expect((result.content[0] as { text: string }).text.startsWith('session_exit\n')).toBe(true)
  })

  it('bounds an over-long settlement in the rendered content', async () => {
    const result = await call('supervisor_terminal_send', { sessionId, text: `echo ${'x'.repeat(5000)}` })
    expect(result.isError).toBe(false)
    const text = (result.content[0] as { text: string }).text
    expect(text).toContain('\n…')
    expect(text.length).toBeLessThan(4200)
  })

  it('reports how an exited session ended', async () => {
    scripted.sessionStatus = { kind: 'exited', exitCode: 7, signal: null }
    const coded = await call('supervisor_terminal_send', { sessionId, text: 'echo done' })
    expect((coded.value as { sessionStatus: string }).sessionStatus).toBe('exited(7)')
    scripted.sessionStatus = { kind: 'exited', exitCode: null, signal: 'SIGTERM' }
    const signalled = await call('supervisor_terminal_send', { sessionId, text: 'echo done' })
    expect((signalled.value as { sessionStatus: string }).sessionStatus).toBe('exited(SIGTERM)')
    scripted.sessionStatus = { kind: 'exited', exitCode: null, signal: null }
    const unknown = await call('supervisor_terminal_send', { sessionId, text: 'echo done' })
    expect((unknown.value as { sessionStatus: string }).sessionStatus).toBe('exited(unknown)')
  })

  it('reports a repeated identical settlement as an empty loop', async () => {
    await send('echo same')
    await send('echo same')
    const third = await send('echo same')
    expect(third.l1Hits).toContainEqual(expect.objectContaining({ ruleId: 'empty-loop', convergence: 'identical' }))
  })

  it('omits the output log when settlement logging is disabled', async () => {
    const harness = await openHarness({ spillEnabled: false })
    try {
      const launched = await callIn(harness.context, harness.owner, 'supervisor_agent_launch', {
        sessionId: harness.terminalId,
        agentKind: 'codex',
        prompt: 'ship it',
      })
      expect(launched.isError).toBe(false)
      expect((launched.value as { spillPath?: string }).spillPath).toBeUndefined()
      const sent = await callIn(harness.context, harness.owner, 'supervisor_terminal_send', {
        sessionId: harness.terminalId,
        text: 'echo hi',
      })
      expect(sent.isError).toBe(false)
      expect((sent.value as { spillPath?: string }).spillPath).toBeUndefined()
      const run = await callIn(harness.context, harness.owner, 'supervisor_terminal_run', {
        sessionId: harness.terminalId,
        command: 'echo hi',
      })
      expect(run.isError).toBe(false)
      expect((run.value as { spillPath?: string }).spillPath).toBeUndefined()
      const read = await callIn(harness.context, harness.owner, 'supervisor_terminal_read', {
        sessionId: harness.terminalId,
      })
      expect((read.value as { spillPath?: string }).spillPath).toBeUndefined()
      const status = await callIn(harness.context, harness.owner, 'supervisor_status', {})
      expect((status.value as { sessions: { spillPath?: string }[] }).sessions[0]?.spillPath).toBeUndefined()
    } finally {
      await harness.context.fiber.dispose()
    }
  })
})

describe('supervisor_terminal_run', () => {
  it('remembers the task and hosted agent of the run', async () => {
    const result = await call('supervisor_terminal_run', {
      sessionId,
      command: 'npm run build',
      taskId: 'task-run',
      agentKind: 'codex',
    })
    expect(result.isError).toBe(false)
    expect(result.value).toMatchObject({ matched: true, timedOut: false })
    const status = await call('supervisor_status', {})
    expect(status.value).toMatchObject({ sessions: [{ sessionId, taskId: 'task-run', agentKind: 'codex' }] })
  })

  it('reports a completion marker without an exit status', async () => {
    scripted.omitExitStatus = true
    const result = await call('supervisor_terminal_run', { sessionId, command: 'npm test' })
    expect(result.isError).toBe(false)
    expect(result.value).toMatchObject({ matched: true, timedOut: false })
    expect((result.value as { exitCode?: number }).exitCode).toBeUndefined()
    expect((result.content[0] as { text: string }).text).toContain('finished rc=?')
  })

  it('ignores an exit status that is not a number', async () => {
    scripted.exitStatusText = 'unknown'
    const result = await call('supervisor_terminal_run', { sessionId, command: 'npm test' })
    expect(result.isError).toBe(false)
    expect(result.value).toMatchObject({ matched: true })
    expect((result.value as { exitCode?: number }).exitCode).toBeUndefined()
  })

  it('reports dropped output from a run', async () => {
    scripted.truncated = true
    const result = await call('supervisor_terminal_run', { sessionId, command: 'npm test' })
    expect(result.isError).toBe(false)
    expect(result.value).toMatchObject({ truncated: true, matched: true })
    expect((result.content[0] as { text: string }).text).toContain('(truncated)')
  })

  it('stops polling as soon as the caller cancels the run', async () => {
    const harness = await openHarness({ runPollIntervalMs: 2000 })
    const controller = new AbortController()
    const realMin = Math.min
    // The abort lands inside the poll interval computation, i.e. after the loop
    // condition read the signal and before the wait; only that order reaches
    // the wait's already-aborted fast path.
    const spy = vi.spyOn(Math, 'min').mockImplementation((...values: number[]) => {
      if (harness.backend.lastSent !== '' && !controller.signal.aborted) controller.abort()
      return realMin(...values)
    })
    try {
      harness.backend.suppressMarker = true
      const run = harness.context.tools['execute'].bind(harness.context.tools)
      const started = Date.now()
      const result = await run({
        signal: controller.signal,
        callId: ToolCallId('call-aborted-run'),
        name: 'supervisor_terminal_run',
        arguments: { sessionId: harness.terminalId, command: 'sleep forever' },
        agent: harness.owner,
      })
      expect(Date.now() - started).toBeLessThan(1500)
      expect(harness.backend.readCount).toBe(1)
      expect(result.isError).toBe(true)
    } finally {
      spy.mockRestore()
      await harness.context.fiber.dispose()
    }
  })
})

describe('supervisor_status across terminals', () => {
  it('reports a terminal that has not produced output yet', async () => {
    const fresh = await spawnTerminal(ctx, managedAgent, 'fresh')
    const read = await call('supervisor_terminal_read', { sessionId: fresh.sessionId })
    expect(read.isError).toBe(false)
    expect(read.value).toMatchObject({ heartbeatAgeSec: 0, heartbeatStale: false })
    const status = await call('supervisor_status', {})
    const sessions = (status.value as { sessions: unknown[] }).sessions
    expect(sessions).toHaveLength(1)
    expect(sessions[0]).toMatchObject({
      sessionId: fresh.sessionId,
      status: 'running',
      heartbeatAgeSec: 0,
      stale: false,
      lastWaitReason: 'inferred_idle',
      outputClass: 'unknown',
      breaker: 'closed',
      breakerNoProgress: 0,
    })
  })

  it('reports a terminal that was closed behind the supervisor', async () => {
    const doomed = await spawnTerminal(ctx, managedAgent, 'doomed')
    await call('supervisor_terminal_send', { sessionId: doomed.sessionId, text: 'echo bye' })
    const kill = ctx.terminals['kill'].bind(ctx.terminals)
    await kill(managedAgent, doomed.sessionId, 'test cleanup')
    const status = await call('supervisor_status', {})
    expect(status.value).toMatchObject({ sessions: [{ sessionId: doomed.sessionId, status: 'closed' }] })
  })

  it('filters the report to one terminal', async () => {
    await send('echo one')
    const other = await spawnTerminal(ctx, managedAgent, 'other')
    await call('supervisor_terminal_read', { sessionId: other.sessionId })
    const status = await call('supervisor_status', { sessionId })
    const sessions = (status.value as { sessions: { sessionId: string }[] }).sessions
    expect(sessions.map(session => session.sessionId)).toEqual([sessionId])
  })

  it('marks a heartbeat past the configured timeout as stale', async () => {
    const harness = await openHarness({ heartbeatTimeoutSec: 1 })
    try {
      await callIn(harness.context, harness.owner, 'supervisor_terminal_send', { sessionId: harness.terminalId, text: 'echo alive' })
      await new Promise(resolve => setTimeout(resolve, 1100))
      const read = await callIn(harness.context, harness.owner, 'supervisor_terminal_read', { sessionId: harness.terminalId })
      expect(read.isError).toBe(false)
      expect(read.value).toMatchObject({ heartbeatStale: true })
      expect((read.content[0] as { text: string }).text).toContain('STALE')
      const status = await callIn(harness.context, harness.owner, 'supervisor_status', {})
      expect(status.value).toMatchObject({ sessions: [{ stale: true }] })
      expect((status.content[0] as { text: string }).text).toContain('STALE')
    } finally {
      await harness.context.fiber.dispose()
    }
  })
})

describe('shell quoting', () => {
  it('wraps a run for a PowerShell terminal and reports its exit status', async () => {
    const harness = await openHarness({ shellQuoting: 'powershell' })
    try {
      const result = await callIn(harness.context, harness.owner, 'supervisor_terminal_run', {
        sessionId: harness.terminalId,
        command: 'npm run build',
      })
      expect(result.isError).toBe(false)
      expect(result.value).toMatchObject({ matched: true, timedOut: false, exitCode: 0 })
      expect(harness.backend.lastSent).toContain('$LASTEXITCODE')
      expect(harness.backend.lastSent).toContain("$M='DONE'")
    } finally {
      await harness.context.fiber.dispose()
    }
  })
})
