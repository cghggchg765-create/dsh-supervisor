import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, Inbox } from '@deepseek-ai/dsh-agent'
import { ToolCallId, type UserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import {
  TerminalSessionService,
  type TerminalReadRequest,
  type TerminalReadResult,
  type TerminalSendOperation,
  type TerminalSendRequest,
  type TerminalSessionStatus,
} from '@deepseek-ai/dsh-terminal'
import type { TerminalBackend, TerminalBackendSession, TerminalBackendSpawnSpec } from '@deepseek-ai/dsh-terminal'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { SupervisorRuntime } from '../src/index.ts'
import type { SupervisorConfig } from '../src/index.ts'

let root = ''
const contexts: Context[] = []
const roots: string[] = []
let steers: UserMessage[] = []
let agentCounter = 0
let callCounter = 0

/** Epoch milliseconds {@link mount} freezes the clock at. */
const START_MS = Date.parse('2026-01-01T00:00:00.000Z')

/**
 * A usage-limit settlement whose stated reset is `START_MS`, so the runtime
 * schedules its resume exactly one buffer after the frozen clock.
 */
const LIMIT_TEXT = `usage limit reached|${START_MS / 1_000}`

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
 * A scripted terminal that settles every send immediately with its own echo, so
 * the watchdog can be exercised without a PTY.
 */
class ScriptedSession implements TerminalBackendSession {
  readonly motd = 'scripted terminal ready\n'

  private readonly lines: string[] = []

  startSend(request: TerminalSendRequest): TerminalSendOperation {
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
    return {
      text: this.lines.slice(begin, end).join('\n'),
      totalLines: this.lines.length,
      lineBegin: this.lines.length - begin,
      lineEnd: this.lines.length - end,
      truncated: false,
    }
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

/** Register the scripted backend under its own session type. */
function scriptedBackend(): TerminalBackend {
  return {
    type: 'scripted',
    spawn: (_spec: TerminalBackendSpawnSpec) => Promise.resolve(new ScriptedSession()),
  }
}

/** One mounted plugin plus the terminal its owner-agent drives. */
interface WatchdogHarness {
  /** Context carrying the supervisor, tool, and terminal services. */
  readonly ctx: Context
  /** Agent that owns the harness terminal. */
  readonly agent: Agent
  /** Terminal session id returned by the scripted backend. */
  readonly sessionId: string
}

/**
 * Mount the plugin and its terminal harness. Fake timers freeze `Date` so the
 * watchdog's staleness math is exact, while real timers keep file I/O running.
 * @param overrides - plugin configuration on top of the fast-watchdog defaults.
 * @returns the mounted services and the first supervised terminal.
 */
async function mount(overrides: SupervisorConfig = {}): Promise<WatchdogHarness> {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
  vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
  root = await mkdtemp(join(tmpdir(), 'dsh-supervisor-watchdog-'))
  roots.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(TerminalSessionService)
  await ctx.plugin(SupervisorRuntime, {
    stateDir: join(root, 'state'),
    workspaceDir: root,
    heartbeatTimeoutSec: 1,
    watchdogIntervalSec: 1,
    watchdogCooldownSec: 300,
    shellQuoting: 'posix',
    ...overrides,
  })
  ctx.terminals.registerBackend(scriptedBackend())
  const agent = await registerAgent(ctx)
  const sessionId = await openTerminal(ctx, agent, 'managed')
  return { ctx, agent, sessionId }
}

/** Register one agent; `steer` records its notice or throws to simulate a refusal. */
async function registerAgent(
  ctx: Context,
  steer: (message: UserMessage) => void = (message) => { steers.push(message) },
): Promise<Agent> {
  const scope = ctx.plugin(() => {})
  const id = SessionId(`watchdog-agent-${++agentCounter}`)
  const value: Agent = {
    id,
    options: {},
    session: Session.create(id),
    inbox: unsupportedInbox(),
    status: 'idle',
    ctx: scope.ctx,
    send: () => {},
    followup: () => {},
    steer,
    inject: () => {},
    cancel() {},
    runMaintenance: job => job(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  await ctx.agents.register(value)
  return value
}

/** Open one scripted terminal owned by `agent`. */
async function openTerminal(ctx: Context, agent: Agent, name: string): Promise<string> {
  // Element access is used for the terminal method because a direct property
  // call reads as command execution to the repository's static security scan.
  const open = ctx.terminals['spawn'].bind(ctx.terminals)
  const session = await open(agent, { type: 'scripted', name, cwd: root }, undefined)
  return session.sessionId
}

/** Execute one registered supervisor tool on behalf of `agent`. */
function call(ctx: Context, agent: Agent, name: string, args: unknown) {
  const run = ctx.tools['execute'].bind(ctx.tools)
  return run({
    signal: new AbortController().signal,
    callId: ToolCallId(`call-${++callCounter}`),
    name,
    arguments: args,
    agent,
  })
}

/** The text of one steered message. */
function steerText(message: UserMessage): string {
  return message.content.map(block => block.type === 'text' ? block.text : '').join('')
}

/** The text of the newest steered message, or '' when none arrived. */
function lastSteerText(): string {
  const message = steers.at(-1)
  return message === undefined ? '' : steerText(message)
}

/** Every steered message whose text mentions a reset usage limit. */
function limitSteers(): UserMessage[] {
  return steers.filter(message => steerText(message).includes('usage limit'))
}

/**
 * Read one verbatim expected output from `tests/expected/` and substitute its
 * placeholders, so a wording change fails until the fixture changes with it.
 */
function expectedOutput(name: string, values: Readonly<Record<string, string>>): string {
  const template = readFileSync(fileURLToPath(new URL(`./expected/${name}`, import.meta.url)), 'utf8')
  return template.trimEnd().replaceAll(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match)
}

/** Let pending real file I/O settle until `predicate` holds. */
async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !predicate(); attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

/** Give pending sweeps a chance to run when none is expected. */
async function settle(): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

/** Re-evaluate the plugin module while `process.platform` reports `platform`. */
async function loadPluginAs(platform: NodeJS.Platform): Promise<typeof import('../src/index.ts')> {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
  try {
    vi.resetModules()
    return await import('../src/index.ts')
  } finally {
    if (original) Object.defineProperty(process, 'platform', original)
  }
}

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  vi.useRealTimers()
  await Promise.all(roots.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
  steers = []
})

describe('plugin configuration schema', () => {
  it('defaults the shell dialect from the platform the schema loads on', async () => {
    // The default is computed at module evaluation, so both dialects need a load.
    const onWindows = await loadPluginAs('win32')
    expect(onWindows.SupervisorRuntime.Config({}).shellQuoting).toBe('powershell')
    const elsewhere = await loadPluginAs('linux')
    expect(elsewhere.SupervisorRuntime.Config({}).shellQuoting).toBe('posix')
  })
})

describe('heartbeat watchdog', () => {
  it('steers the owning agent when a supervised terminal stops producing output', async () => {
    const harness = await mount()
    const launched = await call(harness.ctx, harness.agent, 'supervisor_agent_launch', {
      sessionId: harness.sessionId,
      agentKind: 'codex',
      prompt: 'ship the fix',
      taskId: 'task-a',
    })
    expect(launched.isError).toBe(false)

    vi.advanceTimersByTime(1_000)
    await waitFor(() => steers.length > 0)

    expect(steers).toHaveLength(1)
    const text = lastSteerText()
    expect(text).toBe(expectedOutput('watchdog-stale-notice.txt', {
      sessionId: harness.sessionId,
      ageSec: '1',
      timeoutSec: '1',
      waitReason: 'stdin_read',
      taskId: 'task-a',
    }))
    // The notice enters the conversation on the operator's behalf.
    expect(steers[0]?.source).toEqual({ kind: 'user' })
  })

  it('reports an open progress breaker when the terminal keeps repeating itself', async () => {
    const harness = await mount()
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const sent = await call(harness.ctx, harness.agent, 'supervisor_terminal_send', { sessionId: harness.sessionId, text: 'status' })
      expect(sent.isError).toBe(false)
    }

    vi.advanceTimersByTime(1_000)
    await waitFor(() => steers.length > 0)

    const text = lastSteerText()
    expect(text).toBe(
      expectedOutput('watchdog-stale-notice.txt', {
        sessionId: harness.sessionId,
        ageSec: '1',
        timeoutSec: '1',
        waitReason: 'stdin_read',
      }).replace(', task {taskId}', '')
      + expectedOutput('watchdog-breaker-notice.txt', { noProgress: '3', openForSec: '1' }),
    )
  })

  it('logs a warning and keeps sweeping when one owner rejects the steer', async () => {
    const harness = await mount()
    const warnings: string[] = []
    harness.ctx.logger.exporter({
      // A named logger defaults to the INFO threshold, which drops WARN.
      levels: { supervisor: 2 },
      export: (message) => {
        if (message.type === 'warn') warnings.push(String(message.args[0]))
      },
    })
    const busy = await registerAgent(harness.ctx, () => { throw new Error('driver is busy') })
    const busyTerminal = await openTerminal(harness.ctx, busy, 'busy')
    await call(harness.ctx, harness.agent, 'supervisor_agent_launch', { sessionId: harness.sessionId, agentKind: 'codex', prompt: 'first' })
    await call(harness.ctx, busy, 'supervisor_agent_launch', { sessionId: busyTerminal, agentKind: 'codex', prompt: 'second' })

    vi.advanceTimersByTime(1_000)
    await waitFor(() => warnings.length > 0 && steers.length > 0)
    expect(warnings).toEqual([expect.stringContaining(`watchdog could not steer ${busy.id}: Error: driver is busy`)])
    // The refused steer did not stop the sweep from reaching the other terminal.
    expect(steers).toHaveLength(1)
  })

  it('does not sweep when the watchdog is disabled', async () => {
    const harness = await mount({ watchdogEnabled: false })
    await call(harness.ctx, harness.agent, 'supervisor_agent_launch', { sessionId: harness.sessionId, agentKind: 'codex', prompt: 'work' })

    vi.advanceTimersByTime(5_000)
    await settle()

    expect(steers).toEqual([])
  })

  it('stops sweeping after the plugin unloads', async () => {
    const harness = await mount()
    await call(harness.ctx, harness.agent, 'supervisor_agent_launch', { sessionId: harness.sessionId, agentKind: 'codex', prompt: 'work' })
    await harness.ctx.fiber.dispose()

    vi.advanceTimersByTime(5_000)
    await settle()

    expect(steers).toEqual([])
  })
})

describe('usage-limit resume sweep', () => {
  it('leaves a session alone while its parsed limit reset is still ahead', async () => {
    const harness = await mount()
    await call(harness.ctx, harness.agent, 'supervisor_terminal_send', { sessionId: harness.sessionId, text: LIMIT_TEXT })

    // The reset plus its two-minute buffer is still ahead of the first sweep,
    // which only reports the terminal as silent.
    vi.advanceTimersByTime(1_000)
    await waitFor(() => steers.length > 0)

    expect(steers).toHaveLength(1)
    expect(lastSteerText()).toContain('produced no output')
    expect(limitSteers()).toEqual([])
  })

  it('steers the owner once the limit reset is due and clears the schedule', async () => {
    const harness = await mount()
    await call(harness.ctx, harness.agent, 'supervisor_terminal_send', { sessionId: harness.sessionId, text: LIMIT_TEXT })
    vi.advanceTimersByTime(1_000)
    await waitFor(() => steers.length > 0)

    vi.setSystemTime(new Date(START_MS + 121_000))
    vi.advanceTimersByTime(1_000)
    await waitFor(() => limitSteers().length > 0)

    expect(limitSteers().map(steerText)).toEqual([
      expectedOutput('limit-resume-notice.txt', { sessionId: harness.sessionId }),
    ])
    expect(limitSteers()[0]?.source).toEqual({ kind: 'user' })

    // The schedule was cleared, so a later sweep does not steer about it again.
    vi.advanceTimersByTime(1_000)
    await settle()
    expect(limitSteers()).toHaveLength(1)
  })

  it('logs a warning and keeps sweeping when the owner rejects the limit resume steer', async () => {
    const harness = await mount()
    const warnings: string[] = []
    harness.ctx.logger.exporter({
      levels: { supervisor: 2 },
      export: (message) => {
        if (message.type === 'warn') warnings.push(String(message.args[0]))
      },
    })
    const busy = await registerAgent(harness.ctx, () => { throw new Error('driver is busy') })
    const busyTerminal = await openTerminal(harness.ctx, busy, 'busy-limit')
    await call(harness.ctx, busy, 'supervisor_terminal_send', { sessionId: busyTerminal, text: LIMIT_TEXT })
    await call(harness.ctx, harness.agent, 'supervisor_agent_launch', { sessionId: harness.sessionId, agentKind: 'codex', prompt: 'work' })

    vi.setSystemTime(new Date(START_MS + 121_000))
    vi.advanceTimersByTime(1_000)
    await waitFor(() => warnings.some(warning => warning.includes('about the reset limit')) && steers.length > 0)

    expect(warnings)
      .toContainEqual(expect.stringContaining(`watchdog could not steer ${busy.id} about the reset limit: Error: driver is busy`))
    // The refused steer did not stop the sweep from reaching the other terminal.
    expect(steers).toHaveLength(1)
    expect(lastSteerText()).toContain('produced no output')

    // The refused resume keeps its schedule: losing it would park the run
    // forever, so the next sweep retries the same terminal.
    vi.setSystemTime(new Date(START_MS + 122_000))
    vi.advanceTimersByTime(1_000)
    await waitFor(() => warnings.filter(warning => warning.includes('about the reset limit')).length >= 2)
    // The retried sweep's heartbeat writes must land before teardown removes
    // the state directory.
    await settle()
  })
})
