/**
 * Review packets and issue tickets for the execute-then-review pass. A packet
 * collects the facts a reviewing model reads — plan, checkpoints, diff, and
 * terminal tail — and the findings it returns become one ticket that is
 * repaired, regression-checked, and either resolved or escalated. Tickets are
 * stored one JSON file per ticket so a repair survives a restart.
 * @module @deepseek-ai/dsh-supervisor-tasks/review
 */

import { randomBytes } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { SupervisorCheckpoint, TaskPlan } from '@deepseek-ai/dsh-supervisor-core'
import { recordFile, readRecordFile, taskDirectory } from './record-file.ts'

/** File permission bits for ticket records. */
const TICKET_FILE_MODE = 0o600

/** Severity ladder of one review finding. */
export type FindingSeverity = 'blocking' | 'high' | 'medium' | 'low' | 'nitpick'

/** Review dimension a finding belongs to. */
export type FindingCategory = 'requirement-gap' | 'test-failure' | 'code-quality' | 'security' | 'computer-use'

/** One review finding. */
export interface Finding {
  /** Stable id unique within the ticket. */
  id: string
  /** How badly this blocks delivery. */
  severity: FindingSeverity
  /** Which review dimension produced it. */
  category: FindingCategory
  /** One-line statement of the defect. */
  title: string
  /** Evidence: file, line, command, or output fragment. */
  evidence: string
  /** What is missing or wrong relative to the acceptance criteria. */
  gap: string
  /** Concrete repair the responsible agent should attempt. */
  suggestedFix: string
  /** Acceptance criterion this finding violates, when one applies. */
  acceptanceCriterionId?: string
}

/** Lifecycle of one issue ticket. */
export type TicketStatus = 'open' | 'in-redo' | 'in-regression' | 'resolved' | 'escalated'

/** One review round's findings and their repair state. */
export interface IssueTicket {
  /** Identity of this ticket. */
  ticketId: string
  /** Task the findings belong to. */
  taskId: string
  /** Findings still under repair, in declaration order. */
  findings: Finding[]
  /** Instructions handed to the responsible agent for the next attempt. */
  redoInstructions: string
  /** Checks the repair must re-run before the ticket can resolve. */
  regressionScope: string[]
  /** Repairs attempted so far. */
  retryCount: number
  /** Repairs allowed before the ticket escalates. */
  maxRetries: number
  /** Current lifecycle state. */
  status: TicketStatus
  /** Epoch milliseconds of creation. */
  createdAt: number
  /** Epoch milliseconds of the latest transition. */
  updatedAt: number
}

/** What a review round is assembled from. */
export interface ReviewPacketInput {
  /** Task under review. */
  taskId: string
  /** Plan the task ran under, when one was written. */
  plan?: TaskPlan
  /** Checkpoints taken, oldest first. */
  checkpoints: SupervisorCheckpoint[]
  /** Diff of the task's commit range, when a repository was available. */
  diff?: string
  /** Tail of the supervised terminal's output log, when one exists. */
  outputTail?: string
}

/**
 * A blocking-or-worse finding.
 * @param finding - finding to classify.
 * @returns true for the `blocking` and `high` severities.
 */
export function isBlocking(finding: Finding): boolean {
  return finding.severity === 'blocking' || finding.severity === 'high'
}

/**
 * Findings that prevent delivery: `blocking` and `high`.
 * @param findings - findings of one review round.
 * @returns the blocking findings, in input order.
 */
export function blockingFindings(findings: readonly Finding[]): Finding[] {
  return findings.filter(finding => isBlocking(finding))
}

/**
 * Build the packet a reviewing model reads.
 * @param input - task facts assembled for the review round.
 * @returns the complete Markdown packet.
 */
export function renderReviewPacket(input: ReviewPacketInput): string {
  const lines: string[] = []
  lines.push(`# Review packet: ${input.taskId}`)
  lines.push('')
  lines.push('## Plan')
  lines.push('')
  if (input.plan === undefined) {
    lines.push('(no plan recorded)')
  } else {
    lines.push(`- Goal: ${input.plan.goal}`)
    if (input.plan.acceptanceCriteria.length === 0) {
      lines.push('- Acceptance criteria: (none recorded)')
    } else {
      lines.push('- Acceptance criteria:')
      for (const criterion of input.plan.acceptanceCriteria) {
        lines.push(`  - ${criterion.id}: ${criterion.description} (${criterion.verificationMethod}, ${criterion.status})`)
      }
    }
  }
  lines.push('')
  lines.push('## Checkpoints')
  lines.push('')
  if (input.checkpoints.length === 0) {
    lines.push('(no checkpoints recorded)')
  } else {
    lines.push('| Checkpoint | Step | Attempt | Timestamp | Commit |')
    lines.push('|------------|------|---------|-----------|--------|')
    for (const checkpoint of input.checkpoints) {
      lines.push(`| ${checkpoint.checkpointId} | ${checkpoint.stepIndex} | ${checkpoint.attempt} | ${checkpoint.timestamp} | ${commitLabel(checkpoint)} |`)
    }
  }
  lines.push('')
  lines.push('## Diff')
  lines.push('')
  if (input.diff === undefined) lines.push('(no diff recorded)')
  else pushCodeFence(lines, 'diff', input.diff)
  lines.push('')
  lines.push('## Terminal output tail')
  lines.push('')
  if (input.outputTail === undefined) lines.push('(no terminal output recorded)')
  else pushCodeFence(lines, 'text', input.outputTail)
  lines.push('')
  return lines.join('\n')
}

/**
 * Start a ticket from one review round.
 * @param taskId - task the findings belong to.
 * @param findings - findings of the round, in declaration order.
 * @param options - retry budget, regression scope, and redo instructions.
 * @param now - epoch milliseconds of creation.
 * @returns the open ticket.
 * @throws TypeError when the retry budget is below one repair.
 */
export function openTicket(
  taskId: string,
  findings: readonly Finding[],
  options: { maxRetries: number; regressionScope?: readonly string[]; redoInstructions?: string },
  now: number,
): IssueTicket {
  if (options.maxRetries < 1) {
    throw new TypeError(`openTicket: maxRetries must be at least 1, got ${options.maxRetries}`)
  }
  return {
    ticketId: `ticket-${now.toString(36)}-${randomBytes(3).toString('hex')}`,
    taskId,
    findings: [...findings],
    redoInstructions: options.redoInstructions ?? '',
    regressionScope: [...(options.regressionScope ?? [])],
    retryCount: 0,
    maxRetries: options.maxRetries,
    status: 'open',
    createdAt: now,
    updatedAt: now,
  }
}

/**
 * Apply one lifecycle transition.
 * @param ticket - ticket to transition.
 * @param action - transition to apply.
 * @param now - epoch milliseconds of the transition.
 * @returns the transitioned ticket; the input ticket is left unchanged.
 * @throws Error when the action does not apply to the ticket's current status.
 */
export function advanceTicket(
  ticket: IssueTicket,
  action: 'redo' | 'regression-passed' | 'regression-failed',
  now: number,
): IssueTicket {
  if (ticket.status === 'resolved' || ticket.status === 'escalated') {
    throw new Error(`cannot apply '${action}' to ${ticket.ticketId}: status '${ticket.status}' is terminal`)
  }
  if (action === 'redo' && (ticket.status === 'open' || ticket.status === 'in-redo')) {
    return attemptRepair(ticket, now)
  }
  if (action === 'regression-passed' && acceptsRegression(ticket.status)) {
    return { ...ticket, status: 'resolved', updatedAt: now }
  }
  if (action === 'regression-failed' && acceptsRegression(ticket.status)) {
    return attemptRepair(ticket, now)
  }
  throw new Error(`cannot apply '${action}' to ${ticket.ticketId} in status '${ticket.status}'`)
}

/**
 * Render the instructions sent to the responsible agent.
 * @param ticket - ticket whose repair is being dispatched.
 * @returns the complete brief, free of code fences.
 */
export function renderRedoBrief(ticket: IssueTicket): string {
  const lines: string[] = []
  lines.push(`Redo ticket ${ticket.ticketId} for task ${ticket.taskId}`)
  lines.push('')
  lines.push(`Status: ${ticket.status}; retry ${ticket.retryCount} of ${ticket.maxRetries}`)
  lines.push('')
  lines.push('Instructions:')
  lines.push(ticket.redoInstructions || '(none given)')
  lines.push('')
  lines.push('Findings to repair:')
  if (ticket.findings.length === 0) {
    lines.push('- (none recorded)')
  } else {
    for (const finding of ticket.findings) {
      lines.push(`- [${finding.severity}] ${finding.title}: ${finding.suggestedFix}`)
    }
  }
  lines.push('')
  lines.push('Regression checks that must pass:')
  if (ticket.regressionScope.length === 0) {
    lines.push('- (none recorded)')
  } else {
    for (const check of ticket.regressionScope) lines.push(`- ${check}`)
  }
  lines.push('')
  return lines.join('\n')
}

/**
 * One JSON file per ticket under a tickets directory.
 */
export class IssueStore {
  constructor(private readonly directory: string) {}

  /**
   * Directory holding the ticket files.
   * @returns the absolute tickets directory path.
   */
  get path(): string {
    return this.directory
  }

  /**
   * Write one ticket file.
   * @param ticket - complete ticket to store.
   * @returns the stored ticket and the path written.
   */
  async create(ticket: IssueTicket): Promise<{ ticket: IssueTicket; path: string }> {
    const path = await this.write(ticket)
    return { ticket, path }
  }

  /**
   * Persist a ticket, replacing any previous version.
   * @param ticket - complete ticket to store.
   * @returns the path written.
   */
  async write(ticket: IssueTicket): Promise<string> {
    const path = this.fileFor(ticket.taskId, ticket.ticketId)
    await writeFileAtomic(path, `${JSON.stringify(ticket, null, 2)}\n`, {
      mode: TICKET_FILE_MODE,
      dirMode: 0o700,
    })
    return path
  }

  /**
   * Read one ticket, or the newest for a task.
   * @param taskId - task whose ticket to read.
   * @param ticketId - specific ticket; omitted selects the newest by creation time.
   * @returns the ticket, or undefined when the task has no matching ticket.
   */
  async read(taskId: string, ticketId?: string): Promise<IssueTicket | undefined> {
    if (ticketId !== undefined) {
      return await this.readFile(this.fileFor(taskId, ticketId))
    }
    const tickets = await this.list(taskId)
    return tickets.at(-1)
  }

  /**
   * List a task's tickets.
   * @param taskId - task whose tickets to list.
   * @returns tickets ordered oldest first; unreadable files are skipped.
   */
  async list(taskId: string): Promise<IssueTicket[]> {
    let names: string[]
    try {
      names = await readdir(this.taskDirectory(taskId))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const tickets: IssueTicket[] = []
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const ticket = await this.readFile(join(this.taskDirectory(taskId), name))
      if (ticket) tickets.push(ticket)
    }
    return tickets.sort((left, right) => left.createdAt - right.createdAt)
  }

  /** Read one ticket file, treating a missing or malformed file as absent. */
  private readFile(path: string): Promise<IssueTicket | undefined> {
    return readRecordFile<IssueTicket>(path)
  }

  /** Directory holding one task's tickets. */
  private taskDirectory(taskId: string): string {
    return taskDirectory(this.directory, taskId)
  }

  /** Absolute path of one ticket file. */
  private fileFor(taskId: string, ticketId: string): string {
    return recordFile(this.directory, taskId, ticketId)
  }
}

/** Commit pinned by a checkpoint, when the checkpoint recorded git facts. */
function commitLabel(checkpoint: SupervisorCheckpoint): string {
  return checkpoint.gitRef?.commitHash || '(none)'
}

/** Append one fenced code block, keeping the closing fence on its own line. */
function pushCodeFence(lines: string[], language: string, body: string): void {
  lines.push(`\`\`\`${language}`)
  lines.push(body.replace(/\n+$/, ''))
  lines.push('```')
}

/** Whether a status accepts the regression actions. */
function acceptsRegression(status: TicketStatus): boolean {
  return status === 'in-redo' || status === 'in-regression'
}

/** Record one repair attempt, escalating once the retry budget is spent. */
function attemptRepair(ticket: IssueTicket, now: number): IssueTicket {
  const retryCount = ticket.retryCount + 1
  return {
    ...ticket,
    retryCount,
    status: retryCount >= ticket.maxRetries ? 'escalated' : 'in-redo',
    updatedAt: now,
  }
}
