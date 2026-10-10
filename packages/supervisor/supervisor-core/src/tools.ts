/**
 * The model-facing tool surface of the control-plane core. Every tool here is
 * deterministic: it drives a terminal, scans text, or reads a record. None of
 * them decide whether the hosted agent is healthy — they return evidence and
 * let the supervising model judge inside the agent loop.
 * @module @deepseek-ai/dsh-supervisor-core/tools
 */

import { randomBytes } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { TerminalSessionId, type TerminalSessionStatus } from '@deepseek-ai/dsh-terminal'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { characteristicsFor, classifyOutput } from './adapter.ts'
import { AGENT_KINDS } from './agent-kinds.ts'
import type { SupervisorRuntime } from './index.ts'
import { quote, renderCommand, type ShellQuoting } from './runtime.ts'
import {
  BREAKER_STATE_ENUM,
  MARK_ENUM,
  OUTPUT_CLASS_ENUM,
  RULE_HIT_SCHEMA,
  SETTLEMENT_OUTPUT,
  SIGNAL_ENUM,
  declaredTerminal,
  describeStatus,
  requireAgent,
  ruleHits,
  settlementResult,
  settlementText,
} from './tool-support.ts'

/**
 * Register the supervised-terminal tools.
 * @param ctx - plugin context with the tools and terminals services.
 * @param runtime - the supervisor service.
 */
export function registerTools(ctx: Context, runtime: SupervisorRuntime): void {
  registerLaunch(ctx, runtime)
  registerSend(ctx, runtime)
  registerRun(ctx, runtime)
  registerRead(ctx, runtime)
  registerSignal(ctx, runtime)
  registerStatus(ctx, runtime)
}

/** Register `supervisor_agent_launch`. */
function registerLaunch(ctx: Context, runtime: SupervisorRuntime): void {
  ctx.tools.register(defineTool({
    name: 'supervisor_agent_launch',
    description:
      'Launch a managed CLI agent (Claude Code, Codex, dsh, ...) inside an existing terminal session and hand it the task prompt. '
      + 'Open the terminal first with terminal_open, then call this. Returns the settlement output plus deterministic state marks and L1 rule hits.',
    parameters: {
      sessionId: { type: 'string', required: true, description: 'Terminal session id returned by terminal_open.' },
      agentKind: { type: 'string', required: true, enum: AGENT_KINDS, description: 'Which CLI agent to launch.' },
      prompt: { type: 'string', required: true, description: 'Task prompt handed to the managed agent.' },
      model: { type: 'string', description: 'Model substituted into the launch template.' },
      taskId: { type: 'string', description: 'Task this terminal works on; scopes the spill log.' },
      extraArgs: { type: 'array', items: { type: 'string' }, description: 'Extra argv appended to the launch command.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sessionId: { type: 'string', required: true },
          command: { type: 'string', required: true, description: 'Command text that was sent.' },
          ...SETTLEMENT_OUTPUT,
        },
      },
      render: (_args, value) => [{ type: 'text', text: `launched: ${value.command}\n${settlementText(value.waitReason, value.output, value.stateMarks)}` }],
    },
    async execute(args, exec) {
      const { agent, sessionId } = declaredTerminal(runtime, exec, args)
      const template = runtime.config.agentTemplates[args.agentKind]
      const command = renderCommand(
        template.startCommand,
        {
          ...args.model === undefined ? {} : { model: args.model },
          prompt: args.prompt,
          profile: runtime.config.defaultProfile,
        },
        runtime.config.shellQuoting,
      )
      const extra = (args.extraArgs ?? []).map(argument => quote(argument, runtime.config.shellQuoting)).join(' ')
      const text = extra === '' ? command : `${command} ${extra}`
      const session = runtime.track(agent, sessionId, { kind: 'running' })
      session.agentKind = args.agentKind
      session.lastLaunchCommand = text
      if (args.taskId !== undefined) session.taskId = args.taskId
      if (args.model !== undefined) session.lastModel = args.model
      const operation = ctx.terminals.startSend(agent, sessionId, { text, submit: true, signal: exec.signal })
      const result = await operation.done
      const report = await runtime.observe(agent, sessionId, result.viewport, result.waitReason, result.sessionStatus, Date.now())
      return {
        sessionId: args.sessionId,
        command: text,
        ...settlementResult(report, result),
      }
    },
    presentCall: args => ({ card: 'generic', title: `Launch ${args.agentKind} in ${args.sessionId}`, kind: 'execute', rawInput: args.prompt }),
  }))
}

/** Register `supervisor_terminal_send`. */
function registerSend(ctx: Context, runtime: SupervisorRuntime): void {
  ctx.tools.register(defineTool({
    name: 'supervisor_terminal_send',
    description:
      'Send text to a supervised terminal and wait for the next settlement. Use it to answer prompts, send /model switches, or inject follow-up instructions. '
      + 'Returns the output, why the wait returned, deterministic state marks, and L1 rule hits.',
    parameters: {
      sessionId: { type: 'string', required: true, description: 'Terminal session id.' },
      text: { type: 'string', required: true, description: 'Text to send; include the full command, e.g. "/model sonnet".' },
      submit: { type: 'boolean', description: 'Press Enter after the text; defaults to true.' },
      agentKind: { type: 'string', enum: AGENT_KINDS, description: 'Hosted CLI, declared when the supervisor did not launch this terminal; remembered for later classifications.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          truncated: { type: 'boolean', required: true, description: 'Whether the terminal dropped output from this result.' },
          ...SETTLEMENT_OUTPUT,
        },
      },
      render: (_args, value) => [{ type: 'text', text: settlementText(value.waitReason, value.output, value.stateMarks) }],
    },
    async execute(args, exec) {
      const { agent, sessionId } = declaredTerminal(runtime, exec, args)
      const operation = ctx.terminals.startSend(agent, sessionId, {
        text: args.text,
        submit: args.submit ?? true,
        signal: exec.signal,
      })
      const result = await operation.done
      const report = await runtime.observe(agent, sessionId, result.viewport, result.waitReason, result.sessionStatus, Date.now())
      return {
        truncated: result.truncated,
        ...settlementResult(report, result),
      }
    },
    presentCall: args => ({ card: 'generic', title: `Send to ${args.sessionId}: ${args.text.slice(0, 40)}`, kind: 'execute' }),
  }))
}

/** One unique completion marker: the literal the command echoes, and its shell fragments. */
interface CompletionMarker {
  /** Literal text the command prints when it finishes, e.g. `DONE_1a2b3c`. */
  literal: string
  /** Suffix that keeps the typed command from containing the literal itself. */
  suffix: string
}

/**
 * Build the marker for one run. The command line is echoed by the terminal, so
 * the typed text must not contain the literal the completion check searches
 * for; the shell therefore assembles it from a variable at echo time.
 * @param random - hex characters identifying this run.
 * @returns the marker literal and the suffix used to assemble it.
 */
function buildMarker(random: string): CompletionMarker {
  return { literal: `DONE_${random}`, suffix: random }
}

/**
 * Wrap a command so its completion is visible in the output.
 * @param command - command text as the operator wrote it.
 * @param marker - marker to echo after the command.
 * @param quoting - shell dialect of the terminal.
 * @returns the text to send, which echoes the marker and the exit status.
 */
function wrapCommand(command: string, marker: CompletionMarker, quoting: ShellQuoting): string {
  if (quoting === 'powershell') {
    return `$M='DONE'; ${command}; echo "$($M)_${marker.suffix} rc=$LASTEXITCODE"`
  }
  return `M=DONE; ${command}; echo "\${M}_${marker.suffix} rc=$?"`
}

/** Register `supervisor_terminal_run`. */
function registerRun(ctx: Context, runtime: SupervisorRuntime): void {
  ctx.tools.register(defineTool({
    name: 'supervisor_terminal_run',
    description:
      'Send one shell command to a supervised terminal and wait until that command finishes, detected by a unique marker it echoes afterwards. '
      + 'Use it when the next step depends on the command having completed; supervisor_terminal_send only waits for the next quiet settlement and cannot tell a finished command from a paused one.',
    parameters: {
      sessionId: { type: 'string', required: true, description: 'Terminal session id.' },
      command: { type: 'string', required: true, description: 'Shell command to run; it is wrapped, not altered.' },
      timeoutSec: { type: 'integer', description: 'Seconds to wait for the marker; defaults to the configured run timeout.' },
      taskId: { type: 'string', description: 'Task this run belongs to; scopes the spill log.' },
      agentKind: { type: 'string', enum: AGENT_KINDS, description: 'Hosted CLI, declared when the supervisor did not launch this terminal.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          matched: { type: 'boolean', required: true, description: 'True when the completion marker appeared before the timeout.' },
          timedOut: { type: 'boolean', required: true, description: 'True when the wait expired without the marker.' },
          exitCode: { type: 'integer', description: 'Exit status the marker line reported, when it was parseable.' },
          marker: { type: 'string', required: true, description: 'Marker that was searched for.' },
          truncated: { type: 'boolean', required: true, description: 'Whether the terminal dropped output from this result.' },
          ...SETTLEMENT_OUTPUT,
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `${value.matched ? `finished rc=${value.exitCode ?? '?'}` : 'TIMED OUT'}${value.truncated ? ' (truncated)' : ''}
${value.output.slice(-4000)}`,
      }],
    },
    async execute(args, exec) {
      const { agent, sessionId } = declaredTerminal(runtime, exec, args)
      const session = runtime.track(agent, sessionId, { kind: 'running' })
      if (args.taskId !== undefined) session.taskId = args.taskId
      const timeoutSec = args.timeoutSec ?? runtime.config.runTimeoutSec
      if (!Number.isInteger(timeoutSec) || timeoutSec <= 0) {
        throw new Error('supervisor_terminal_run timeoutSec must be a positive integer')
      }
      const marker = buildMarker(randomBytes(4).toString('hex'))
      const text = wrapCommand(args.command, marker, runtime.config.shellQuoting)
      const operation = ctx.terminals.startSend(agent, sessionId, { text, submit: true, signal: exec.signal })
      const settled = await operation.done
      const deadline = Date.now() + timeoutSec * 1000
      let tail = settled.viewport
      let matched = tail.includes(marker.literal)
      while (!matched && !exec.signal.aborted && Date.now() < deadline) {
        await delay(Math.min(runtime.config.runPollIntervalMs, Math.max(0, deadline - Date.now())), exec.signal)
        tail = ctx.terminals.read(agent, sessionId, { count: RUN_TAIL_LINES }).text
        matched = tail.includes(marker.literal)
      }
      const report = await runtime.observe(agent, sessionId, tail, settled.waitReason, settled.sessionStatus, Date.now())
      const exitCode = parseMarkerExit(tail, marker)
      return {
        matched,
        timedOut: !matched,
        ...exitCode === undefined ? {} : { exitCode },
        marker: marker.literal,
        truncated: settled.truncated,
        // The result carries the command's output without the scaffolding line.
        ...settlementResult(report, { ...settled, viewport: stripMarker(tail, marker) }),
      }
    },
    presentCall: args => ({ card: 'generic', title: `Run in ${args.sessionId}: ${args.command.slice(0, 40)}`, kind: 'execute' }),
  }))
}

/** Lines of retained scrollback the completion poll inspects. */
const RUN_TAIL_LINES = 200

/** Read the exit status the marker line reported. */
function parseMarkerExit(text: string, marker: CompletionMarker): number | undefined {
  const line = text.split('\n').find(entry => entry.includes(marker.literal))
  if (line === undefined) return undefined
  const at = line.lastIndexOf('rc=')
  if (at === -1) return undefined
  const code = Number.parseInt(line.slice(at + 'rc='.length), 10)
  return Number.isFinite(code) ? code : undefined
}

/** Remove the marker line, which is supervisor scaffolding rather than command output. */
function stripMarker(text: string, marker: CompletionMarker): string {
  const lines = text.split('\n')
  return lines.filter(line => !line.includes(marker.literal)).join('\n')
}

/**
 * Sleep for one poll interval.
 * @param ms - milliseconds to wait.
 * @param signal - caller-owned cancellation, which ends the wait early.
 */
function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms)
    function finish(): void {
      clearTimeout(timer)
      signal.removeEventListener('abort', finish)
      resolve()
    }
    signal.addEventListener('abort', finish, { once: true })
  })
}

/** Register `supervisor_terminal_read`. */
function registerRead(ctx: Context, runtime: SupervisorRuntime): void {
  ctx.tools.register(defineTool({
    name: 'supervisor_terminal_read',
    description:
      'Read retained scrollback from a supervised terminal without sending anything, and scan it for L1 rule hits. '
      + 'A read observes text that was already produced, so it does not advance the heartbeat or append to the output log.',
    parameters: {
      sessionId: { type: 'string', required: true, description: 'Terminal session id.' },
      offset: { type: 'integer', description: 'Offset from the newest retained line; defaults to 0.' },
      count: { type: 'integer', description: 'Requested line count; the backend may cap it.' },
      agentKind: { type: 'string', enum: AGENT_KINDS, description: 'Hosted CLI, declared when the supervisor did not launch this terminal; remembered for later classifications.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true },
          totalLines: { type: 'integer', required: true },
          truncated: { type: 'boolean', required: true },
          stateMarks: { type: 'array', required: true, items: { type: 'string', enum: MARK_ENUM } },
          outputClass: { type: 'string', required: true, enum: OUTPUT_CLASS_ENUM, description: 'What the inspected text appears to be doing.' },
          l1Hits: { type: 'array', required: true, items: RULE_HIT_SCHEMA },
          heartbeatAgeSec: { type: 'integer', required: true, description: 'Seconds since the terminal last produced observed output.' },
          heartbeatStale: { type: 'boolean', required: true, description: 'True when that age exceeds the configured heartbeat timeout.' },
          spillPath: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `${value.totalLines} lines retained${value.truncated ? ' (truncated)' : ''}${value.heartbeatStale ? ' STALE' : ''}\n${value.text.slice(-4000)}` }],
    },
    async execute(args, exec) {
      const agent = requireAgent(exec)
      const sessionId = TerminalSessionId(args.sessionId)
      const result = ctx.terminals.read(agent, sessionId, {
        ...args.offset === undefined ? {} : { offset: args.offset },
        ...args.count === undefined ? {} : { count: args.count },
      })
      // The read succeeded, so the terminal exists; its last observed status is
      // what the supervisor knows about it, and a terminal never driven yet is
      // running by definition.
      const status: TerminalSessionStatus = runtime.sessions.get(sessionId)?.lastStatus ?? { kind: 'running' }
      if (args.agentKind !== undefined) runtime.declareAgent(agent, sessionId, args.agentKind, status)
      const record = await runtime.heartbeats.read(sessionId)
      const report = await runtime.inspect(agent, sessionId, result.text, status, Date.now())
      return {
        text: result.text,
        totalLines: result.totalLines,
        truncated: result.truncated,
        stateMarks: report.marks,
        outputClass: report.outputClass,
        l1Hits: ruleHits(report),
        heartbeatAgeSec: record === undefined ? 0 : Math.max(0, Math.round((Date.now() - record.lastOutputAt) / 1000)),
        heartbeatStale: report.heartbeatStale,
        ...report.spillPath === undefined ? {} : { spillPath: report.spillPath },
      }
    },
    presentCall: args => ({ card: 'generic', title: `Read ${args.sessionId}`, kind: 'read' }),
  }))
}

/** Register `supervisor_terminal_signal`. */
function registerSignal(ctx: Context, runtime: SupervisorRuntime): void {
  ctx.tools.register(defineTool({
    name: 'supervisor_terminal_signal',
    description:
      'Send a signal to a supervised terminal, optionally closing it afterwards. Use SIGINT to interrupt a runaway agent before retrying with new instructions.',
    parameters: {
      sessionId: { type: 'string', required: true, description: 'Terminal session id.' },
      signal: { type: 'string', required: true, enum: SIGNAL_ENUM, description: 'Signal to deliver.' },
      close: { type: 'boolean', description: 'Close the terminal after signalling; defaults to false.' },
      reason: { type: 'string', description: 'Why the signal is being sent; recorded with the heartbeat.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          delivered: { type: 'boolean', required: true },
          targetPgid: { type: 'integer', description: 'Process group that received the signal.' },
          sessionStatus: { type: 'string', required: true },
          closed: { type: 'boolean', required: true },
          heartbeatRemoved: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `signal delivered=${value.delivered} status=${value.sessionStatus} closed=${value.closed}` }],
    },
    async execute(args, exec) {
      const agent = requireAgent(exec)
      const sessionId = TerminalSessionId(args.sessionId)
      const result = await ctx.terminals.signal(agent, sessionId, args.signal)
      const statusAtSignal = runtime.sessions.get(sessionId)?.lastStatus ?? { kind: 'running' as const }
      let closed = false
      if (args.close ?? false) {
        closed = await ctx.terminals.kill(agent, sessionId, args.reason ?? `supervisor ${args.signal}`)
      }
      let heartbeatRemoved = false
      if (closed) {
        await runtime.heartbeats.remove(sessionId)
        runtime.forget(sessionId)
        heartbeatRemoved = true
      }
      return {
        delivered: result.delivered,
        targetPgid: result.targetPgid,
        sessionStatus: describeStatus(statusAtSignal),
        closed,
        heartbeatRemoved,
      }
    },
    presentCall: args => ({ card: 'generic', title: `${args.signal} -> ${args.sessionId}`, kind: 'execute' }),
  }))
}

/** Register `supervisor_status`. */
function registerStatus(ctx: Context, runtime: SupervisorRuntime): void {
  ctx.tools.register(defineTool({
    name: 'supervisor_status',
    description:
      'Report every terminal this supervisor is watching: heartbeat age, staleness, last observed status, and the tasks with their subtask progress. Check this before deciding to intervene.',
    parameters: {
      sessionId: { type: 'string', description: 'Restrict the report to one terminal session.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sessions: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                sessionId: { type: 'string', required: true },
                agentKind: { type: 'string' },
                status: { type: 'string', required: true },
                heartbeatAgeSec: { type: 'integer', required: true },
                stale: { type: 'boolean', required: true },
                lastWaitReason: { type: 'string', required: true },
                outputClass: { type: 'string', required: true, enum: OUTPUT_CLASS_ENUM },
                breaker: { type: 'string', required: true, enum: BREAKER_STATE_ENUM },
                breakerNoProgress: { type: 'integer', required: true },
                taskId: { type: 'string' },
                spillPath: { type: 'string' },
              },
            },
          },
          tasks: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                taskId: { type: 'string', required: true },
                goal: { type: 'string', required: true },
                subTasks: { type: 'integer', required: true },
                completed: { type: 'integer', required: true },
                failed: { type: 'integer', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.sessions.length === 0
          ? 'no supervised terminals'
          : value.sessions.map(session => `${session.sessionId} ${session.status} last-output=${session.heartbeatAgeSec}s${session.stale ? ' STALE' : ''}${session.taskId === undefined ? '' : ` task=${session.taskId}`}`).join('\n'),
      }],
    },
    async execute(args, exec) {
      const agent = requireAgent(exec)
      const now = Date.now()
      const known = new Set(ctx.terminals.list(agent).map(entry => entry.sessionId))
      const sessions = []
      for (const session of runtime.sessions.values()) {
        if (args.sessionId !== undefined && session.sessionId !== args.sessionId) continue
        const heartbeat = await runtime.heartbeats.read(session.sessionId)
        const lastOutputAt = heartbeat?.lastOutputAt ?? session.lastOutputAt
        const ageSec = Math.max(0, Math.round((now - lastOutputAt) / 1000))
        const breaker = session.breaker.report(now)
        sessions.push({
          sessionId: session.sessionId,
          ...session.agentKind === undefined ? {} : { agentKind: session.agentKind },
          status: known.has(session.sessionId) ? describeStatus(session.lastStatus) : 'closed',
          heartbeatAgeSec: ageSec,
          outputClass: classifyOutput(session.previousObservation ?? '', characteristicsFor(session.agentKind).characteristics).kind,
          breaker: breaker.state,
          breakerNoProgress: breaker.consecutiveNoProgress,
          stale: runtime.heartbeats.isStale({
            sessionId: session.sessionId,
            lastOutputAt,
            lastWaitReason: session.lastWaitReason,
            consecutiveStaleChecks: heartbeat?.consecutiveStaleChecks ?? 0,
          }, now),
          lastWaitReason: session.lastWaitReason,
          ...session.taskId === undefined ? {} : { taskId: session.taskId },
          ...session.spillPath === undefined ? {} : { spillPath: session.spillPath },
        })
      }
      const tasks = (await runtime.plans.list()).map(plan => ({
        taskId: plan.taskId,
        goal: plan.goal,
        subTasks: plan.subTasks.length,
        completed: plan.subTasks.filter(subTask => subTask.status === 'completed').length,
        failed: plan.subTasks.filter(subTask => subTask.status === 'failed').length,
      }))
      return { sessions, tasks }
    },
    presentCall: () => ({ card: 'generic', title: 'Supervisor status', kind: 'read' }),
  }))
}
