import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SupervisorCheckpoint, TaskPlan } from '@deepseek-ai/dsh-supervisor-core'
import {
  IssueStore,
  advanceTicket,
  blockingFindings,
  isBlocking,
  openTicket,
  renderRedoBrief,
  renderReviewPacket,
  type Finding,
  type IssueTicket,
} from '../src/review.ts'

let root = ''

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-supervisor-tasks-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** A minimal plan with two acceptance criteria. */
function taskPlan(taskId: string): TaskPlan {
  return {
    taskId,
    goal: 'ship the feature',
    constraints: ['no new dependencies'],
    acceptanceCriteria: [
      { id: 'ac-1', description: 'tests pass', verificationMethod: 'test-command', status: 'passed' },
      { id: 'ac-2', description: 'docs updated', verificationMethod: 'manual', status: 'pending' },
    ],
    subTasks: [],
    integrationStrategy: 'sequential-merge',
    createdAt: 1,
    updatedAt: 2,
  }
}

/** One checkpoint with the fields the packet renders. */
function checkpoint(checkpointId: string, gitRef?: SupervisorCheckpoint['gitRef']): SupervisorCheckpoint {
  return {
    schemaVersion: 1,
    checkpointId,
    taskId: 'task-a',
    stepIndex: 1,
    timestamp: 1_000,
    attempt: 1,
    supervisorSessionId: 'sess-1',
    ...gitRef === undefined ? {} : { gitRef },
  }
}

/** One finding with the required fields defaulted. */
function finding(overrides: Partial<Finding> & Pick<Finding, 'id' | 'severity'>): Finding {
  return {
    category: 'code-quality',
    title: `defect ${overrides.id}`,
    evidence: 'src/a.ts:12',
    gap: 'does not satisfy ac-1',
    suggestedFix: 'repair it',
    ...overrides,
  }
}

/** One ticket record with explicit identity and timestamps. */
function storedTicket(ticketId: string, createdAt: number): IssueTicket {
  return {
    ticketId,
    taskId: 'task-a',
    findings: [],
    redoInstructions: '',
    regressionScope: [],
    retryCount: 0,
    maxRetries: 2,
    status: 'open',
    createdAt,
    updatedAt: createdAt,
  }
}

describe('findings', () => {
  it('ranks blocking and high findings above the rest', () => {
    expect(isBlocking(finding({ id: 'f-1', severity: 'blocking' }))).toBe(true)
    expect(isBlocking(finding({ id: 'f-2', severity: 'high' }))).toBe(true)
    expect(isBlocking(finding({ id: 'f-3', severity: 'medium' }))).toBe(false)
    expect(isBlocking(finding({ id: 'f-4', severity: 'nitpick' }))).toBe(false)
  })

  it('keeps only the delivery-blocking findings in declaration order', () => {
    const findings = [
      finding({ id: 'f-1', severity: 'low' }),
      finding({ id: 'f-2', severity: 'high' }),
      finding({ id: 'f-3', severity: 'blocking' }),
      finding({ id: 'f-4', severity: 'medium' }),
    ]
    expect(blockingFindings(findings).map(entry => entry.id)).toEqual(['f-2', 'f-3'])
    expect(blockingFindings([])).toEqual([])
  })
})

describe('review packets', () => {
  it('renders the plan, checkpoints, diff, and terminal tail', () => {
    const markdown = renderReviewPacket({
      taskId: 'task-a',
      plan: taskPlan('task-a'),
      checkpoints: [
        checkpoint('cp-1', { repoPath: '/repo', branch: 'supervisor/task-a', commitHash: 'deadbeef', hasUncommitted: false }),
        checkpoint('cp-2', { repoPath: '/repo', branch: 'supervisor/task-a', commitHash: '', hasUncommitted: true }),
        checkpoint('cp-3'),
      ],
      diff: 'diff --git a/x b/x\n+added\n',
      outputTail: 'ok\n',
    })
    expect(markdown).toContain('# Review packet: task-a')
    expect(markdown).toContain('- Goal: ship the feature')
    expect(markdown).toContain('ac-1: tests pass (test-command, passed)')
    expect(markdown).toContain('ac-2: docs updated (manual, pending)')
    expect(markdown).toContain('| cp-1 | 1 | 1 | 1000 | deadbeef |')
    expect(markdown).toContain('| cp-2 |')
    expect(markdown).toContain('| cp-3 |')
    expect(markdown).toContain('| (none) |')
    expect(markdown).toContain('```diff\ndiff --git a/x b/x\n+added\n```')
    expect(markdown).toContain('```text\nok\n```')
  })

  it('states every missing section instead of rendering it empty', () => {
    const markdown = renderReviewPacket({ taskId: 'task-b', checkpoints: [] })
    expect(markdown).toContain('(no plan recorded)')
    expect(markdown).toContain('(no checkpoints recorded)')
    expect(markdown).toContain('(no diff recorded)')
    expect(markdown).toContain('(no terminal output recorded)')
  })

  it('states explicitly when the plan recorded no acceptance criteria', () => {
    const markdown = renderReviewPacket({
      taskId: 'task-c',
      plan: { ...taskPlan('task-c'), acceptanceCriteria: [] },
      checkpoints: [],
    })
    expect(markdown).toContain('- Acceptance criteria: (none recorded)')
    expect(markdown).not.toContain('  - ac-')
  })

  it('closes a code fence on its own line when the body has no trailing newline', () => {
    const markdown = renderReviewPacket({ taskId: 'task-d', checkpoints: [], diff: '+only line' })
    expect(markdown).toContain('```diff\n+only line\n```')
  })
})

describe('issue tickets', () => {
  it('opens a ticket with the round findings and the supplied options', () => {
    const opened = openTicket(
      'task-a',
      [finding({ id: 'f-1', severity: 'blocking' })],
      { maxRetries: 2, regressionScope: ['npm test'], redoInstructions: 'fix the gap' },
      5_000,
    )
    expect(opened.ticketId).toMatch(/^ticket-/)
    expect(opened.taskId).toBe('task-a')
    expect(opened.findings.map(entry => entry.id)).toEqual(['f-1'])
    expect(opened.redoInstructions).toBe('fix the gap')
    expect(opened.regressionScope).toEqual(['npm test'])
    expect(opened.retryCount).toBe(0)
    expect(opened.maxRetries).toBe(2)
    expect(opened.status).toBe('open')
    expect(opened.createdAt).toBe(5_000)
    expect(opened.updatedAt).toBe(5_000)
  })

  it('defaults the optional fields and still opens a ticket with no findings', () => {
    const opened = openTicket('task-a', [], { maxRetries: 1 }, 1_000)
    expect(opened.findings).toEqual([])
    expect(opened.redoInstructions).toBe('')
    expect(opened.regressionScope).toEqual([])
    expect(opened.status).toBe('open')
  })

  it('refuses a retry budget below one repair', () => {
    expect(() => openTicket('task-a', [], { maxRetries: 0 }, 1_000)).toThrow(TypeError)
    expect(() => openTicket('task-a', [], { maxRetries: 0 }, 1_000)).toThrow(/maxRetries must be at least 1/)
  })

  it('increments the retry count on redo and leaves the input ticket unchanged', () => {
    const opened = openTicket('task-a', [], { maxRetries: 3 }, 1_000)
    const first = advanceTicket(opened, 'redo', 2_000)
    expect(first.status).toBe('in-redo')
    expect(first.retryCount).toBe(1)
    expect(first.updatedAt).toBe(2_000)
    expect(opened.status).toBe('open')
    expect(opened.retryCount).toBe(0)
    const second = advanceTicket(first, 'redo', 3_000)
    expect(second.status).toBe('in-redo')
    expect(second.retryCount).toBe(2)
  })

  it('escalates once the retry increment reaches the budget', () => {
    const opened = openTicket('task-a', [], { maxRetries: 3 }, 1_000)
    const exhausted = advanceTicket(advanceTicket(advanceTicket(opened, 'redo', 2_000), 'redo', 3_000), 'redo', 4_000)
    expect(exhausted.status).toBe('escalated')
    expect(exhausted.retryCount).toBe(3)
    expect(exhausted.updatedAt).toBe(4_000)
    const single = advanceTicket(openTicket('task-a', [], { maxRetries: 1 }, 1_000), 'redo', 2_000)
    expect(single.status).toBe('escalated')
    expect(single.retryCount).toBe(1)
    expect(single.updatedAt).toBe(2_000)
  })

  it('resolves the ticket when the regression passes', () => {
    const redone = advanceTicket(openTicket('task-a', [], { maxRetries: 2 }, 1_000), 'redo', 2_000)
    const resolved = advanceTicket(redone, 'regression-passed', 3_000)
    expect(resolved.status).toBe('resolved')
    expect(resolved.retryCount).toBe(1)
    expect(resolved.updatedAt).toBe(3_000)
  })

  it('re-enters redo when the regression fails and escalates at the budget', () => {
    const opened = openTicket('task-a', [], { maxRetries: 3 }, 1_000)
    const failed = advanceTicket(advanceTicket(opened, 'redo', 2_000), 'regression-failed', 3_000)
    expect(failed.status).toBe('in-redo')
    expect(failed.retryCount).toBe(2)
    const exhausted = advanceTicket(failed, 'regression-failed', 4_000)
    expect(exhausted.status).toBe('escalated')
    expect(exhausted.retryCount).toBe(3)
  })

  it('accepts the regression actions from in-regression', () => {
    const inRegression: IssueTicket = { ...storedTicket('ticket-in-regression', 1_000), status: 'in-regression' }
    const resolved = advanceTicket(inRegression, 'regression-passed', 2_000)
    expect(resolved.status).toBe('resolved')
    expect(resolved.updatedAt).toBe(2_000)
    const failed = advanceTicket(inRegression, 'regression-failed', 2_000)
    expect(failed.status).toBe('in-redo')
    expect(failed.retryCount).toBe(1)
  })

  it('rejects an action that does not apply to the current status', () => {
    const opened = openTicket('task-a', [], { maxRetries: 2 }, 1_000)
    expect(() => advanceTicket(opened, 'regression-passed', 2_000))
      .toThrow(`cannot apply 'regression-passed' to ${opened.ticketId} in status 'open'`)
    const inRegression: IssueTicket = { ...storedTicket('ticket-in-regression', 1_000), status: 'in-regression' }
    expect(() => advanceTicket(inRegression, 'redo', 2_000))
      .toThrow("cannot apply 'redo' to ticket-in-regression in status 'in-regression'")
  })

  it('rejects every action once the ticket is resolved or escalated', () => {
    const opened = openTicket('task-a', [], { maxRetries: 2 }, 1_000)
    for (const status of ['resolved', 'escalated'] as const) {
      for (const action of ['redo', 'regression-passed', 'regression-failed'] as const) {
        const terminal: IssueTicket = { ...opened, status }
        expect(() => advanceTicket(terminal, action, 2_000))
          .toThrow(`cannot apply '${action}' to ${opened.ticketId}: status '${status}' is terminal`)
      }
    }
  })
})

describe('redo briefs', () => {
  it('renders the ticket id, findings with their fixes, and the regression scope', () => {
    const opened = openTicket(
      'task-a',
      [finding({ id: 'f-1', severity: 'blocking', title: 'missing test', suggestedFix: 'add a test for X' })],
      { maxRetries: 2, regressionScope: ['npm test', 'tsc --noEmit'], redoInstructions: 'repair the gap' },
      1_000,
    )
    const brief = renderRedoBrief(opened)
    expect(brief).toContain(opened.ticketId)
    expect(brief).toContain('task-a')
    expect(brief).toContain('[blocking] missing test: add a test for X')
    expect(brief).toContain('repair the gap')
    expect(brief).toContain('- npm test')
    expect(brief).toContain('- tsc --noEmit')
    expect(brief).not.toContain('```')
  })

  it('states explicitly when no instructions, findings, or scope were recorded', () => {
    const brief = renderRedoBrief(openTicket('task-a', [], { maxRetries: 2 }, 1_000))
    expect(brief).toContain('(none given)')
    expect(brief.match(/\(none recorded\)/g)).toHaveLength(2)
    expect(brief).not.toContain('```')
  })
})

describe('issue store', () => {
  it('writes one file per ticket and reads it back', async () => {
    const directory = join(root, 'tickets')
    const store = new IssueStore(directory)
    const ticket = storedTicket('ticket-1', 1_000)
    const created = await store.create(ticket)
    expect(store.path).toBe(directory)
    expect(created.ticket).toBe(ticket)
    expect(created.path.endsWith(join('task-a', 'ticket-1.json'))).toBe(true)
    expect((await store.read('task-a', 'ticket-1'))?.updatedAt).toBe(1_000)
  })

  it('returns the newest ticket by creation time and lists oldest first', async () => {
    const store = new IssueStore(join(root, 'tickets'))
    await store.write(storedTicket('ticket-late', 2_000))
    await store.write(storedTicket('ticket-early', 1_000))
    expect((await store.read('task-a'))?.ticketId).toBe('ticket-late')
    expect((await store.list('task-a')).map(entry => entry.ticketId)).toEqual(['ticket-early', 'ticket-late'])
  })

  it('sanitizes the task and ticket ids into the path', async () => {
    const store = new IssueStore(join(root, 'tickets'))
    const path = await store.write({ ...storedTicket('ticket 1', 1_000), taskId: 'task a/b' })
    expect(path.endsWith(join('task_a_b', 'ticket_1.json'))).toBe(true)
  })

  it('reports a task with no tickets as empty', async () => {
    const store = new IssueStore(join(root, 'tickets'))
    expect(await store.read('task-none')).toBeUndefined()
    expect(await store.read('task-none', 'ticket-1')).toBeUndefined()
    expect(await store.list('task-none')).toEqual([])
  })

  it('skips files that are not tickets and treats a malformed ticket as absent', async () => {
    const directory = join(root, 'tickets')
    const store = new IssueStore(directory)
    await store.write(storedTicket('ticket-1', 1_000))
    await mkdir(join(directory, 'task-a'), { recursive: true })
    await writeFile(join(directory, 'task-a', 'notes.txt'), 'not a ticket', 'utf8')
    await writeFile(join(directory, 'task-a', 'broken.json'), '{ not json', 'utf8')
    expect((await store.list('task-a')).map(entry => entry.ticketId)).toEqual(['ticket-1'])
    expect(await store.read('task-a', 'broken')).toBeUndefined()
  })

  it('surfaces an unreadable ticket file instead of reporting it as absent', async () => {
    const directory = join(root, 'tickets')
    const store = new IssueStore(directory)
    await mkdir(join(directory, 'task-a', 'unreadable.json'), { recursive: true })
    await expect(store.read('task-a', 'unreadable')).rejects.toThrow()
    await expect(store.list('task-a')).rejects.toThrow()
  })

  it('surfaces a task directory that cannot be scanned', async () => {
    const directory = join(root, 'tickets')
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'task-a'), 'this is a file, not a directory', 'utf8')
    const store = new IssueStore(directory)
    await expect(store.list('task-a')).rejects.toThrow()
  })
})
