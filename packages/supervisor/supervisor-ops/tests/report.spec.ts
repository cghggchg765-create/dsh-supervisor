import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SubTask, SupervisorCheckpoint, TaskPlan } from '@deepseek-ai/dsh-supervisor-core'
import { ReportStore, renderReport, type ReportInput } from '../src/report.ts'

let root = ''

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-supervisor-ops-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** A minimal plan with one dependency edge between its two subtasks. */
function plan(taskId: string): TaskPlan {
  return {
    taskId,
    goal: 'ship the feature',
    constraints: ['no new dependencies'],
    acceptanceCriteria: [
      { id: 'ac-1', description: 'tests pass', verificationMethod: 'test-command', status: 'pending' },
    ],
    subTasks: [
      {
        id: 'st-1',
        title: 'write the parser',
        description: 'parse the input',
        dependsOn: [],
        requiredSkills: ['parsing'],
        estimatedEffort: 'small',
        acceptanceCriteria: ['round-trips'],
        status: 'completed',
      },
      {
        id: 'st-2',
        title: 'wire the CLI',
        description: 'expose the parser',
        dependsOn: ['st-1'],
        requiredSkills: [],
        estimatedEffort: 'medium',
        acceptanceCriteria: ['CLI prints JSON'],
        status: 'pending',
      },
    ],
    integrationStrategy: 'sequential-merge',
    createdAt: 1,
    updatedAt: 2,
  }
}

/** One subtask of the status matrix with every field the report reads. */
function subTask(id: string, title: string, status: SubTask['status']): SubTask {
  return {
    id,
    title,
    description: `${title} the work`,
    dependsOn: [],
    requiredSkills: [],
    estimatedEffort: 'small',
    acceptanceCriteria: [],
    status,
  }
}

/** Render one report with the required fields defaulted to an empty run. */
function report(overrides: Partial<ReportInput> & Pick<ReportInput, 'title' | 'outcome'>): string {
  return renderReport({
    taskId: 'task-report',
    completedAt: 0,
    checkpoints: [],
    diffStat: { filesAdded: 0, filesModified: 0, filesDeleted: 0, linesInserted: 0, linesDeleted: 0 },
    ...overrides,
  })
}

describe('delivery reports', () => {
  it('reports the spend against the budget and names the action once it is exceeded', () => {
    const normal = report({ title: 'Run', outcome: 'completed', budget: { taskUSD: 1.5, dailyUSD: 3, alert: false, exceeded: false, onExceed: 'downgrade-all' } })
    expect(normal).toContain('## 费用统计')
    expect(normal).toContain('- 任务费用：$1.50')
    expect(normal).toContain('- 预算状态：正常')
    expect(normal).not.toContain('- 超预算动作：')

    const near = report({ title: 'Run', outcome: 'completed', budget: { taskUSD: 4.2, dailyUSD: 9, alert: true, exceeded: false, onExceed: 'stop-task' } })
    expect(near).toContain('- 预算状态：接近上限')

    const over = report({ title: 'Run', outcome: 'partial', budget: { taskUSD: 6, dailyUSD: 21, alert: true, exceeded: true, onExceed: 'stop-task' } })
    expect(over).toContain('- 预算状态：已超预算')
    expect(over).toContain('- 超预算动作：stop-task')
  })

  it('says so when no spend was recorded', () => {
    expect(report({ title: 'Run', outcome: 'aborted' })).toContain('(未记录用量)')
  })

  it('renders the stored plan, acceptance criteria, and change summary', async () => {
    const markdown = renderReport({
      taskId: 'task-a',
      title: 'Ship the feature',
      outcome: 'completed',
      plan: plan('task-a'),
      startedAt: 0,
      completedAt: 3_600_000,
      checkpoints: [{
        schemaVersion: 1,
        checkpointId: 'cp-1',
        taskId: 'task-a',
        stepIndex: 2,
        timestamp: 1,
        attempt: 1,
        supervisorSessionId: 's',
        gitRef: { repoPath: '/repo', branch: 'supervisor/task-a', commitHash: 'deadbeef', hasUncommitted: false },
      }],
      diffStat: { filesAdded: 2, filesModified: 3, filesDeleted: 1, linesInserted: 40, linesDeleted: 7 },
      followUps: ['add a benchmark'],
    })
    expect(markdown).toContain('# 任务交付报告：Ship the feature')
    expect(markdown).toContain('write the parser')
    expect(markdown).toContain('✅ 完成')
    expect(markdown).toContain('+40 / -7')
    expect(markdown).toContain('deadbeef')
    expect(markdown).toContain('add a benchmark')
  })

  it('states the missing sections explicitly when nothing was recorded', () => {
    const markdown = renderReport({
      taskId: 'task-b',
      title: 'Bare task',
      outcome: 'aborted',
      completedAt: 0,
      checkpoints: [],
      diffStat: { filesAdded: 0, filesModified: 0, filesDeleted: 0, linesInserted: 0, linesDeleted: 0 },
    })
    expect(markdown).toContain('⛔ 已终止')
    expect(markdown).toContain('(未记录计划)')
    expect(markdown).toContain('(未记录断点)')
    expect(markdown).toContain('(无)')
  })

  it('writes one report per task', async () => {
    const store = new ReportStore(join(root, 'deliverables'))
    const path = await store.write('task-a', '# report\n')
    expect(path).toContain('task-a')
    expect(path.endsWith('report.md')).toBe(true)
  })

  it('labels every outcome', () => {
    expect(report({ title: 'Outcome', outcome: 'completed' })).toContain('✅ 已完成')
    expect(report({ title: 'Outcome', outcome: 'partial' })).toContain('⚠️ 部分完成')
    expect(report({ title: 'Outcome', outcome: 'aborted' })).toContain('⛔ 已终止')
  })

  it('labels every subtask and acceptance-criterion status', () => {
    const markdown = report({
      title: 'Statuses',
      outcome: 'partial',
      plan: {
        ...plan('task-status'),
        subTasks: [
          subTask('st-1', 'done', 'completed'),
          { ...subTask('st-2', 'broke', 'failed'), dependsOn: ['st-1'] },
          { ...subTask('st-3', 'busy', 'in-progress'), preferredAgent: 'codex' },
          subTask('st-4', 'skipped', 'skipped'),
          subTask('st-5', 'todo', 'pending'),
        ],
        acceptanceCriteria: [
          { id: 'ac-1', description: 'passes', verificationMethod: 'test-command', status: 'passed' },
          { id: 'ac-2', description: 'fails', verificationMethod: 'manual', status: 'failed' },
          { id: 'ac-3', description: 'unknown', verificationMethod: 'llm-judge', status: 'pending' },
        ],
      },
    })
    expect(markdown).toContain('✅ 完成')
    expect(markdown).toContain('❌ 失败')
    expect(markdown).toContain('🔄 进行中')
    expect(markdown).toContain('⏭ 跳过')
    expect(markdown).toContain('⏳ 待办')
    expect(markdown).toContain('| codex |')
    expect(markdown).toContain('| st-1 |')
    expect(markdown).toContain('| ✅ |')
    expect(markdown).toContain('| ❌ |')
    expect(markdown).toContain('| ⏳ |')
  })

  it('keeps pipe characters and newlines inside one table cell', () => {
    const markdown = report({
      title: 'Escaping',
      outcome: 'completed',
      reviewSummary: 'reviewed by a human',
      plan: {
        ...plan('task-escape'),
        subTasks: [subTask('st-1', 'parse | print\njson', 'pending')],
        acceptanceCriteria: [
          { id: 'ac-1', description: 'a | b\r\nc', verificationMethod: 'file-exists', status: 'pending' },
        ],
      },
    })
    expect(markdown).toContain('| parse \\| print json |')
    expect(markdown).toContain('| a \\| b c |')
    expect(markdown).toContain('reviewed by a human')
  })

  it('formats the elapsed time in seconds, minutes, or hours', () => {
    expect(report({ title: 'Duration', outcome: 'completed', startedAt: 0, completedAt: 45_000 }))
      .toContain('总耗时：45秒')
    expect(report({ title: 'Duration', outcome: 'completed', startedAt: 0, completedAt: 90_000 }))
      .toContain('总耗时：1分钟')
    expect(report({ title: 'Duration', outcome: 'completed', startedAt: 0, completedAt: 7_500_000 }))
      .toContain('总耗时：2小时5分钟')
    expect(report({ title: 'Duration', outcome: 'completed', startedAt: 60_000, completedAt: 0 }))
      .toContain('总耗时：0秒')
  })

  it('renders a checkpoint without git facts together with the rollback instructions', () => {
    const markdown = report({
      title: 'Bare checkpoint',
      outcome: 'partial',
      checkpoints: [{
        schemaVersion: 1,
        checkpointId: 'cp-bare',
        taskId: 'task-report',
        stepIndex: 4,
        timestamp: 1,
        attempt: 2,
        supervisorSessionId: 's',
      }],
      rollback: 'git checkout supervisor/task-a',
    })
    expect(markdown).toContain('- 断点文件：1 个')
    expect(markdown).toContain('- 最新断点：cp-bare（step 4，attempt 2）')
    expect(markdown).toContain('- 回滚方式：git checkout supervisor/task-a')
    expect(markdown).not.toContain('最终 git commit')
  })

  it('renders the placeholder commit when a checkpoint pinned no commit', () => {
    const markdown = report({
      title: 'No commit',
      outcome: 'partial',
      checkpoints: [{
        schemaVersion: 1,
        checkpointId: 'cp-nocommit',
        taskId: 'task-report',
        stepIndex: 0,
        timestamp: 1,
        attempt: 1,
        supervisorSessionId: 's',
        gitRef: { repoPath: root, branch: 'supervisor/task-a', commitHash: '', hasUncommitted: true },
      }],
    })
    expect(markdown).toContain('- 最终 git commit：(无提交)')
    expect(markdown).toContain('- 断点分支：supervisor/task-a')
  })

  it('states explicitly when a plan recorded no subtasks', () => {
    const markdown = report({
      title: 'No subtasks',
      outcome: 'completed',
      plan: { ...plan('task-report'), subTasks: [] },
    })
    expect(markdown).toContain('(未记录子任务划分)')
    expect(markdown).toContain('| 验收标准 | 状态 | 验证方式 |')
  })

  it('renders placeholder checkpoint fields when a non-empty list has no last entry', () => {
    // A sparse list has a length but no element at the end, so the section
    // still renders while the latest-checkpoint fields fall back to defaults.
    const markdown = report({
      title: 'Sparse checkpoints',
      outcome: 'partial',
      checkpoints: new Array<SupervisorCheckpoint>(1),
    })
    expect(markdown).toContain('- 断点文件：1 个')
    expect(markdown).toContain('- 最新断点：-（step 0，attempt 0）')
  })
})
