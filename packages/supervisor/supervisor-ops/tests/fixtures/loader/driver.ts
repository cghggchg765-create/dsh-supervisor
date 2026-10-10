#!/usr/bin/env node
/**
 * Test driver: boot the supervisor-ops Loader composition, register a scripted
 * terminal backend, drive the four operations tools through the tool registry,
 * exercise the chat transport seam, and persist the observed model-visible
 * surface to `./supervisor-ops-loader-report.json` for the package spec's
 * inspect step.
 */

import { writeFile } from 'node:fs/promises'
import { boot, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { Agent, Inbox } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import type { ChatMessage, ChatTransport } from '@deepseek-ai/dsh-supervisor-ops'
import type {
  TerminalBackendSession,
  TerminalReadRequest,
  TerminalReadResult,
  TerminalSendOperation,
  TerminalSendRequest,
  TerminalSessionStatus,
} from '@deepseek-ai/dsh-terminal'

const configPath = process.argv[2]
if (configPath === undefined) throw new Error('supervisor-ops driver requires a config path')

/** The scripted settlement: an ordinary prompt carrying a rate-limit line. */
const SCRIPTED_OUTPUT = ['prompt ready', 'HTTP 429 Too Many Requests', 'prompt ready'].join('\n')

/** A terminal that settles every send immediately with scripted output. */
class ScriptedSession implements TerminalBackendSession {
  readonly motd = 'scripted terminal ready\n'

  private readonly lines: string[] = []

  startSend(_request: TerminalSendRequest): TerminalSendOperation {
    this.lines.push(...SCRIPTED_OUTPUT.split('\n').filter(line => line !== ''))
    return {
      done: Promise.resolve({
        viewport: SCRIPTED_OUTPUT,
        waitReason: 'stdin_read',
        sessionStatus: { kind: 'running' },
        truncated: false,
      }),
      readOutput: () => ({ delta: SCRIPTED_OUTPUT, truncated: false }),
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
    return Promise.resolve({ delivered: true, targetPgid: 1 })
  }

  status(): TerminalSessionStatus {
    return { kind: 'running' }
  }

  close(): Promise<void> {
    return Promise.resolve()
  }
}

/** An Inbox placeholder for the driver's Agent stub, which never drives a loop. */
function unsupportedInbox(): Inbox {
  const reject = (): never => {
    throw new Error('this driver Agent does not support Inbox mutations')
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

/** The agent the driver's tool calls and chat steers run against. */
function ownerFor(scope: Context, steered: string[]): Agent {
  const sessionId = SessionId('supervisor-ops-loader-owner')
  return {
    id: sessionId,
    options: {},
    session: Session.create(sessionId),
    inbox: unsupportedInbox(),
    status: 'idle',
    ctx: scope,
    send: () => {},
    followup: () => {},
    steer: (message) => {
      steered.push((message.content[0] as { text: string }).text)
    },
    inject: () => {},
    cancel() {},
    runMaintenance: job => job(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
}

/** Run one supervisor tool through the registry, as a model turn would. */
function callTool(ctx: Context, agent: Agent, name: string, args: unknown, callId: string) {
  const run = ctx.tools['execute'].bind(ctx.tools)
  return run({ signal: new AbortController().signal, callId: ToolCallId(callId), name, arguments: args, agent })
}

/** A chat transport the driver drives directly, recording what was sent. */
function transportFor(): { transport: ChatTransport; sent: string[]; deliver: (message: ChatMessage) => void } {
  let inbound: ((message: ChatMessage) => void) | undefined
  const sent: string[] = []
  return {
    transport: {
      send: (_chatId, text) => {
        sent.push(text)
        return Promise.resolve()
      },
      onMessage: (handler) => {
        inbound = handler
        return () => {
          inbound = undefined
        }
      },
    },
    sent,
    deliver: message => inbound?.(message),
  }
}

const ctx = await boot('supervisor-ops-loader-smoke', resolveConfigPath(configPath, undefined))
const steered: string[] = []
try {
  ctx.terminals.registerBackend({
    type: 'scripted',
    spawn: () => Promise.resolve(new ScriptedSession()),
  })

  const agent = ownerFor(ctx.plugin(() => {}).ctx, steered)
  await ctx.agents.register(agent)
  const openTerminal = ctx.terminals['spawn'].bind(ctx.terminals)
  const session = await openTerminal(agent, { type: 'scripted', name: 'loader', cwd: process.cwd() }, undefined)
  ctx.supervisor.track(agent, session.sessionId, { kind: 'running' })

  const budget = await callTool(ctx, agent, 'supervisor_budget', { action: 'record', tokens: 1500, model: 'standard' }, 'ops-budget')
  const budgetValue = budget.value as { tokens: number; entries: number }

  const offline = await callTool(ctx, agent, 'supervisor_notify', { chatId: 'oc-1', event: 'task-completed', taskId: 'loader-task' }, 'ops-notify-offline')
  const chat = transportFor()
  const disposeChat = ctx.supervisorOps.useChatTransport(chat.transport)
  const online = await callTool(ctx, agent, 'supervisor_notify', { chatId: 'oc-1', event: 'task-completed', taskId: 'loader-task' }, 'ops-notify-online')

  const shutdown = await callTool(ctx, agent, 'supervisor_shutdown', { trigger: 'all-tasks-completed' }, 'ops-shutdown')

  chat.deliver({ id: 'm-1', chatId: 'oc-1', senderId: 'u-9', text: '进度？', receivedAt: Date.now() })

  const report = await callTool(ctx, agent, 'supervisor_report', {
    taskId: 'loader-task',
    title: 'Ops loader',
    outcome: 'completed',
  }, 'ops-report')

  disposeChat()
  const chatForgotten = ctx.supervisorOps.chat === undefined

  await writeFile('./supervisor-ops-loader-report.json', JSON.stringify({
    tools: ctx.tools.schemas().map(schema => schema.name).filter(name => name.startsWith('supervisor_')).sort(),
    budgetTokens: budgetValue.tokens,
    budgetEntries: budgetValue.entries,
    notifyBeforeTransport: (offline.value as { delivered: boolean }).delivered,
    notifyAfterTransport: (online.value as { delivered: boolean }).delivered,
    chatSent: chat.sent,
    shutdownAllowed: (shutdown.value as { allowed: boolean }).allowed,
    steered,
    reportPath: (report.value as { path: string }).path,
    chatForgotten,
  }))
} finally {
  await ctx.fiber.dispose()
}
