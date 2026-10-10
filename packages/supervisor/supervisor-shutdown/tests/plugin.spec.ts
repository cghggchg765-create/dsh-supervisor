/**
 * Automatic shutdown: the timing logic under a fake clock with the dry run (no
 * shell), and the real execution path against a real shell executor.
 */

import { rm } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { emitAgentEvent } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import LocalBashExecutor from '@deepseek-ai/dsh-bash-local'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import SupervisorRuntime from '@deepseek-ai/dsh-supervisor-core'
import SupervisorOpsService from '@deepseek-ai/dsh-supervisor-ops'
import SupervisorTaskService from '@deepseek-ai/dsh-supervisor-tasks'
import TerminalSessionService from '@deepseek-ai/dsh-terminal'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { TaskPlan } from '@deepseek-ai/dsh-supervisor-core'
import * as shutdown from '../src/index.ts'
import type { ShutdownConfig } from '../src/index.ts'

/** The command the operator gate runs, harmless in tests. */
const SHUTDOWN_COMMAND = 'echo fired'
/** The command the cancel path runs, harmless in tests. */
const CANCEL_COMMAND = 'echo cancelled'

/** Milliseconds in one minute. */
const MINUTE_MS = 60_000

interface Harness {
  readonly ctx: Context
  readonly agent: Agent
  /** Lines the plugin reported. */
  readonly reports: string[]
  /** The shell executor's fiber, disposed to simulate a broken shell. */
  readonly shell: Awaited<ReturnType<Context['plugin']>>
}

interface HarnessOptions {
  /** Apply the plugin as a plain function, so the schema does not fill its defaults. */
  readonly direct?: boolean
}

const contexts: Context[] = []

afterEach(async () => {
  vi.useRealTimers()
  await Promise.allSettled(contexts.splice(0).map(context => context.fiber.dispose()))
  await rm('.supervisor-shutdown-test', { recursive: true, force: true })
})

/** Mount the whole supervisor stack with a real shell and this component. */
async function harness(config: ShutdownConfig = {}, command = SHUTDOWN_COMMAND, options: HarnessOptions = {}): Promise<Harness> {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(LocalSubprocessRuntime)
  const shell = await ctx.plugin(LocalBashExecutor, { cwd: process.cwd() })
  await ctx.plugin(TerminalSessionService)
  await ctx.plugin(SupervisorRuntime, { stateDir: '.supervisor-shutdown-test', workspaceDir: process.cwd(), watchdogEnabled: false })
  await ctx.plugin(SupervisorTaskService)
  await ctx.plugin(SupervisorOpsService, {
    shutdown: { enabled: true, command, gracePeriodMin: 1 },
  })
  if (options.direct === true) shutdown.apply(ctx, config)
  else await ctx.plugin(shutdown, { enabled: true, cancelCommand: CANCEL_COMMAND, pollIntervalSec: 1, ...config })
  await ctx.plugin(AgentLoop, { agents: [] })
  const agent = await ctx.agentLoop.create(SessionId(`shutdown-session-${String(Math.random())}`), { provider: 'mock', model: 'mock' })
  const reports: string[] = []
  ctx.logger.info = ((message: string) => { reports.push(message) }) as never
  return { ctx, agent, reports, shell }
}

/** Call one `supervisor_power` action. */
async function power(test: Harness, args: unknown) {
  const run = test.ctx.tools['execute'].bind(test.ctx.tools)
  return await run({
    signal: new AbortController().signal,
    callId: ToolCallId(`power-${String(Math.random())}`),
    name: 'supervisor_power',
    arguments: args,
    agent: test.agent,
  })
}

/** Write one plan whose subtasks carry the given statuses. */
async function writePlan(test: Harness, taskId: string, statuses: TaskPlan['subTasks'][number]['status'][]): Promise<void> {
  await test.ctx.supervisor.plans.write({
    taskId,
    goal: 'ship it',
    constraints: [],
    acceptanceCriteria: [],
    subTasks: statuses.map((status, index) => ({
      id: `st-${String(index)}`,
      title: `task ${String(index)}`,
      description: 'do it',
      dependsOn: [],
      requiredSkills: [],
      estimatedEffort: 'small' as const,
      acceptanceCriteria: [],
      status,
    })),
    integrationStrategy: 'sequential-merge',
    createdAt: 1,
    updatedAt: 1,
  })
}

/** Advance the fake clock and let real filesystem work settle before the next pass. */
async function pass(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
  await new Promise((resolve) => { setImmediate(resolve) })
}

/** Let real filesystem work settle without advancing the fake clock. */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0)
  for (let turn = 0; turn < 4; turn += 1) await new Promise((resolve) => { setImmediate(resolve) })
}

/** Let every watcher pass already in flight resolve before the next change. */
async function drain(): Promise<void> {
  for (let turn = 0; turn < 10; turn += 1) await settle()
}

/** Whether an attempt is currently armed, read through the tool. */
async function isArmed(test: Harness): Promise<boolean> {
  const status = await power(test, { action: 'status' })
  return (status.value as { pending: boolean }).pending
}

/** Poll one observable condition, yielding to real filesystem work between attempts. */
async function until(check: () => boolean | Promise<boolean>, label: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await check()) return
    await settle()
  }
  throw new Error(`timed out waiting for ${label}`)
}

/** Wait for one condition on the real clock. */
async function waitFor(check: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (check()) return
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`timed out waiting for ${label}`)
}

describe('the real execution path', () => {
  it('fires the operator command once the countdown elapses', async () => {
    const test = await harness({ scheduleAfterSeconds: 1 })
    await waitFor(() => test.reports.some(line => line.includes('shutting down')), 'the shutdown attempt')
    await waitFor(() => test.reports.some(line => line.includes('exit code 0')), 'the command report')
  })

  it('cancels a pending attempt through the operator cancel command', async () => {
    const test = await harness({ scheduleAfterSeconds: 60 })
    const status = await power(test, { action: 'status' })
    expect(status.value).toMatchObject({ pending: true, trigger: 'scheduled-time' })
    const cancelled = await power(test, { action: 'cancel' })
    expect(cancelled.value).toMatchObject({ pending: false, cancelled: true })
    await waitFor(() => test.reports.some(line => line.includes('cancellation finished')), 'the cancel report')
    expect(test.reports.some(line => line.includes('shutting down'))).toBe(false)
  })

  it('refuses to arm while the operator gate is closed', async () => {
    const test = await harness()
    test.ctx.supervisorOps.config.shutdown.enabled = false
    const armed = await power(test, { action: 'confirm' })
    expect(armed.value).toMatchObject({ pending: false, allowed: false })
    expect((armed.value as { reason: string }).reason).toContain('disabled')
  })

  it('requires minutes for a countdown the model asks for', async () => {
    const test = await harness()
    const result = await power(test, { action: 'schedule' })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result)).toContain('needs `minutes`')
  })

  it('reports a command that had to be killed, and one the shell could not run', async () => {
    const timedOut = await harness({ commandTimeoutSec: 1, scheduleAfterSeconds: 1 }, 'sleep 5')
    await waitFor(() => timedOut.reports.some(line => line.includes('(timed out)')), 'the timeout report')

    const broken = await harness({ scheduleAfterSeconds: 1 })
    vi.spyOn(broken.ctx.shell, 'execute').mockRejectedValue(new Error('no shell'))
    await waitFor(() => broken.reports.some(line => line.includes('could not shutdown')), 'the shell failure report')
  })

  it('refuses at fire time when the gate closed after arming', async () => {
    const test = await harness({ scheduleAfterSeconds: 1 })
    test.ctx.supervisorOps.config.shutdown.enabled = false
    await waitFor(() => test.reports.some(line => line.includes('attempt refused')), 'the refusal')
    expect(test.reports.some(line => line.includes('exit code'))).toBe(false)
  })

  it('cancels through the log alone when no cancel command is configured', async () => {
    const test = await harness({ scheduleAfterSeconds: 60, cancelCommand: '' })
    await power(test, { action: 'schedule', minutes: 1 })
    const cancelled = await power(test, { action: 'cancel' })
    expect(cancelled.value).toMatchObject({ pending: false, cancelled: true })
    expect(test.reports.some(line => line.includes('cancellation finished'))).toBe(false)
  })

  it('reports the shutdown to a registered chat conversation', async () => {
    const sent: string[] = []
    const test = await harness({ scheduleAfterSeconds: 1, notifyChatId: 'ops-chat' })
    test.ctx.supervisorOps.useChatTransport({
      send: async (_chatId: string, text: string) => { sent.push(text) },
      onMessage: () => () => {},
    })
    await waitFor(() => sent.some(text => text.includes('[shutdown] shutting down')), 'the chat report')
    await waitFor(() => test.reports.some(line => line.includes('exit code 0')), 'the command report')
  })

  it('runs the operator cancel command even when nothing was armed', async () => {
    const test = await harness()
    const status = await power(test, { action: 'status' })
    expect(status.value).toMatchObject({ pending: false, allowed: true, command: SHUTDOWN_COMMAND })
    const cancelled = await power(test, { action: 'cancel' })
    expect(cancelled.value).toMatchObject({ pending: false, cancelled: true })
    expect((cancelled.value as { reason: string }).reason).toContain('The pending shutdown was cancelled.')
    await waitFor(() => test.reports.some(line => line.includes('cancellation finished')), 'the cancel report')
  })

  it('reports nothing to cancel when neither an attempt nor a cancel command exists', async () => {
    const test = await harness({ cancelCommand: '' })
    const cancelled = await power(test, { action: 'cancel' })
    expect(cancelled.value).toMatchObject({ pending: false, cancelled: false })
    expect((cancelled.value as { reason: string }).reason).toContain('Nothing was pending to cancel.')
  })

  it('keeps the report in the log when no chat transport is registered', async () => {
    const test = await harness({ notifyChatId: 'ops-chat', dryRun: true, scheduleAfterSeconds: 1 })
    await waitFor(() => test.reports.some(line => line.includes('dry run: would shutdown')), 'the dry-run report')
  })

  it('reports a command that exited on a signal with no exit code', async () => {
    const test = await harness({ scheduleAfterSeconds: 1 })
    vi.spyOn(test.ctx.shell, 'execute').mockResolvedValue({
      result: async () => ({ exitCode: null, timedOut: false }),
    } as never)
    await waitFor(() => test.reports.some(line => line.includes('exit code none')), 'the signal report')
  })

  it('reports an armed attempt the closed gate would refuse', async () => {
    const test = await harness({ scheduleAfterSeconds: 60 })
    test.ctx.supervisorOps.config.shutdown.enabled = false
    const status = await power(test, { action: 'status' })
    expect(status.value).toMatchObject({ pending: true, allowed: false })
    expect((status.value as { command?: string }).command).toBeUndefined()
  })

  it('refuses a countdown the model asks for while the gate is closed', async () => {
    const test = await harness()
    test.ctx.supervisorOps.config.shutdown.enabled = false
    const refused = await power(test, { action: 'schedule', minutes: 5 })
    expect(refused.value).toMatchObject({ pending: false, allowed: false })
    expect((refused.value as { reason: string }).reason).toContain('disabled')
  })

  it('reports the gate refusal when nothing is armed', async () => {
    const test = await harness()
    test.ctx.supervisorOps.config.shutdown.enabled = false
    const status = await power(test, { action: 'status' })
    expect(status.value).toMatchObject({ pending: false, allowed: false })
    expect((status.value as { command?: string }).command).toBeUndefined()
  })

  it('renders the armed text and the pending card the model and UI receive', async () => {
    const test = await harness()
    const tool = test.ctx.tools.get('supervisor_power')
    if (tool === undefined) throw new Error('supervisor_power is not registered')
    expect(tool.output.render({ action: 'status' }, { pending: false, allowed: false, reason: 'auto-shutdown is disabled' }))
      .toEqual([{ type: 'text', text: 'no shutdown pending: auto-shutdown is disabled' }])
    expect(tool.output.render({ action: 'status' }, { pending: true, allowed: false, reason: 'auto-shutdown is disabled' }))
      .toEqual([{ type: 'text', text: 'shutdown armed (); fires at ' }])
    expect(tool.presentCall?.({ action: 'schedule' })).toEqual({ card: 'generic', title: 'Power: schedule', kind: 'other' })
  })

  it('arms a countdown applied without schema defaults', async () => {
    const test = await harness({ enabled: true, dryRun: true, scheduleAfterSeconds: 1 }, SHUTDOWN_COMMAND, { direct: true })
    await waitFor(() => test.reports.some(line => line.includes('dry run: would shutdown')), 'the dry-run report')
  })
})

describe('the timing logic under a fake clock', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
  })

  it('arms after the grace period when the model confirms completion', async () => {
    const test = await harness({ dryRun: true })
    const armed = await power(test, { action: 'confirm' })
    expect(armed.value).toMatchObject({ pending: true, trigger: 'all-tasks-completed', remainingSec: 60, allowed: true })
    await vi.advanceTimersByTimeAsync(MINUTE_MS - 1_000)
    expect(test.reports.some(line => line.includes('dry run: would shutdown'))).toBe(false)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(test.reports.some(line => line.includes('dry run: would shutdown'))).toBe(true)
  })

  it('arms once every plan finished and fires after the grace period', async () => {
    const test = await harness({ dryRun: true, watchPlans: true })
    await writePlan(test, 'open', ['completed'])
    await pass(1_000)
    await until(() => isArmed(test), 'the plan-armed attempt')
    await pass(MINUTE_MS + 1_000)
    expect(test.reports.some(line => line.includes('dry run: would shutdown'))).toBe(true)
  })

  it('fires once per completed plan set instead of re-arming', async () => {
    const test = await harness({ dryRun: true, watchPlans: true })
    await writePlan(test, 'open', ['completed'])
    await pass(1_000)
    await until(() => isArmed(test), 'the plan-armed attempt')
    await pass(MINUTE_MS + 1_000)
    expect(test.reports.filter(line => line.includes('dry run: would shutdown'))).toHaveLength(1)
    await pass(3 * MINUTE_MS)
    expect(test.reports.filter(line => line.includes('dry run: would shutdown'))).toHaveLength(1)
  })

  it('does not back-report thresholds a fresh attempt starts inside', async () => {
    const test = await harness({ dryRun: true })
    await power(test, { action: 'schedule', minutes: 6 })
    await vi.advanceTimersByTimeAsync(2_000)
    expect(test.reports.filter(line => line.includes('shutdown in 10 minute(s)'))).toEqual([])
    expect(test.reports.filter(line => line.includes('shutdown in 5 minute(s)'))).toEqual([])
  })

  it('fires after the configured idle time', async () => {
    const test = await harness({ dryRun: true, idleTimeoutMin: 2 })
    await vi.advanceTimersByTimeAsync(2 * MINUTE_MS + 2_000)
    expect(test.reports.some(line => line.includes('no agent ran for 2 minutes'))).toBe(true)
    expect(test.reports.some(line => line.includes('dry run: would shutdown'))).toBe(true)
  })

  it('announces each reminder threshold once', async () => {
    const test = await harness({ dryRun: true, remindAtMin: [5, 1] })
    await power(test, { action: 'schedule', minutes: 6 })
    await vi.advanceTimersByTimeAsync(MINUTE_MS + 2_000)
    expect(test.reports.filter(line => line.includes('shutdown in 5 minute(s)'))).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(4 * MINUTE_MS)
    expect(test.reports.filter(line => line.includes('shutdown in 1 minute(s)'))).toHaveLength(1)
  })

  it('arms a configured wall clock at load', async () => {
    const at = new Date(Date.now() + 3 * MINUTE_MS)
    const clock = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
    const test = await harness({ dryRun: true, scheduleAt: clock })
    const status = await power(test, { action: 'status' })
    expect(status.value).toMatchObject({ pending: true, trigger: 'scheduled-time' })
  })

  it('does not arm anything while the component is disabled', async () => {
    const test = await harness({ dryRun: true, enabled: false, watchPlans: true })
    await writePlan(test, 'open', ['completed'])
    await vi.advanceTimersByTimeAsync(3 * MINUTE_MS)
    expect(test.reports).toEqual([])
  })

  it('cancels the plan-armed attempt when the work reopens', async () => {
    const test = await harness({ dryRun: true, watchPlans: true })
    await writePlan(test, 'reopened', ['completed'])
    await pass(1_000)
    await until(() => isArmed(test), 'the plan-armed attempt')
    await drain()
    await writePlan(test, 'reopened', ['pending'])
    await pass(1_000)
    await until(() => test.reports.some(line => line.includes('cancelled the pending shutdown')), 'the reopen cancellation')
    expect(test.reports.some(line => line.includes('cancelled the pending shutdown (every task plan finished)'))).toBe(true)
    expect(test.reports.some(line => line.includes('dry run: would cancellation'))).toBe(true)
    await pass(3 * MINUTE_MS)
    expect(test.reports.some(line => line.includes('dry run: would shutdown'))).toBe(false)
  })

  it('restarts the idle clock when an agent starts running', async () => {
    const test = await harness({ dryRun: true, idleTimeoutMin: 2 })
    await pass(MINUTE_MS)
    expect(test.reports.some(line => line.includes('no agent ran'))).toBe(false)
    emitAgentEvent(test.ctx, test.agent, 'agent/status', { status: 'idle' })
    emitAgentEvent(test.ctx, test.agent, 'agent/status', { status: 'running' })
    await pass(MINUTE_MS)
    expect(test.reports.some(line => line.includes('no agent ran'))).toBe(false)
    await pass(MINUTE_MS + 2_000)
    expect(test.reports.some(line => line.includes('no agent ran for 2 minutes'))).toBe(true)
    expect(test.reports.some(line => line.includes('dry run: would shutdown'))).toBe(true)
  })
})
