#!/usr/bin/env node
/**
 * Test driver: boot the supervisor-core Loader composition, register a scripted
 * terminal backend, drive one settlement through the tool registry, and persist
 * the observed model-visible surface to `./supervisor-core-loader-report.json`
 * for the package spec's inspect step. The spec reads the durable artifacts
 * itself, from the run directory.
 */

import { writeFile } from 'node:fs/promises'
import { boot, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { Agent, Inbox } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import type {
  TerminalBackendSession,
  TerminalReadRequest,
  TerminalReadResult,
  TerminalSendOperation,
  TerminalSendRequest,
  TerminalSessionStatus,
} from '@deepseek-ai/dsh-terminal'

const configPath = process.argv[2]
if (configPath === undefined) throw new Error('supervisor-core driver requires a config path')

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

/** An Inbox placeholder for the owner agent, which no loop drives here. */
function unsupportedInbox(): Inbox {
  const reject = (): never => {
    throw new Error('the loader driver Agent does not support Inbox mutations')
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

/** The backdrop the terminal service authorizes against. */
function ownerFor(scope: Context, id: string): Agent {
  const sessionId = SessionId(id)
  return {
    id: sessionId,
    options: {},
    session: Session.create(sessionId),
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

/** Run one supervisor tool through the registry, as a model turn would. */
function callTool(ctx: Context, agent: Agent, name: string, args: unknown, callId: string) {
  const run = ctx.tools['execute'].bind(ctx.tools)
  return run({ signal: new AbortController().signal, callId: ToolCallId(callId), name, arguments: args, agent })
}

const ctx = await boot('supervisor-core-loader-smoke', resolveConfigPath(configPath, undefined))
try {
  ctx.terminals.registerBackend({
    type: 'scripted',
    spawn: () => Promise.resolve(new ScriptedSession()),
  })

  const agent = ownerFor(ctx.plugin(() => {}).ctx, 'supervisor-core-loader-owner')
  await ctx.agents.register(agent)
  const openTerminal = ctx.terminals['spawn'].bind(ctx.terminals)
  const session = await openTerminal(agent, { type: 'scripted', name: 'loader', cwd: process.cwd() }, undefined)

  const settlement = await callTool(ctx, agent, 'supervisor_terminal_send', {
    sessionId: session.sessionId,
    text: 'trigger rate limit',
  }, 'loader-send')
  const value = settlement.value as {
    waitReason: string
    stateMarks: string[]
    l1Hits: { ruleId: string }[]
    spillPath?: string
  }

  await writeFile('./supervisor-core-loader-report.json', JSON.stringify({
    tools: ctx.tools.schemas().map(schema => schema.name).filter(name => name.startsWith('supervisor_')).sort(),
    sessionId: session.sessionId,
    waitReason: value.waitReason,
    stateMarks: value.stateMarks,
    l1RuleIds: value.l1Hits.map(hit => hit.ruleId),
    spillLogged: value.spillPath !== undefined,
    spillPath: value.spillPath ?? '',
  }))
} finally {
  await ctx.fiber.dispose()
}
