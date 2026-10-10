import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PlanStore } from '../src/plan.ts'
import type { TaskPlan } from '../src/types.ts'

let root = ''

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-supervisor-'))
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

describe('task plans', () => {
  it('round-trips a plan and lists it by task', async () => {
    const store = new PlanStore(join(root, 'plans'))
    await store.write(plan('task-a'))
    const read = await store.read('task-a')
    expect(read?.goal).toBe('ship the feature')
    expect(read?.subTasks).toHaveLength(2)
    expect((await store.list()).map(entry => entry.taskId)).toEqual(['task-a'])
  })

  it('reports an unwritten plan as absent', async () => {
    const store = new PlanStore(join(root, 'plans'))
    expect(await store.read('task-missing')).toBeUndefined()
    expect(await store.list()).toEqual([])
  })

  it('replaces a plan in place on rewrite', async () => {
    const store = new PlanStore(join(root, 'plans'))
    const first = plan('task-a')
    await store.write(first)
    await store.write({ ...first, goal: 'ship it properly', updatedAt: 3 })
    const read = await store.read('task-a')
    expect(read?.goal).toBe('ship it properly')
    expect(read?.createdAt).toBe(1)
  })

  it('ignores files that are not plans', async () => {
    const directory = join(root, 'plans')
    const store = new PlanStore(directory)
    await store.write(plan('task-a'))
    await writeFile(join(directory, 'notes.txt'), 'not a plan', 'utf8')
    expect((await store.list()).map(entry => entry.taskId)).toEqual(['task-a'])
  })

  it('treats a malformed plan file as absent rather than failing a status query', async () => {
    const directory = join(root, 'plans')
    const store = new PlanStore(directory)
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'task-a.json'), '{ not json', 'utf8')
    expect(await store.read('task-a')).toBeUndefined()
    expect(await store.list()).toEqual([])
  })

  it('surfaces an unreadable plan file instead of reporting it as absent', async () => {
    const directory = join(root, 'plans')
    const store = new PlanStore(directory)
    await mkdir(join(directory, 'task-a.json'), { recursive: true })
    await expect(store.read('task-a')).rejects.toThrow()
    await expect(store.list()).rejects.toThrow()
  })

  it('sanitizes the task id into one path segment', async () => {
    const store = new PlanStore(join(root, 'plans'))
    const written = await store.write(plan('../../escape'))
    // The traversal segments stay inside the plans directory as plain text.
    expect(dirname(written)).toBe(join(root, 'plans'))
    expect(basename(written)).not.toContain('/')
    expect(basename(written)).not.toContain('\\')
    expect((await store.read('../../escape'))?.taskId).toBe('../../escape')
  })

  it('surfaces a plans directory that cannot be scanned', async () => {
    const directory = join(root, 'plans')
    await writeFile(directory, 'this is a file, not a directory', 'utf8')
    const store = new PlanStore(directory)
    await expect(store.list()).rejects.toThrow()
  })
})
