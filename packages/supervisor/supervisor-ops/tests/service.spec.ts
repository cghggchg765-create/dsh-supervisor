import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent, Inbox } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { SupervisorRuntime } from '@deepseek-ai/dsh-supervisor-core'
import { TerminalSessionId } from '@deepseek-ai/dsh-terminal'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ChatMessage, ChatTransport } from '../src/feishu.ts'
import { SupervisorOpsService, type SupervisorOpsConfig } from '../src/index.ts'

let root = ''

/** A fixed instant the time-dependent fixtures are anchored at. */
const NOW_MS = 1_700_000_000_000

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

/** An agent handle carrying only the identity the supervised sessions record. */
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

/** A chat transport whose inbound subscription the test drives directly. */
function chatTransportFor(): {
  transport: ChatTransport
  deliver: (message: ChatMessage) => void
  unsubscribeCount: () => number
} {
  let inbound: ((message: ChatMessage) => void) | undefined
  let unsubscribes = 0
  return {
    transport: {
      send: () => Promise.resolve(),
      onMessage: (handler) => {
        inbound = handler
        return () => {
          unsubscribes += 1
          inbound = undefined
        }
      },
    },
    deliver: message => inbound?.(message),
    unsubscribeCount: () => unsubscribes,
  }
}

/**
 * Build a context carrying the tool runtime the ops service registers against
 * and the core supervisor runtime whose state directory and sessions it reads.
 * @param config - ops configuration under test.
 * @returns the context and the constructed ops service.
 */
async function opsFor(config: SupervisorOpsConfig = {}): Promise<{ ctx: Context; service: SupervisorOpsService }> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  new SupervisorRuntime(ctx, { workspaceDir: root, stateDir: join(root, 'state'), watchdogEnabled: false })
  return { ctx, service: new SupervisorOpsService(ctx, config) }
}

describe('configuration and stores', () => {
  it('defaults the budget, price table, and shutdown policy from the core state directory', async () => {
    const { service } = await opsFor()
    expect(service.config.stateDir).toBe(resolve(root, 'state'))
    expect(service.config.budget).toEqual({
      taskBudgetUSD: 5,
      dailyBudgetUSD: 20,
      alertThresholdPct: 80,
      onExceed: 'downgrade-all',
    })
    expect(service.config.modelPrices).toEqual([])
    expect(service.config.shutdown).toEqual({ enabled: false, command: '', gracePeriodMin: 5 })
    expect(service.budgetStatus(NOW_MS)).toEqual({
      taskUSD: 0,
      dailyUSD: 0,
      alert: false,
      exceeded: false,
      onExceed: 'downgrade-all',
    })
  })

  it('merges configured budget, price, and shutdown values over the defaults', async () => {
    const { service } = await opsFor({
      budget: { taskBudgetUSD: 2, onExceed: 'stop-task' },
      modelPrices: [{ model: 'fast', usdPerMillionTokens: 1 }],
      shutdown: { enabled: true, command: 'shutdown -h now' },
    })
    expect(service.config.budget).toEqual({
      taskBudgetUSD: 2,
      dailyBudgetUSD: 20,
      alertThresholdPct: 80,
      onExceed: 'stop-task',
    })
    expect(service.config.modelPrices).toEqual([{ model: 'fast', usdPerMillionTokens: 1 }])
    expect(service.config.shutdown).toEqual({ enabled: true, command: 'shutdown -h now', gracePeriodMin: 5 })
  })

  it('reads the running spend from its ledger', async () => {
    const { service } = await opsFor({ budget: { taskBudgetUSD: 2 }, modelPrices: [{ model: 'fast', usdPerMillionTokens: 1 }] })
    service.ledger.record({ at: NOW_MS, model: 'fast', tokens: 1_000_000 })
    expect(service.budgetStatus(NOW_MS)).toEqual({
      taskUSD: 1,
      dailyUSD: 1,
      alert: false,
      exceeded: false,
      onExceed: 'downgrade-all',
    })
  })

  it('writes reports under the supervisor state directory', async () => {
    const { service } = await opsFor()
    const path = await service.reports.write('task-a', '# report\n')
    expect(path).toContain(join('state', 'deliverables'))
    expect(await readFile(path, 'utf8')).toBe('# report\n')
  })

  it('refuses a budget that is not positive', async () => {
    await expect(opsFor({ budget: { taskBudgetUSD: 0 } })).rejects.toThrow(/"taskBudgetUSD" must be a positive number/)
    await expect(opsFor({ budget: { dailyBudgetUSD: Number.NaN } })).rejects.toThrow(/"dailyBudgetUSD" must be a positive number/)
  })

  it('refuses an alert threshold outside its bounds', async () => {
    await expect(opsFor({ budget: { alertThresholdPct: 0 } })).rejects.toThrow(/alertThresholdPct/)
    await expect(opsFor({ budget: { alertThresholdPct: 101 } })).rejects.toThrow(/alertThresholdPct/)
  })

  it('refuses a price entry that could never produce a cost', async () => {
    await expect(opsFor({ modelPrices: [{ model: '   ', usdPerMillionTokens: 1 }] }))
      .rejects.toThrow(/non-empty model name/)
    await expect(opsFor({ modelPrices: [{ model: 'broken', usdPerMillionTokens: 0 }] }))
      .rejects.toThrow(/model price for "broken" must be a positive number/)
  })

  it('refuses a shutdown grace period that is not positive', async () => {
    await expect(opsFor({ shutdown: { gracePeriodMin: 0 } })).rejects.toThrow(/"gracePeriodMin" must be a positive number/)
  })
})

describe('chat transport registration', () => {
  it('answers no bridge before a deployment registers a transport', async () => {
    const { service } = await opsFor()
    expect(service.chat).toBeUndefined()
  })

  it('routes inbound messages to the newest bridge and forgets it on dispose', async () => {
    const { service } = await opsFor()
    const first = chatTransportFor()
    const second = chatTransportFor()
    const routed: { text: string; command: string; argument: string }[] = []
    const disposeFirst = service.useChatTransport(first.transport, () => {})
    const disposeSecond = service.useChatTransport(second.transport, (message, command) => {
      routed.push({ text: message.text, command: command.command, argument: command.argument })
    })
    expect(service.chat).toBeDefined()

    const inbound: ChatMessage = { id: 'm-1', chatId: 'oc-1', senderId: 'u-1', text: '/run ship it', receivedAt: NOW_MS }
    second.deliver(inbound)
    expect(routed).toEqual([{ text: '/run ship it', command: 'run', argument: 'ship it' }])
    expect(first.unsubscribeCount()).toBe(0)

    // Disposing a superseded bridge must not clear the one that replaced it.
    disposeFirst()
    expect(first.unsubscribeCount()).toBe(1)
    expect(service.chat).toBeDefined()

    disposeSecond()
    expect(second.unsubscribeCount()).toBe(1)
    expect(service.chat).toBeUndefined()
  })

  it('routes an inbound message to the supervised agents without a handler override', async () => {
    const { ctx, service } = await opsFor()
    const transport = chatTransportFor()
    const steered: string[] = []
    const owner = agentFor('owner-1')
    owner.steer = message => steered.push((message.content[0] as { text: string }).text)
    const quiet = agentFor('owner-2')
    quiet.steer = () => {
      throw new Error('driver is busy')
    }
    ctx.supervisor.track(owner, TerminalSessionId('pty-a'), { kind: 'running' })
    ctx.supervisor.track(owner, TerminalSessionId('pty-b'), { kind: 'running' })
    ctx.supervisor.track(quiet, TerminalSessionId('pty-c'), { kind: 'running' })
    service.useChatTransport(transport.transport)

    // One steer per distinct owner, and a plain message keeps its text.
    transport.deliver({ id: 'm-2', chatId: 'oc-1', senderId: 'u-9', text: '进度？', receivedAt: NOW_MS })
    expect(steered).toEqual(['[chat] u-9: 进度？'])

    transport.deliver({ id: 'm-3', chatId: 'oc-1', senderId: 'u-9', text: '/stop now', receivedAt: NOW_MS })
    expect(steered[1]).toBe('[chat] u-9: /stop now')
  })
})

describe('per-task budget window', () => {
  it('moves the window to a new task, keeping the day and counting its first settlement', async () => {
    const { ctx, service } = await opsFor({ budget: { taskBudgetUSD: 10 }, modelPrices: [{ model: 'fast', usdPerMillionTokens: 1 }] })
    const owner = agentFor('owner-1')
    const first = ctx.supervisor.track(owner, TerminalSessionId('pty-a'), { kind: 'running' })
    const second = ctx.supervisor.track(owner, TerminalSessionId('pty-b'), { kind: 'running' })
    first.taskId = 'task-a'
    second.taskId = 'task-a'
    service.recordUsage({ at: NOW_MS, model: 'fast', tokens: 1_000_000 })
    expect(service.budgetStatus(NOW_MS)).toMatchObject({ taskUSD: 1, dailyUSD: 1 })

    // Both terminals moving to the next task restarts the task window, and the
    // first settlement of that task is counted rather than dropped by the move.
    first.taskId = 'task-b'
    second.taskId = 'task-b'
    expect(service.budgetStatus(NOW_MS)).toMatchObject({ taskUSD: 0, dailyUSD: 1 })
    service.recordUsage({ at: NOW_MS, model: 'fast', tokens: 2_000_000 })
    expect(service.budgetStatus(NOW_MS)).toMatchObject({ taskUSD: 2, dailyUSD: 3 })
  })

  it('keeps the window while the terminals name no task or disagree on one', async () => {
    const { ctx, service } = await opsFor({ budget: { taskBudgetUSD: 10 }, modelPrices: [{ model: 'fast', usdPerMillionTokens: 1 }] })
    const owner = agentFor('owner-1')
    const first = ctx.supervisor.track(owner, TerminalSessionId('pty-a'), { kind: 'running' })
    const second = ctx.supervisor.track(owner, TerminalSessionId('pty-b'), { kind: 'running' })
    second.taskId = ''
    service.recordUsage({ at: NOW_MS, model: 'fast', tokens: 1_000_000 })
    expect(service.budgetStatus(NOW_MS)).toMatchObject({ taskUSD: 1, dailyUSD: 1 })

    // Two terminals on different tasks give no single current task, so the
    // window stays until the run settles on one.
    first.taskId = 'task-a'
    second.taskId = 'task-b'
    service.recordUsage({ at: NOW_MS, model: 'fast', tokens: 1_000_000 })
    expect(service.budgetStatus(NOW_MS)).toMatchObject({ taskUSD: 2, dailyUSD: 2 })
  })
})
