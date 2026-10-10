/**
 * Delivery report rendering and storage. The report is assembled from stored
 * facts — plan, checkpoints, git statistics — plus the narrative the
 * supervising model supplies; nothing in the deterministic sections is
 * re-derived from the conversation.
 * @module @deepseek-ai/dsh-supervisor-ops/report
 */

import { join } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { sanitize, type SupervisorCheckpoint, type TaskPlan } from '@deepseek-ai/dsh-supervisor-core'
import type { GitDiffStat } from '@deepseek-ai/dsh-supervisor-tasks'
import type { BudgetStatus } from './budget.ts'

/** Report file permission bits. */
const REPORT_FILE_MODE = 0o600

/** Everything the deterministic sections of a report are rendered from. */
export interface ReportInput {
  /** Task the report covers. */
  taskId: string
  /** Human-readable task title. */
  title: string
  /** Final outcome. */
  outcome: 'completed' | 'partial' | 'aborted'
  /** Plan the task ran under, when one was written. */
  plan?: TaskPlan
  /** Epoch milliseconds the task started. */
  startedAt?: number
  /** Epoch milliseconds the task finished. */
  completedAt: number
  /** Checkpoints taken, oldest first. */
  checkpoints: SupervisorCheckpoint[]
  /** Diff statistics of the task's commit range. */
  diffStat: GitDiffStat
  /** Model-written review summary, when a review ran. */
  reviewSummary?: string
  /** Spend recorded for the task, when the ledger was read. */
  budget?: BudgetStatus
  /** Model-written follow-up suggestions. */
  followUps?: string[]
  /** Durable rollback instructions, when a checkpoint pinned a commit. */
  rollback?: string
}

/**
 * Render the delivery report as Markdown.
 * @param input - report contents.
 * @returns the complete Markdown document.
 */
export function renderReport(input: ReportInput): string {
  const lines: string[] = []
  lines.push(`# 任务交付报告：${input.title}`)
  lines.push('')
  lines.push('## 任务概述')
  lines.push('')
  lines.push(`- 任务 ID：${input.taskId}`)
  lines.push(`- 目标：${input.plan?.goal ?? '(未记录计划)'}`)
  lines.push(`- 结果：${outcomeLabel(input.outcome)}`)
  lines.push(`- 完成时间：${formatTime(input.completedAt)}`)
  if (input.startedAt !== undefined) {
    lines.push(`- 开始时间：${formatTime(input.startedAt)}`)
    lines.push(`- 总耗时：${formatDuration(input.completedAt - input.startedAt)}`)
  }
  lines.push('')
  lines.push('## 子任务完成情况')
  lines.push('')
  if (input.plan && input.plan.subTasks.length > 0) {
    lines.push('| 子任务 | 建议 Agent | 状态 | 依赖 |')
    lines.push('|--------|-----------|------|------|')
    for (const subTask of input.plan.subTasks) {
      lines.push(`| ${escapeCell(subTask.title)} | ${subTask.preferredAgent ?? '-'} | ${statusLabel(subTask.status)} | ${subTask.dependsOn.join(', ') || '-'} |`)
    }
  } else {
    lines.push('(未记录子任务划分)')
  }
  lines.push('')
  lines.push('## 变更摘要')
  lines.push('')
  lines.push(`- 新增文件：${input.diffStat.filesAdded} 个`)
  lines.push(`- 修改文件：${input.diffStat.filesModified} 个`)
  lines.push(`- 删除文件：${input.diffStat.filesDeleted} 个`)
  lines.push(`- 代码行数：+${input.diffStat.linesInserted} / -${input.diffStat.linesDeleted}`)
  lines.push('')
  lines.push('## 审查结果')
  lines.push('')
  lines.push(input.reviewSummary ?? '(未记录审查)')
  lines.push('')
  lines.push('## 验收标准对照')
  lines.push('')
  const criteria = input.plan?.acceptanceCriteria ?? []
  if (criteria.length > 0) {
    lines.push('| 验收标准 | 状态 | 验证方式 |')
    lines.push('|---------|------|---------|')
    for (const criterion of criteria) {
      lines.push(`| ${escapeCell(criterion.description)} | ${criterionStatusLabel(criterion.status)} | ${criterion.verificationMethod} |`)
    }
  } else {
    lines.push('(未记录验收标准)')
  }
  lines.push('')
  lines.push('## 费用统计')
  lines.push('')
  if (input.budget === undefined) {
    lines.push('(未记录用量)')
  } else {
    lines.push(`- 任务费用：$${input.budget.taskUSD.toFixed(2)}`)
    lines.push(`- 当日费用：$${input.budget.dailyUSD.toFixed(2)}`)
    lines.push(`- 预算状态：${input.budget.exceeded ? '已超预算' : input.budget.alert ? '接近上限' : '正常'}`)
    if (input.budget.exceeded) lines.push(`- 超预算动作：${input.budget.onExceed}`)
  }
  lines.push('')
  lines.push('## 断点与回滚')
  lines.push('')
  if (input.checkpoints.length === 0) {
    lines.push('(未记录断点)')
  } else {
    const latest = input.checkpoints.at(-1)
    if (latest?.gitRef) {
      lines.push(`- 最终 git commit：${latest.gitRef.commitHash || '(无提交)'}`)
      lines.push(`- 断点分支：${latest.gitRef.branch}`)
    }
    lines.push(`- 断点文件：${input.checkpoints.length} 个`)
    lines.push(`- 最新断点：${latest?.checkpointId ?? '-'}（step ${latest?.stepIndex ?? 0}，attempt ${latest?.attempt ?? 0}）`)
    if (input.rollback !== undefined) lines.push(`- 回滚方式：${input.rollback}`)
  }
  lines.push('')
  lines.push('## 后续建议')
  lines.push('')
  const followUps = input.followUps ?? []
  if (followUps.length === 0) lines.push('(无)')
  else for (const followUp of followUps) lines.push(`- ${followUp}`)
  lines.push('')
  return lines.join('\n')
}

/** Outcome label used in the report body. */
function outcomeLabel(outcome: ReportInput['outcome']): string {
  if (outcome === 'completed') return '✅ 已完成'
  if (outcome === 'partial') return '⚠️ 部分完成'
  return '⛔ 已终止'
}

/** Subtask status label. */
function statusLabel(status: string): string {
  if (status === 'completed') return '✅ 完成'
  if (status === 'failed') return '❌ 失败'
  if (status === 'in-progress') return '🔄 进行中'
  if (status === 'skipped') return '⏭ 跳过'
  return '⏳ 待办'
}

/** Acceptance criterion status label. */
function criterionStatusLabel(status: string): string {
  if (status === 'passed') return '✅'
  if (status === 'failed') return '❌'
  return '⏳'
}

/** ISO-like local timestamp. */
function formatTime(epochMs: number): string {
  return new Date(epochMs).toISOString()
}

/** Human-readable duration. */
function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  if (hours > 0) return `${hours}小时${minutes}分钟`
  if (minutes > 0) return `${minutes}分钟`
  return `${seconds}秒`
}

/** Keep one table cell on one line. */
function escapeCell(value: string): string {
  return value.replaceAll('|', '\\|').replaceAll(/\r?\n/g, ' ')
}

/**
 * One Markdown file per task under a deliverables directory.
 */
export class ReportStore {
  constructor(private readonly directory: string) {}

  /**
   * Write one task's report.
   * @param taskId - task the report covers.
   * @param markdown - complete report body.
   * @returns the path written.
   */
  async write(taskId: string, markdown: string): Promise<string> {
    const path = join(this.directory, sanitize(taskId), 'report.md')
    await writeFileAtomic(path, markdown, { mode: REPORT_FILE_MODE, dirMode: 0o700 })
    return path
  }
}
