/**
 * Per-subtask git worktrees and the scheduling that decides which of them may
 * run. Every subtask works in its own worktree and branch, so parallel hosted
 * agents never share a working copy; completed work merges in dependency order.
 * @module @deepseek-ai/dsh-supervisor-orchestration/worktree
 */

import { join, relative, resolve } from 'node:path'
import { sanitize, type SubTask } from '@deepseek-ai/dsh-supervisor-core'
import type { GitRunner } from '@deepseek-ai/dsh-supervisor-tasks'

/** One subtask's isolated worktree. */
export interface WorktreeRecord {
  /** Task the worktree serves. */
  taskId: string
  /** Subtask the worktree serves. */
  subTaskId: string
  /** Absolute path of the worktree. */
  path: string
  /** Branch checked out in that worktree. */
  branch: string
}

/** Path of the first segment of a relative path that leaves its base. */
const ESCAPES_BASE = /^(?:[A-Za-z]:[\\/]|[\\/]|\.\.(?:[\\/]|$))/

/** Header of one worktree block in a porcelain listing. */
const WORKTREE_HEADER = 'worktree '

/** Header of the branch line inside one porcelain block. */
const BRANCH_HEADER = 'branch '

/** Prefix of the full branch ref a porcelain block reports. */
const HEADS_PREFIX = 'refs/heads/'

/** Separator between the path segments of a worktree path. */
const PATH_SEPARATOR = /[\\/]/

/**
 * Create, list, and remove the worktrees one task's subtasks run in.
 */
export class WorktreeManager {
  /**
   * @param git - runner used for every git invocation.
   * @param baseDir - absolute directory the worktrees are created under.
   * @param branchPrefix - prefix of the branch each worktree checks out.
   */
  constructor(
    private readonly git: GitRunner,
    private readonly baseDir: string,
    private readonly branchPrefix: string,
  ) {}

  /**
   * Absolute path one subtask's worktree uses, without creating it.
   * @param taskId - task the worktree serves.
   * @param subTaskId - subtask the worktree serves.
   * @returns the path below the base directory, with both ids made path-safe.
   */
  pathFor(taskId: string, subTaskId: string): string {
    return join(this.baseDir, sanitize(taskId), sanitize(subTaskId))
  }

  /**
   * Add a worktree for one subtask. The branch repeats the sanitized ids, so it
   * always names the worktree path git was handed.
   * @param repoPath - repository the worktree is added to.
   * @param taskId - task the worktree serves.
   * @param subTaskId - subtask the worktree serves.
   * @param baseRef - commit or branch the new worktree starts at.
   * @param signal - caller-owned cancellation.
   * @returns the created record; undefined when git refused the add.
   */
  async create(
    repoPath: string,
    taskId: string,
    subTaskId: string,
    baseRef: string,
    signal?: AbortSignal,
  ): Promise<WorktreeRecord | undefined> {
    const safeTask = sanitize(taskId)
    const safeSubTask = sanitize(subTaskId)
    const path = this.pathFor(taskId, subTaskId)
    const branch = `${this.branchPrefix}${safeTask}/${safeSubTask}`
    const added = await this.git.run(repoPath, ['worktree', 'add', path, '-b', branch, baseRef], signal)
    return added.ok ? { taskId: safeTask, subTaskId: safeSubTask, path, branch } : undefined
  }

  /**
   * Worktrees currently registered for the repository.
   * @param repoPath - repository whose worktrees are listed.
   * @param signal - caller-owned cancellation.
   * @returns one record per worktree below the base directory, in listing
   * order; a repository git cannot read lists nothing.
   */
  async list(repoPath: string, signal?: AbortSignal): Promise<WorktreeRecord[]> {
    const listed = await this.git.run(repoPath, ['worktree', 'list', '--porcelain'], signal)
    if (!listed.ok) return []
    return parseWorktrees(listed.stdout, this.baseDir)
  }

  /**
   * Remove one worktree.
   * @param repoPath - repository the worktree belongs to.
   * @param record - worktree to remove.
   * @param signal - caller-owned cancellation.
   * @returns true when git removed the worktree.
   */
  async remove(repoPath: string, record: WorktreeRecord, signal?: AbortSignal): Promise<boolean> {
    const removed = await this.git.run(repoPath, ['worktree', 'remove', '--force', record.path], signal)
    return removed.ok
  }
}

/**
 * Read the worktree records out of a porcelain listing.
 * @param stdout - output of `git worktree list --porcelain`.
 * @param baseDir - directory the records must lie below.
 * @returns one record per listed worktree below `baseDir`, in listing order.
 */
function parseWorktrees(stdout: string, baseDir: string): WorktreeRecord[] {
  const records: WorktreeRecord[] = []
  let path = ''
  let branch = ''
  for (const line of stdout.split('\n')) {
    if (line.startsWith(WORKTREE_HEADER)) {
      appendRecord(records, path, branch, baseDir)
      path = line.slice(WORKTREE_HEADER.length).trim()
      branch = ''
      continue
    }
    if (line.startsWith(BRANCH_HEADER)) branch = line.slice(BRANCH_HEADER.length).trim()
  }
  appendRecord(records, path, branch, baseDir)
  return records
}

/** Append one porcelain block when it describes a worktree below the base. */
function appendRecord(records: WorktreeRecord[], path: string, branch: string, baseDir: string): void {
  const record = recordFor(path, branch, baseDir)
  if (record !== undefined) records.push(record)
}

/** Build one record from a porcelain block, or undefined when it is not ours. */
function recordFor(path: string, branch: string, baseDir: string): WorktreeRecord | undefined {
  if (path === '') return undefined
  const relativePath = relative(baseDir, path)
  if (ESCAPES_BASE.test(relativePath)) return undefined
  const firstSeparator = relativePath.search(PATH_SEPARATOR)
  if (firstSeparator <= 0) return undefined
  const taskId = relativePath.slice(0, firstSeparator)
  const below = relativePath.slice(firstSeparator + 1)
  const secondSeparator = below.search(PATH_SEPARATOR)
  const subTaskId = secondSeparator === -1 ? below : below.slice(0, secondSeparator)
  return {
    taskId,
    subTaskId,
    path: resolve(path),
    branch: branch.startsWith(HEADS_PREFIX) ? branch.slice(HEADS_PREFIX.length) : branch,
  }
}

/**
 * Pending subtasks whose dependencies are all completed.
 * @param subTasks - plan subtasks.
 * @returns the ready subtasks in plan order.
 */
export function readySubTasks(subTasks: readonly SubTask[]): SubTask[] {
  const completed = new Set<string>()
  for (const subTask of subTasks) {
    if (subTask.status === 'completed') completed.add(subTask.id)
  }
  return subTasks.filter(subTask => subTask.status === 'pending'
    && subTask.dependsOn.every(dependency => completed.has(dependency)))
}

/**
 * The next batch to start: ready subtasks that are not active, capped by the
 * remaining concurrency.
 * @param subTasks - plan subtasks.
 * @param active - ids of subtasks already running.
 * @param maxConcurrency - greatest number of subtasks allowed to run at once.
 * @returns at most `maxConcurrency - active.length` subtasks, in plan order.
 */
export function nextBatch(subTasks: readonly SubTask[], active: readonly string[], maxConcurrency: number): SubTask[] {
  const running = new Set(active)
  const capacity = Math.max(0, maxConcurrency - active.length)
  return readySubTasks(subTasks).filter(subTask => !running.has(subTask.id)).slice(0, capacity)
}

/**
 * Merge order for completed subtasks: dependencies before dependents.
 * @param subTasks - plan subtasks.
 * @returns every subtask id once, dependencies first and ties in plan order.
 * @throws Error when `dependsOn` edges form a cycle.
 */
export function integrationOrder(subTasks: readonly SubTask[]): string[] {
  const known = new Set(subTasks.map(subTask => subTask.id))
  const ordered: string[] = []
  const emitted = new Set<string>()
  while (ordered.length < subTasks.length) {
    const next = subTasks.find(subTask => !emitted.has(subTask.id)
      && subTask.dependsOn.every(dependency => !known.has(dependency) || emitted.has(dependency)))
    if (next === undefined) break
    emitted.add(next.id)
    ordered.push(next.id)
  }
  if (ordered.length < subTasks.length) {
    const stuck = subTasks.filter(subTask => !emitted.has(subTask.id)).map(subTask => subTask.id)
    throw new Error(`subtask dependency cycle among: ${stuck.join(', ')}`)
  }
  return ordered
}
