import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent, Inbox } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { TerminalSessionId } from '@deepseek-ai/dsh-terminal'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { SupervisorRuntime } from '../src/index.ts'
import { quote, renderCommand, resolveConfig, type SupervisorConfig } from '../src/runtime.ts'

let root = ''

/** A fixed observation instant, so a parsed limit reset is exact. */
const NOW_MS = 1_700_000_000_000

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-supervisor-cfg-'))
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

/** An agent handle carrying only the identity the runtime registry records. */
function agentFor(id: string): Agent {
  const sessionId = SessionId(id)
  return {
    id: sessionId,
    options: {},
    session: Session.create(sessionId),
    inbox: unsupportedInbox(),
    status: 'idle',
    ctx: new Context(),
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject: () => {},
    cancel() {},
    runMaintenance: job => job(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
}

/**
 * A runtime rooted in this test's scratch directory, with optional overrides.
 * The service registers its tools on construction, so the context carries the
 * tool runtime those registrations need.
 */
async function runtimeFor(overrides: SupervisorConfig = {}): Promise<SupervisorRuntime> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const runtime = new SupervisorRuntime(ctx, {
    workspaceDir: root,
    stateDir: join(root, 'state'),
    watchdogEnabled: false,
    ...overrides,
  })
  return runtime
}

/** Run `run` while `process.platform` reports `platform`. */
function withPlatform(platform: NodeJS.Platform, run: () => void): void {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
  try {
    run()
  } finally {
    if (original) Object.defineProperty(process, 'platform', original)
  }
}

describe('configuration resolution', () => {
  it('resolves the state directory against the workspace directory', () => {
    const resolved = resolveConfig({ workspaceDir: root, stateDir: '.supervisor' })
    expect(resolved.stateDir).toBe(resolve(root, '.supervisor'))
    expect(resolved.workspaceDir).toBe(resolve(root))
  })

  it('keeps an absolute state directory as written', () => {
    const absolute = resolve(root, 'elsewhere')
    expect(resolveConfig({ stateDir: absolute }).stateDir).toBe(absolute)
  })

  it('merges configured agent templates over the defaults', () => {
    const resolved = resolveConfig({
      agents: { codex: { startCommand: 'codex --yolo {prompt}' } },
    })
    expect(resolved.agentTemplates.codex.startCommand).toBe('codex --yolo {prompt}')
    // An unspecified field of the same template keeps its default.
    expect(resolved.agentTemplates.codex.resumeCommand).toBe('codex exec resume --last')
    expect(resolved.agentTemplates['claude-code'].startCommand).toContain('claude')
  })

  it('rejects an empty launch command and a non-positive threshold', () => {
    expect(() => resolveConfig({ agents: { dsh: { startCommand: '   ' } } })).toThrow(/non-empty startCommand/)
    expect(() => resolveConfig({ detection: { repeatThreshold: 0 } })).toThrow(/must be a positive number/)
    expect(() => resolveConfig({ detection: { silenceThresholdSec: Number.NaN } })).toThrow(/must be a positive number/)
    expect(() => resolveConfig({ heartbeatTimeoutSec: -1 })).toThrow(/must be a positive number/)
  })

  it('rejects a breaker ladder that is non-positive or can never open', () => {
    expect(() => resolveConfig({ breaker: { noProgressLimit: 0 } }))
      .toThrow(/breaker limit "noProgressLimit" must be a positive integer/)
    expect(() => resolveConfig({ breaker: { openLimit: 1.5 } })).toThrow(/breaker limit "openLimit" must be a positive integer/)
    // openLimit below noProgressLimit would skip HALF-OPEN entirely.
    expect(() => resolveConfig({ breaker: { noProgressLimit: 3, openLimit: 2 } })).toThrow(/must be at least "noProgressLimit"/)
  })

  it('rejects a non-positive size, interval, or timeout limit', () => {
    expect(() => resolveConfig({ spillMaxBytes: 0 })).toThrow(/"spillMaxBytes" must be a positive number/)
    expect(() => resolveConfig({ runTimeoutSec: 0 })).toThrow(/"runTimeoutSec"/)
    expect(() => resolveConfig({ runPollIntervalMs: 0 })).toThrow(/"runPollIntervalMs"/)
    expect(() => resolveConfig({ heartbeatTimeoutSec: 0 })).toThrow(/"heartbeatTimeoutSec"/)
    expect(() => resolveConfig({ watchdogIntervalSec: 0 })).toThrow(/"watchdogIntervalSec"/)
    expect(() => resolveConfig({ watchdogCooldownSec: 0 })).toThrow(/"watchdogCooldownSec"/)
  })

  it('defaults the shell dialect to the host platform', () => {
    expect(resolveConfig({}).shellQuoting).toBe(process.platform === 'win32' ? 'powershell' : 'posix')
  })

  it('selects the configured shell dialect and covers both platform defaults', () => {
    expect(resolveConfig({ shellQuoting: 'none' }).shellQuoting).toBe('none')
    withPlatform('win32', () => { expect(resolveConfig({}).shellQuoting).toBe('powershell') })
    withPlatform('linux', () => { expect(resolveConfig({}).shellQuoting).toBe('posix') })
  })

  it('resolves the worktree base and the newer configuration fields', () => {
    const resolved = resolveConfig({
      workspaceDir: root,
      worktreeBase: join(root, 'absolute-worktrees'),
      defaultProfile: 'audit',
      spillEnabled: false,
      limitResumeEnabled: false,
    })
    // An absolute worktree base is kept as written rather than re-rooted.
    expect(resolved.worktreeBase).toBe(join(root, 'absolute-worktrees'))
    expect(resolved.defaultProfile).toBe('audit')
    expect(resolved.spillEnabled).toBe(false)
    expect(resolved.limitResumeEnabled).toBe(false)
    expect(resolved.runTimeoutSec).toBe(600)
    expect(resolved.runPollIntervalMs).toBe(500)
    expect(resolved.heartbeatTimeoutSec).toBe(300)
    expect(resolved.spillMaxBytes).toBe(5 * 1024 * 1024 * 1024)
    expect(resolved.thresholds.errorStreakThreshold).toBe(3)
    expect(resolved.breaker).toEqual({ noProgressLimit: 2, openLimit: 3, cooldownSec: 300 })
  })

  it('resolves a relative worktree base against the workspace and keeps the defaults', () => {
    const resolved = resolveConfig({ workspaceDir: root, worktreeBase: join('relative', 'worktrees') })
    expect(resolved.worktreeBase).toBe(resolve(root, 'relative', 'worktrees'))
    expect(resolveConfig({ workspaceDir: root }).worktreeBase).toBe(resolve(root, '.worktrees'))
    expect(resolveConfig({ workspaceDir: root }).limitResumeEnabled).toBe(true)
    expect(resolveConfig({ workspaceDir: root }).defaultProfile).toBe('headless')
  })
})

describe('launch command rendering', () => {
  it('quotes a POSIX prompt so embedded quotes stay inside one argument', () => {
    expect(quote("fix the 'bug' now", 'posix')).toBe("'fix the '\\''bug'\\'' now'")
  })

  it('doubles a PowerShell prompt quote', () => {
    expect(quote("fix the 'bug' now", 'powershell')).toBe("'fix the ''bug'' now'")
  })

  it('leaves a value unquoted when quoting is disabled', () => {
    expect(quote('plain text', 'none')).toBe('plain text')
  })

  it('substitutes model, prompt, and profile and collapses the spacing', () => {
    const rendered = renderCommand(
      'dsh --profile {profile} {prompt}',
      { prompt: 'do the thing', profile: 'headless' },
      'posix',
    )
    expect(rendered).toBe("dsh --profile 'headless' 'do the thing'")
  })

  it('drops an absent model without leaving a double space', () => {
    const rendered = renderCommand('claude --model {model} {prompt}', { prompt: 'go', profile: 'headless' }, 'posix')
    expect(rendered).toBe("claude --model 'go'")
  })
})

describe('supervised session registry', () => {
  it('remembers the hosted CLI declared for a terminal and classifies by its characteristics', async () => {
    const runtime = await runtimeFor()
    const owner = agentFor('owner-declare')
    const sessionId = TerminalSessionId('pty-codex')
    runtime.declareAgent(owner, sessionId, 'codex', { kind: 'running' })
    expect(runtime.sessions.get(sessionId)?.agentKind).toBe('codex')
    // Codex prints a bare '›' at its idle prompt; an undeclared terminal has no
    // completion pattern, so the same text stays unclassified.
    const declared = await runtime.inspect(owner, sessionId, '›', { kind: 'running' }, 1_000)
    expect(declared.outputClass).toBe('completed')
    const undeclared = await runtime.inspect(owner, TerminalSessionId('pty-plain'), '›', { kind: 'running' }, 1_000)
    expect(undeclared.outputClass).toBe('unknown')
  })

  it('inspects retained scrollback without advancing the heartbeat or appending to the output log', async () => {
    const runtime = await runtimeFor({ heartbeatTimeoutSec: 30 })
    const owner = agentFor('owner-inspect')
    const sessionId = TerminalSessionId('pty-inspect')
    const settled = await runtime.observe(owner, sessionId, 'line one', 'stdin_read', { kind: 'running' }, 1_000)
    const logPath = settled.spillPath
    expect(logPath).toBeDefined()
    const logBefore = await readFile(logPath ?? '', 'utf8')
    const inspected = await runtime.inspect(owner, sessionId, 'line one', { kind: 'running' }, 40_000)
    expect(inspected.heartbeatStale).toBe(true)
    expect(inspected.marks).toContain('heartbeat-stale')
    // A read of old text is evidence, not progress: the heartbeat and the log stay put.
    expect((await runtime.heartbeats.read(sessionId))?.lastOutputAt).toBe(1_000)
    expect(await readFile(logPath ?? '', 'utf8')).toBe(logBefore)
  })

  it('carries an exited terminal status into the settlement marks and failure window', async () => {
    const runtime = await runtimeFor({ detection: { errorStreakThreshold: 2 } })
    const owner = agentFor('owner-exit')
    const sessionId = TerminalSessionId('pty-exit')
    const clean = await runtime.observe(owner, sessionId, 'finished', 'session_exit', { kind: 'exited', exitCode: 0, signal: null }, 1_000)
    expect(clean.marks).toContain('exit-ok')
    const failed = await runtime.observe(owner, sessionId, 'stopped', 'session_exit', { kind: 'exited', exitCode: 2, signal: null }, 2_000)
    expect(failed.marks).toContain('exit-bad')
    // 'stopped' carries no error keyword; the non-zero exit code is what marks
    // the observation failed, so the second one raises the streak.
    expect(failed.hits.map(hit => hit.ruleId)).not.toContain('error-streak')
    const repeated = await runtime.observe(owner, sessionId, 'stopped', 'session_exit', { kind: 'exited', exitCode: 2, signal: null }, 3_000)
    expect(repeated.hits.map(hit => hit.ruleId)).toContain('error-streak')
  })

  it('omits the spill path when output logging is disabled', async () => {
    const runtime = await runtimeFor({ spillEnabled: false })
    const owner = agentFor('owner-nospill')
    const sessionId = TerminalSessionId('pty-nospill')
    const settled = await runtime.observe(owner, sessionId, 'output', 'stdin_read', { kind: 'running' }, 1_000)
    expect(settled.spillPath).toBeUndefined()
    expect(settled.spillCapped).toBe(false)
    const inspected = await runtime.inspect(owner, sessionId, 'output', { kind: 'running' }, 2_000)
    expect(inspected.spillPath).toBeUndefined()
  })

  it('forgets a closed terminal and tolerates forgetting it twice', async () => {
    const runtime = await runtimeFor()
    const owner = agentFor('owner-forget')
    const sessionId = TerminalSessionId('pty-forget')
    await runtime.observe(owner, sessionId, 'x', 'stdin_read', { kind: 'running' }, 1_000)
    expect(runtime.sessions.has(sessionId)).toBe(true)
    runtime.forget(sessionId)
    expect(runtime.sessions.has(sessionId)).toBe(false)
    expect(() => { runtime.forget(sessionId) }).not.toThrow()
  })

  it('reuses an existing registry entry when another owner takes the terminal', async () => {
    const runtime = await runtimeFor()
    const first = agentFor('owner-first')
    const second = agentFor('owner-second')
    const sessionId = TerminalSessionId('pty-reused')
    runtime.track(first, sessionId, { kind: 'running' })
    const entry = runtime.track(second, sessionId, { kind: 'running' })
    expect(entry.owner).toBe(second)
    expect(runtime.sessions.size).toBe(1)
  })
})

describe('watchdog staleness checks', () => {
  it('ignores an untracked terminal and one that never reported a heartbeat', async () => {
    const runtime = await runtimeFor()
    const owner = agentFor('owner-silent')
    const alerts: string[] = []
    await runtime.checkStaleness('pty-unknown', session => alerts.push(session.sessionId), 1_000)
    runtime.track(owner, TerminalSessionId('pty-silent'), { kind: 'running' })
    await runtime.checkStaleness('pty-silent', session => alerts.push(session.sessionId), 1_000)
    expect(alerts).toEqual([])
  })

  it('records a fresh check without alerting', async () => {
    const runtime = await runtimeFor({ heartbeatTimeoutSec: 30 })
    const owner = agentFor('owner-fresh')
    const sessionId = TerminalSessionId('pty-fresh')
    await runtime.observe(owner, sessionId, 'out', 'stdin_read', { kind: 'running' }, 1_000)
    const alerts: string[] = []
    await runtime.checkStaleness(sessionId, session => alerts.push(session.sessionId), 2_000)
    expect(alerts).toEqual([])
    expect((await runtime.heartbeats.read(sessionId))?.consecutiveStaleChecks).toBe(0)
  })

  it('alerts on a stale heartbeat once per cooldown', async () => {
    const runtime = await runtimeFor({ heartbeatTimeoutSec: 30, watchdogCooldownSec: 5 })
    const owner = agentFor('owner-stale')
    const sessionId = TerminalSessionId('pty-stale')
    await runtime.observe(owner, sessionId, 'out', 'stdin_read', { kind: 'running' }, 1_000)
    const alerts: number[] = []
    await runtime.checkStaleness(sessionId, () => alerts.push(1), 100_000)
    await runtime.checkStaleness(sessionId, () => alerts.push(1), 101_000)
    await runtime.checkStaleness(sessionId, () => alerts.push(1), 106_000)
    expect(alerts).toHaveLength(2)
    expect(runtime.sessions.get(sessionId)?.lastAlertAt).toBe(106_000)
  })
})

describe('usage-limit resume scheduling', () => {
  /** A limit settlement whose stated reset is exactly `NOW_MS`. */
  const LIMIT_TEXT = `usage limit reached|${NOW_MS / 1_000}`
  const RESUME_AT = NOW_MS + 120_000

  it('stores the stated reset plus the resume buffer and reports it', async () => {
    const runtime = await runtimeFor()
    const owner = agentFor('owner-limit')
    const sessionId = TerminalSessionId('pty-limit')
    const report = await runtime.observe(owner, sessionId, LIMIT_TEXT, 'stdin_read', { kind: 'running' }, NOW_MS)
    expect(report.limitResumeAt).toBe(RESUME_AT)
    expect(runtime.sessions.get(sessionId)?.limitResumeAt).toBe(RESUME_AT)
  })

  it('leaves the session unscheduled when the limit states no reset', async () => {
    const runtime = await runtimeFor()
    const owner = agentFor('owner-limit-unparsed')
    const sessionId = TerminalSessionId('pty-limit-unparsed')
    const report = await runtime.observe(owner, sessionId, 'usage limit reached. Try again later.', 'stdin_read', { kind: 'running' }, NOW_MS)
    expect(report.limitResumeAt).toBeUndefined()
    expect(runtime.sessions.get(sessionId)?.limitResumeAt).toBeUndefined()
  })

  it('does not schedule a resume when the limit resume is disabled', async () => {
    const runtime = await runtimeFor({ limitResumeEnabled: false })
    const owner = agentFor('owner-limit-disabled')
    const sessionId = TerminalSessionId('pty-limit-disabled')
    const report = await runtime.observe(owner, sessionId, LIMIT_TEXT, 'stdin_read', { kind: 'running' }, NOW_MS)
    expect(report.limitResumeAt).toBeUndefined()
    expect(runtime.sessions.get(sessionId)?.limitResumeAt).toBeUndefined()
  })

  it('reports no reset for a settlement that states no limit', async () => {
    const runtime = await runtimeFor()
    const owner = agentFor('owner-no-limit')
    const sessionId = TerminalSessionId('pty-no-limit')
    const report = await runtime.observe(owner, sessionId, 'all tests passed', 'stdin_read', { kind: 'running' }, NOW_MS)
    expect(report.limitResumeAt).toBeUndefined()
    expect(runtime.sessions.get(sessionId)?.limitResumeAt).toBeUndefined()
  })
})
