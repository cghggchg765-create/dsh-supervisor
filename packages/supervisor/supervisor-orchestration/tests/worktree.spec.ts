import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GitRunner } from '@deepseek-ai/dsh-supervisor-tasks'
import type { SubTask, SubTaskStatus } from '@deepseek-ai/dsh-supervisor-core'
import { integrationOrder, nextBatch, readySubTasks, WorktreeManager } from '../src/worktree.ts'

/** Git operations the worktree manager runs, exactly as the task service supplies them. */
const git = new GitRunner()

let repo = ''
let base = ''
let outside = ''

/** Whether a usable git executable is on PATH for this environment. */
async function gitAvailable(): Promise<boolean> {
  const probe = await git.run(process.cwd(), ['--version'])
  return probe.ok
}

const hasGit = await gitAvailable()

/** Initialize the repository with one commit, so worktrees have a base ref. */
async function initRepo(): Promise<void> {
  await git.run(repo, ['init'])
  await writeFile(join(repo, 'base.txt'), 'base\n', 'utf8')
  await git.commitAll(repo, 'base', 'base')
}

/** One plan subtask with the given id, dependencies, and status. */
function subTask(id: string, dependsOn: readonly string[] = [], status: SubTaskStatus = 'pending'): SubTask {
  return {
    id,
    title: id,
    description: `do ${id}`,
    dependsOn: [...dependsOn],
    requiredSkills: [],
    estimatedEffort: 'small',
    acceptanceCriteria: [],
    status,
  }
}

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'dsh-supervisor-worktree-repo-'))
  base = await mkdtemp(join(tmpdir(), 'dsh-supervisor-worktree-base-'))
  outside = await mkdtemp(join(tmpdir(), 'dsh-supervisor-worktree-outside-'))
})

afterEach(async () => {
  await rm(repo, { recursive: true, force: true })
  await rm(base, { recursive: true, force: true })
  await rm(outside, { recursive: true, force: true })
})

describe('worktree paths', () => {
  it('builds one sanitized path per subtask without touching the repository', () => {
    const manager = new WorktreeManager(git, base, 'supervisor/')
    expect(manager.pathFor('task-1', 'sub-1')).toBe(join(base, 'task-1', 'sub-1'))
    expect(manager.pathFor('task 1', '../sub/2')).toBe(join(base, 'task_1', '__sub_2'))
  })
})

describe('worktree lifecycle', () => {
  it.skipIf(!hasGit)('creates, lists, and removes one subtask worktree', async () => {
    await initRepo()
    const manager = new WorktreeManager(git, base, 'supervisor/')

    const created = await manager.create(repo, 'task-1', 'sub-1', 'HEAD')
    expect(created).toEqual({
      taskId: 'task-1',
      subTaskId: 'sub-1',
      path: join(base, 'task-1', 'sub-1'),
      branch: 'supervisor/task-1/sub-1',
    })
    expect(existsSync(join(base, 'task-1', 'sub-1', 'base.txt'))).toBe(true)
    expect(await manager.list(repo)).toEqual([created])

    expect(await manager.remove(repo, created!)).toBe(true)
    expect(existsSync(join(base, 'task-1', 'sub-1'))).toBe(false)
    expect(await manager.list(repo)).toEqual([])
    expect(await manager.remove(repo, created!)).toBe(false)
  })

  it.skipIf(!hasGit)('sanitizes ids in the worktree path and branch', async () => {
    await initRepo()
    const manager = new WorktreeManager(git, base, 'supervisor/')

    const created = await manager.create(repo, 'task/1', 'sub 1', 'HEAD')
    expect(created?.taskId).toBe('task_1')
    expect(created?.subTaskId).toBe('sub_1')
    expect(created?.path).toBe(join(base, 'task_1', 'sub_1'))
    expect(created?.branch).toBe('supervisor/task_1/sub_1')
  })

  it.skipIf(!hasGit)('reports a refused add as no worktree', async () => {
    await initRepo()
    const manager = new WorktreeManager(git, base, 'supervisor/')

    expect(await manager.create(repo, 'task-1', 'sub-1', 'HEAD')).toBeDefined()
    expect(await manager.create(repo, 'task-1', 'sub-1', 'HEAD')).toBeUndefined()
    expect(await manager.create(repo, 'task-2', 'sub-2', 'no-such-ref')).toBeUndefined()
  })

  it.skipIf(!hasGit)('lists only the worktrees below its base directory', async () => {
    await initRepo()
    const manager = new WorktreeManager(git, base, 'supervisor/')
    await git.run(repo, ['worktree', 'add', join(outside, 'elsewhere'), '-b', 'elsewhere', 'HEAD'])
    await git.run(repo, ['worktree', 'add', join(base, 'task-3', 'sub-3', 'deep'), '-b', 'team/task-3', 'HEAD'])
    await git.run(repo, ['worktree', 'add', '--detach', join(base, 'task-4', 'sub-4'), 'HEAD'])
    await git.run(repo, ['worktree', 'add', join(base, 'task-only'), '-b', 'flat', 'HEAD'])

    const records = await manager.list(repo)
    expect(records).toHaveLength(2)
    expect(records).toContainEqual({
      taskId: 'task-3',
      subTaskId: 'sub-3',
      path: join(base, 'task-3', 'sub-3', 'deep'),
      branch: 'team/task-3',
    })
    expect(records).toContainEqual({
      taskId: 'task-4',
      subTaskId: 'sub-4',
      path: join(base, 'task-4', 'sub-4'),
      branch: '',
    })
  })

  it.skipIf(!hasGit)('lists nothing outside a repository', async () => {
    const manager = new WorktreeManager(git, base, 'supervisor/')
    expect(await manager.list(repo)).toEqual([])
  })
})

describe('subtask scheduling', () => {
  it('reports pending subtasks whose dependencies are all completed', () => {
    const plan = [
      subTask('a', [], 'completed'),
      subTask('b', ['a']),
      subTask('c', ['a']),
      subTask('d', ['b']),
      subTask('e', [], 'in-progress'),
      subTask('f', ['ghost']),
      subTask('g', [], 'failed'),
      subTask('h', [], 'skipped'),
    ]
    expect(readySubTasks(plan).map(subTask => subTask.id)).toEqual(['b', 'c'])
  })

  it('fills the remaining concurrency with ready subtasks that are not active', () => {
    const plan = [subTask('a'), subTask('b'), subTask('c')]
    expect(nextBatch(plan, [], 2).map(subTask => subTask.id)).toEqual(['a', 'b'])
    expect(nextBatch(plan, ['a'], 2).map(subTask => subTask.id)).toEqual(['b'])
    expect(nextBatch(plan, ['c', 'b'], 3).map(subTask => subTask.id)).toEqual(['a'])
    expect(nextBatch(plan, ['a', 'b'], 2)).toEqual([])
    expect(nextBatch(plan, ['a', 'b', 'c'], 0)).toEqual([])
  })

  it('orders dependencies before dependents, ties in plan order', () => {
    const plan = [subTask('c', ['b']), subTask('b', ['a']), subTask('a'), subTask('d', ['c'])]
    expect(integrationOrder(plan)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('keeps the plan order of independent subtasks', () => {
    expect(integrationOrder([subTask('y'), subTask('x'), subTask('z')])).toEqual(['y', 'x', 'z'])
  })

  it('emits a subtask whose dependency is not in the plan', () => {
    expect(integrationOrder([subTask('x', ['ghost'])])).toEqual(['x'])
  })

  it('orders an empty plan as nothing', () => {
    expect(integrationOrder([])).toEqual([])
  })

  it('throws with the cycle members when dependencies are cyclic', () => {
    const plan = [subTask('a', ['b']), subTask('b', ['c']), subTask('c', ['a']), subTask('d')]
    expect(() => integrationOrder(plan)).toThrow(Error)
    expect(() => integrationOrder(plan)).toThrow(/cycle/)
    expect(() => integrationOrder(plan)).toThrow(/a, b, c/)
  })
})
