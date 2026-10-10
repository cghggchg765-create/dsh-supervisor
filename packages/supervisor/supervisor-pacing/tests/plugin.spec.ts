/**
 * Automatic pacing against a real agent loop with only its model scripted: a
 * failed turn schedules a resume, a listed code is left alone, the budget ends in
 * a chat alert, an external wake cancels the pending resume, and a disarmed goal
 * is re-armed before the wake.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import GoalService from '@deepseek-ai/dsh-goal'
import * as goalRounds from '@deepseek-ai/dsh-goal-round-driver'
import { createUserMessage, LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import * as pacing from '../src/index.ts'
import type { PacingConfig } from '../src/index.ts'

type ScriptEntry = StreamChunk[] | Error

/** Small request-recording adapter whose every entry is scripted. */
class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(private readonly script: ScriptEntry[]) {
    super()
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const entry = this.script.shift()
    if (entry === undefined) throw new Error('ScriptedAdapter: script exhausted')
    if (entry instanceof Error) throw entry
    for (const chunk of entry) yield chunk
  }
}

/** One successful text response. */
function textResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/** One rate-limit failure, optionally with the provider's stated wait. */
function rateLimited(providerRetryAfterMs?: number): LlmError {
  return new LlmError('slow down', 'RATE_LIMIT', {
    ...providerRetryAfterMs === undefined ? {} : { providerRetryAfterMs },
  })
}

/** Pacing settings every case starts from: no waiting, no jitter. */
const FAST: PacingConfig = {
  initialDelayMs: 1,
  maxDelayMs: 2,
  jitterRatio: 0,
  bufferMs: 0,
  minIntervalMs: 0,
}

interface Harness {
  readonly ctx: Context
  readonly adapter: ScriptedAdapter
  readonly agent: Agent
  /** Model-visible text of every message queued for the agent. */
  readonly notices: string[]
  /** The loop fiber, whose disposal disposes the agents it created. */
  readonly loop: Awaited<ReturnType<Context['plugin']>>
}

const contexts: Context[] = []

afterEach(async () => {
  await Promise.allSettled(contexts.splice(0).map(context => context.fiber.dispose()))
})

/** Watch every message queued for one agent. */
function watchMessages(ctx: Context, agent: Agent, notices: string[]): void {
  ctx.on('agent/inbox/inserted', ({ agent: subject, message }) => {
    if (subject !== agent) return
    for (const block of message.content) {
      if (block.type === 'text') notices.push(block.text)
    }
  })
}

/** Mount a real loop with only its model scripted, then this plugin. */
async function harness(script: ScriptEntry[], config: PacingConfig = {}, withGoals = false): Promise<Harness> {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  if (withGoals) {
    await ctx.plugin(GoalService)
    await ctx.plugin(goalRounds)
  }
  await ctx.plugin(pacing, { ...FAST, ...config })
  const loop = await ctx.plugin(AgentLoop, { agents: [] })
  const adapter = new ScriptedAdapter(script)
  ctx.llm.registerAdapter(['mock'], adapter)
  const agent = await ctx.agentLoop.create(SessionId(`pacing-session-${String(Math.random())}`), {
    provider: 'mock',
    model: 'mock',
  })
  const notices: string[] = []
  watchMessages(ctx, agent, notices)
  return { ctx, adapter, agent, notices, loop }
}

/** Ask the agent to work and wait for the turn to settle. */
async function startTurn(agent: Agent, text = 'do the work'): Promise<void> {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await agent.whenIdle()
}

/** Poll until one condition holds, so real (tiny) delays stay deterministic. */
async function waitFor(check: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (check()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error(`timed out waiting for ${label}`)
}

/** Let any pending timer fire before asserting that nothing happened. */
async function settle(): Promise<void> {
  for (let attempt = 0; attempt < 6; attempt += 1) await new Promise(resolve => setTimeout(resolve, 10))
}

describe('automatic pacing', () => {
  it('resumes the agent after the provider-stated wait', async () => {
    const test = await harness([rateLimited(5), textResponse('continued')])
    await startTurn(test.agent)
    await waitFor(() => test.notices.some(text => text.startsWith('[pacing]')), 'pacing notice')
    const notice = test.notices.find(text => text.startsWith('[pacing]'))
    expect(notice).toMatch(/^\[pacing\] the previous turn failed\. This is automatic resume 1 of 3/)
    await waitFor(() => test.adapter.requests.length >= 2, 'the resumed request')
  })

  it('leaves a failure code this deployment does not resume alone', async () => {
    const test = await harness([new LlmError('bad key', 'AUTH'), textResponse('unused')], { codes: ['RATE_LIMIT'] })
    await startTurn(test.agent)
    await settle()
    expect(test.notices.filter(text => text.startsWith('[pacing]'))).toEqual([])
    expect(test.adapter.requests).toHaveLength(1)
  })

  it('stops at the resume budget and alerts the configured conversation', async () => {
    const alerts: string[] = []
    const test = await harness([rateLimited(1), rateLimited(1), textResponse('unused')], {
      maxResumesPerSession: 1,
      notifyChatId: 'ops-chat',
    })
    test.ctx.provide('supervisorOps', {
      chat: {
        notify: async (chatId: string, text: string) => {
          alerts.push(`${chatId}: ${text}`)
          return true
        },
      },
    } as never)
    await startTurn(test.agent)
    await waitFor(() => alerts.length > 0, 'give-up alert')
    expect(alerts[0]).toContain('ops-chat')
    expect(alerts[0]).toContain('spent 1 automatic resume(s)')
    // The budget is spent, so the second failure schedules nothing more.
    await settle()
    expect(test.notices.filter(text => text.startsWith('[pacing]'))).toHaveLength(1)
  })

  it('cancels the pending resume when something else wakes the agent first', async () => {
    const test = await harness([rateLimited(200), textResponse('human turn'), textResponse('unused')])
    await startTurn(test.agent)
    test.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'human follow-up' }], source: { kind: 'user' } }))
    await waitFor(() => test.adapter.requests.length >= 2, 'the human turn')
    await settle()
    expect(test.notices.filter(text => text.startsWith('[pacing]'))).toEqual([])
  })

  it('re-arms a goal the failure disarmed, so its rounds continue', async () => {
    const test = await harness([rateLimited(1), textResponse('round two')], {}, true)
    test.ctx.goals.create(test.agent, { objective: 'keep going', maxGoalRounds: 4 })
    await waitFor(() => test.notices.some(text => text.startsWith('[pacing]')), 'the pacing resume')
    // Only a re-armed goal admits another round, so a queued round 2 proves the
    // resume re-armed what the rate limit had disarmed.
    await waitFor(() => test.notices.some(text => text.includes('Round: 2/4')), 'the second goal round')
  })

  it('leaves a disarmed goal parked when goal re-arming is off', async () => {
    const test = await harness([rateLimited(1), textResponse('unused')], { resumeGoals: false }, true)
    test.ctx.goals.create(test.agent, { objective: 'keep going', maxGoalRounds: 4 })
    await waitFor(() => test.notices.some(text => text.startsWith('[pacing]')), 'the pacing resume')
    await settle()
    expect(test.notices.filter(text => text.includes('Round: 2/4'))).toEqual([])
    expect(test.ctx.goals.get(test.agent)?.activation).toBe('disarmed')
  })

  it('resumes a session whose last turn failed before this process started', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    const adapter = new ScriptedAdapter([rateLimited(1), textResponse('recovered')])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('pacing-restart'), { provider: 'mock', model: 'mock' })
    await startTurn(agent)
    expect(adapter.requests).toHaveLength(1)

    const notices: string[] = []
    watchMessages(ctx, agent, notices)
    await ctx.plugin(pacing, { ...FAST, resumeOnRestart: true })
    await waitFor(() => notices.some(text => text.startsWith('[pacing]')), 'the restart resume')
    expect(notices.find(text => text.startsWith('[pacing]'))).toMatch(/automatic resume 1 of 3/)
  })

  it('leaves a pre-existing failure alone while restart recovery is off', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    const adapter = new ScriptedAdapter([rateLimited(1), textResponse('unused')])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('pacing-restart-off'), { provider: 'mock', model: 'mock' })
    await startTurn(agent)

    const notices: string[] = []
    watchMessages(ctx, agent, notices)
    await ctx.plugin(pacing, FAST)
    await settle()
    expect(notices.filter(text => text.startsWith('[pacing]'))).toEqual([])
    expect(adapter.requests).toHaveLength(1)
  })
})

describe('pacing configuration', () => {
  it('refuses a ladder that could never grow and an empty code list', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    await expect(ctx.plugin(pacing, { initialDelayMs: 100, maxDelayMs: 10 }))
      .rejects.toThrow('"maxDelayMs" must be at least "initialDelayMs"')
    await expect(ctx.plugin(pacing, { codes: [] })).rejects.toThrow('"codes" must name at least one failure code')
  })

  it('lets the schema reject a value outside its range', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    await expect(ctx.plugin(pacing, { maxResumesPerSession: 0 })).rejects.toThrow(/maxResumesPerSession/)
    await expect(ctx.plugin(pacing, { jitterRatio: 2 })).rejects.toThrow(/jitterRatio/)
    await expect(ctx.plugin(pacing, { minIntervalMs: -1 })).rejects.toThrow(/minIntervalMs/)
  })

  it('does nothing while disabled', async () => {
    const test = await harness([rateLimited(1), textResponse('unused')], { enabled: false })
    await startTurn(test.agent)
    await settle()
    expect(test.notices.filter(text => text.startsWith('[pacing]'))).toEqual([])
    expect(test.adapter.requests).toHaveLength(1)
  })
})

describe('resume delivery', () => {
  it('waits for the idle phase when another maintenance task holds it', async () => {
    const test = await harness([rateLimited(1), textResponse('continued')], { initialDelayMs: 40, maxDelayMs: 80 })
    await startTurn(test.agent)
    let release: (() => void) | undefined
    const held = test.agent.runMaintenance(() => new Promise<boolean>((resolve) => {
      release = () => { resolve(true) }
    }))
    await settle()
    // The wake could not claim the idle phase while the task above held it.
    expect(test.notices.filter(text => text.startsWith('[pacing]'))).toEqual([])
    release?.()
    await held
    await waitFor(() => test.notices.some(text => text.startsWith('[pacing]')), 'the deferred wake')
  })

  it('reports a driver that refuses the wake without failing the plugin', async () => {
    const test = await harness([rateLimited(1), rateLimited(1), textResponse('unused')], { maxResumesPerSession: 2 })
    await startTurn(test.agent)
    const refusals: string[] = []
    test.agent.followup = () => { throw new Error('driver is closing') }
    test.ctx.logger.warn = ((message: string) => { refusals.push(message) }) as never
    await waitFor(() => refusals.some(message => message.includes('could not wake agent')), 'the refusal warning')
    expect(refusals.some(message => message.includes('driver is closing'))).toBe(true)
  })

  it('forgets a disposed agent instead of waking it', async () => {
    const test = await harness([rateLimited(200), textResponse('unused')])
    await startTurn(test.agent)
    await test.loop.dispose()
    await settle()
    expect(test.notices.filter(text => text.startsWith('[pacing]'))).toEqual([])
  })

  it('reports a give-up through the log when no chat transport exists', async () => {
    const warnings: string[] = []
    const test = await harness([rateLimited(1), rateLimited(1)], {
      maxResumesPerSession: 1,
      notifyChatId: 'ops-chat',
    })
    test.ctx.logger.warn = ((message: string) => { warnings.push(message) }) as never
    await startTurn(test.agent)
    await waitFor(() => warnings.some(message => message.includes('not resuming agent')), 'the give-up log')
    expect(warnings.some(message => message.includes('spent 1 automatic resume(s)'))).toBe(true)
  })

  it('reports one give-up per cooldown', async () => {
    const alerts: string[] = []
    const test = await harness([new LlmError('bad key', 'AUTH'), new LlmError('bad key', 'AUTH')], {
      codes: ['RATE_LIMIT'],
      notifyChatId: 'ops-chat',
      minIntervalMs: 60_000,
    })
    test.ctx.provide('supervisorOps', {
      chat: {
        notify: async (chatId: string, text: string) => {
          alerts.push(`${chatId}: ${text}`)
          return true
        },
      },
    } as never)
    await startTurn(test.agent)
    await waitFor(() => alerts.length > 0, 'the first alert')
    // A second failure inside the cooldown window must not alert again.
    await startTurn(test.agent, 'try once more')
    await settle()
    expect(alerts).toHaveLength(1)
  })

  it('drops a pending wake when the agent is disposed while it waits for idle', async () => {
    const test = await harness([rateLimited(1), textResponse('unused')], { initialDelayMs: 5, maxDelayMs: 10 })
    test.agent.runMaintenance = () => { throw new Error('busy') }
    test.agent.whenIdle = () => new Promise<void>((resolve) => { setTimeout(resolve, 5) })
    await startTurn(test.agent)
    // The wake cannot claim the idle phase, so it waits for the next idle
    // transition; disposing the agent first must drop it instead of waking.
    await test.loop.dispose()
    await settle()
    expect(test.notices.filter(text => text.startsWith('[pacing]'))).toEqual([])
  })

  it('ignores an agent error that carries no structured failure', async () => {
    const test = await harness([textResponse('unused')], { initialDelayMs: 5, maxDelayMs: 10 })
    agentEvents(test.ctx, test.agent)['emit']('agent/error', { turn: 1, step: 1, error: 'not a failure' })
    await settle()
    expect(test.notices.filter(text => text.startsWith('[pacing]'))).toEqual([])
  })

  it('runs on its documented defaults', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    // Only the buffer is configured, so every other default is the one under test.
    await ctx.plugin(pacing, { bufferMs: 0 })
    await ctx.plugin(AgentLoop, { agents: [] })
    const adapter = new ScriptedAdapter([rateLimited(1), textResponse('continued')])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('pacing-defaults'), { provider: 'mock', model: 'mock' })
    const notices: string[] = []
    watchMessages(ctx, agent, notices)
    await startTurn(agent)
    await waitFor(() => notices.some(text => text.startsWith('[pacing]')), 'the default-policy resume')
    expect(notices.find(text => text.startsWith('[pacing]'))).toContain('automatic resume 1 of 3')
  })

  it('leaves a completed session alone at restart', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    const adapter = new ScriptedAdapter([textResponse('done')])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('pacing-restart-done'), { provider: 'mock', model: 'mock' })
    await startTurn(agent)

    const notices: string[] = []
    watchMessages(ctx, agent, notices)
    await ctx.plugin(pacing, { ...FAST, resumeOnRestart: true })
    await settle()
    expect(notices.filter(text => text.startsWith('[pacing]'))).toEqual([])
  })

  it('ignores a session event whose session has no registered agent', async () => {
    const test = await harness([textResponse('fine')])
    const orphan = Session.create(SessionId('pacing-orphan'))
    test.ctx.emit('session/event', orphan, {
      type: 'turn/end',
      seq: SessionSeq(1),
      time: Date.now(),
      data: { turn: 1, reason: { kind: 'completed' } },
    })
    await settle()
    expect(test.notices.filter(text => text.startsWith('[pacing]'))).toEqual([])
  })

  it('forgets an agent that was never paced', async () => {
    const test = await harness([textResponse('fine')])
    await test.loop.dispose()
    await settle()
    expect(test.notices.filter(text => text.startsWith('[pacing]'))).toEqual([])
  })

  it('ignores an error payload that is not a structured failure', async () => {
    const test = await harness([textResponse('fine')])
    agentEvents(test.ctx, test.agent)['emit']('agent/error', { turn: 1, step: 1, error: 'not a failure' })
    await settle()
    expect(test.notices.filter(text => text.startsWith('[pacing]'))).toEqual([])
  })

  it('resumes an agent that has no goal to re-arm', async () => {
    const test = await harness([rateLimited(1), textResponse('continued')], {}, true)
    await startTurn(test.agent)
    await waitFor(() => test.notices.some(text => text.startsWith('[pacing]')), 'the resume without a goal')
  })

  it('reports a goal re-arm the service refuses', async () => {
    const warnings: string[] = []
    const test = await harness([rateLimited(1), textResponse('continued')])
    test.ctx.provide('goals', {
      get: () => ({ id: 'goal-1', revision: 1, phase: 'active', activation: 'disarmed' }),
      resume: () => { throw new Error('revision moved') },
    } as never)
    test.ctx.logger.warn = ((message: string) => { warnings.push(message) }) as never
    await startTurn(test.agent)
    await waitFor(() => warnings.some(message => message.includes('could not re-arm')), 'the re-arm warning')
    expect(warnings.some(message => message.includes('revision moved'))).toBe(true)
  })

  it('reports a rejected alert without failing the plugin', async () => {
    const warnings: string[] = []
    const test = await harness([rateLimited(1), rateLimited(1)], {
      maxResumesPerSession: 1,
      notifyChatId: 'ops-chat',
    })
    test.ctx.provide('supervisorOps', {
      chat: { notify: async () => { throw new Error('transport offline') } },
    } as never)
    test.ctx.logger.warn = ((message: string) => { warnings.push(message) }) as never
    await startTurn(test.agent)
    await waitFor(() => warnings.some(message => message.includes('give-up alert failed')), 'the alert warning')
    expect(warnings.some(message => message.includes('transport offline'))).toBe(true)
  })

  it('paces only the agents in scope', async () => {
    const test = await harness([textResponse('child turn')], { scope: 'roots' })
    const childSession = Session.create(SessionId('pacing-child-agent'))
    const child: Agent = { ...test.agent, id: childSession.id, session: childSession }
    test.ctx.agents.enter(child, test.agent)
    test.ctx.emit('agent/error', {
      agent: child,
      turn: 1,
      step: 1,
      error: new LlmError('slow down', 'RATE_LIMIT'),
    })
    await settle()
    expect(test.notices.filter(text => text.startsWith('[pacing]'))).toEqual([])
  })
})
