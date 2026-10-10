#!/usr/bin/env node
/**
 * Test driver: boot the orchestration Loader composition, register a scripted
 * terminal backend, drive a skill scan, a model switch, and a dispatch through
 * the tool registry, and persist the observed model-visible surface to
 * `./orchestration-loader-report.json` for the package spec's inspect step. The
 * spec reads the durable inventory itself, from the run directory.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { boot, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { TaskPlan } from '@deepseek-ai/dsh-supervisor-core'
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
if (configPath === undefined) throw new Error('orchestration driver requires a config path')

/** The scripted settlement: the CLI echoing the command it was sent. */
const SCRIPTED_OUTPUT = ['prompt ready', '$ switch', 'prompt ready'].join('\n')

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

/** The plan the dispatch call reads: one subtask whose worktree path is reported. */
const PLAN: TaskPlan = {
  taskId: 'loader-task',
  goal: 'prove the assembled orchestration surface',
  constraints: [],
  acceptanceCriteria: [],
  subTasks: [{
    id: 'st-1',
    title: 'write the parser',
    description: 'parse the input',
    dependsOn: [],
    requiredSkills: [],
    estimatedEffort: 'small',
    acceptanceCriteria: [],
    status: 'pending',
  }],
  integrationStrategy: 'sequential-merge',
  createdAt: 1,
  updatedAt: 1,
}

// The skill root the scan reads, created before the plugin resolves it.
await mkdir('./home/.claude/skills/react-component', { recursive: true })

const ctx = await boot('orchestration-loader-smoke', resolveConfigPath(configPath, undefined))
try {
  ctx.terminals.registerBackend({
    type: 'scripted',
    spawn: () => Promise.resolve(new ScriptedSession()),
  })

  const agent = ownerFor(ctx.plugin(() => {}).ctx, 'orchestration-loader-owner')
  await ctx.agents.register(agent)
  const openTerminal = ctx.terminals['spawn'].bind(ctx.terminals)
  const session = await openTerminal(agent, { type: 'scripted', name: 'loader', cwd: process.cwd() }, undefined)

  const skills = await callTool(ctx, agent, 'supervisor_skills', {
    action: 'scan',
    agentKind: 'claude-code',
  }, 'loader-skills')
  const switched = await callTool(ctx, agent, 'supervisor_agent_switch', {
    sessionId: session.sessionId,
    model: 'sonnet',
    agentKind: 'claude-code',
  }, 'loader-switch')
  await ctx.supervisor.plans.write(PLAN)
  const dispatch = await callTool(ctx, agent, 'supervisor_dispatch', { taskId: 'loader-task' }, 'loader-dispatch')

  await writeFile('./orchestration-loader-report.json', JSON.stringify({
    tools: ctx.tools.schemas().map(schema => schema.name).filter(name => name.startsWith('supervisor_')).sort(),
    sessionId: session.sessionId,
    skills: (skills.value as { inventories: { agentKind: string; skills: string[] }[] }).inventories,
    switched: (switched.value as { switched: boolean }).switched,
    model: (switched.value as { model?: string }).model,
    batch: (dispatch.value as { batch: { id: string }[] }).batch.map(subTask => subTask.id),
  }))
} finally {
  await ctx.fiber.dispose()
}
