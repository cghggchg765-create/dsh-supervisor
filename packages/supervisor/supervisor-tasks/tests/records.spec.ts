import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SupervisorCheckpoint } from '@deepseek-ai/dsh-supervisor-core'
import { CheckpointStore } from '../src/checkpoint.ts'

let root = ''

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-supervisor-tasks-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('checkpoints', () => {
  const retention = { maxPerTask: 2, maxAgeDays: 30 }

  it('writes a checkpoint that records the terminal and git facts it was given', async () => {
    const store = new CheckpointStore(join(root, 'checkpoints'), retention)
    const { checkpoint, path } = await store.create({
      taskId: 'task-a',
      stepIndex: 3,
      attempt: 2,
      supervisorSessionId: 'sess-1',
      terminalSessionId: 'pty-1',
      gitRef: { repoPath: root, branch: 'supervisor/task-a', commitHash: 'abc123', hasUncommitted: false },
      terminalState: { agentKind: 'claude-code', lastLaunchCommand: 'claude -p hello', state: 'running' },
    }, 10_000)
    expect(checkpoint.schemaVersion).toBe(1)
    expect(path).toContain('task-a')
    const read = await store.read('task-a')
    expect(read?.checkpointId).toBe(checkpoint.checkpointId)
    expect(read?.terminalState?.agentKind).toBe('claude-code')
    expect(read?.gitRef?.commitHash).toBe('abc123')
  })

  it('returns the newest checkpoint as the default and any checkpoint by id', async () => {
    const store = new CheckpointStore(join(root, 'checkpoints'), retention)
    const first = await store.create({ taskId: 'task-a', stepIndex: 0, attempt: 1, supervisorSessionId: 's' }, 1_000)
    const second = await store.create({ taskId: 'task-a', stepIndex: 1, attempt: 1, supervisorSessionId: 's' }, 2_000)
    expect((await store.read('task-a'))?.checkpointId).toBe(second.checkpoint.checkpointId)
    expect((await store.read('task-a', first.checkpoint.checkpointId))?.stepIndex).toBe(0)
  })

  it('keeps only the newest checkpoints per task', async () => {
    const store = new CheckpointStore(join(root, 'checkpoints'), retention)
    const created: SupervisorCheckpoint[] = []
    for (let index = 0; index < 4; index += 1) {
      created.push((await store.create({ taskId: 'task-a', stepIndex: index, attempt: 1, supervisorSessionId: 's' }, index * 1_000)).checkpoint)
    }
    const kept = await store.list('task-a')
    expect(kept).toHaveLength(2)
    expect(kept.map(entry => entry.stepIndex)).toEqual([2, 3])
    expect(await store.read('task-a', created[0]?.checkpointId ?? '')).toBeUndefined()
  })

  it('drops checkpoints past the age limit', async () => {
    const store = new CheckpointStore(join(root, 'checkpoints'), { maxPerTask: 10, maxAgeDays: 1 })
    await store.create({ taskId: 'task-a', stepIndex: 0, attempt: 1, supervisorSessionId: 's' }, 0)
    const now = 3 * 24 * 60 * 60 * 1000
    await store.create({ taskId: 'task-a', stepIndex: 1, attempt: 1, supervisorSessionId: 's' }, now)
    expect((await store.list('task-a')).map(entry => entry.stepIndex)).toEqual([1])
  })

  it('reports a task with no checkpoints as empty', async () => {
    const store = new CheckpointStore(join(root, 'checkpoints'), retention)
    expect(await store.list('task-none')).toEqual([])
    expect(await store.prune('task-none', Date.now())).toEqual([])
  })

  it('skips files that are not checkpoints', async () => {
    const directory = join(root, 'checkpoints')
    const store = new CheckpointStore(directory, retention)
    const { checkpoint } = await store.create({ taskId: 'task-a', stepIndex: 0, attempt: 1, supervisorSessionId: 's' }, 1_000)
    const taskDirectory = join(directory, 'task-a')
    await writeFile(join(taskDirectory, 'notes.txt'), 'not a checkpoint', 'utf8')
    await writeFile(join(taskDirectory, 'broken.json'), '{ not json', 'utf8')
    expect((await store.list('task-a')).map(entry => entry.checkpointId)).toEqual([checkpoint.checkpointId])
  })

  it('records the output spill path when spill was enabled', async () => {
    const store = new CheckpointStore(join(root, 'checkpoints'), retention)
    const spillPath = join(root, 'spill', 'task-a', 'pty-1.log')
    const { checkpoint } = await store.create({
      taskId: 'task-a',
      stepIndex: 1,
      attempt: 1,
      supervisorSessionId: 's',
      outputSpillPath: spillPath,
    }, 1_000)
    expect(checkpoint.outputSpillPath).toBe(spillPath)
    expect((await store.read('task-a'))?.outputSpillPath).toBe(spillPath)
  })

  it('surfaces an unreadable checkpoint file instead of reporting the task as empty', async () => {
    const directory = join(root, 'checkpoints')
    const store = new CheckpointStore(directory, retention)
    await store.create({ taskId: 'task-a', stepIndex: 0, attempt: 1, supervisorSessionId: 's' }, 1_000)
    await mkdir(join(directory, 'task-a', 'unreadable.json'), { recursive: true })
    await expect(store.list('task-a')).rejects.toThrow()
    await expect(store.read('task-a', 'unreadable')).rejects.toThrow()
  })

  it('surfaces a task directory that cannot be scanned', async () => {
    const directory = join(root, 'checkpoints')
    const store = new CheckpointStore(directory, retention)
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'task-a'), 'this is a file, not a directory', 'utf8')
    await expect(store.list('task-a')).rejects.toThrow()
    await expect(store.prune('task-a', Date.now())).rejects.toThrow()
  })
})
