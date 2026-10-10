/**
 * Checkpoint storage and retention. A checkpoint is the durable record a
 * resumed run starts from: the git commit, the terminal it was driving, and the
 * output log that carried the context. Files are self-describing JSON so a
 * restore can be performed by hand when the plugin is not loaded.
 * @module @deepseek-ai/dsh-supervisor-tasks/checkpoint
 */

import { randomBytes } from 'node:crypto'
import { readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { SupervisorCheckpoint } from '@deepseek-ai/dsh-supervisor-core'
import { recordFile, readRecordFile, taskDirectory } from './record-file.ts'

/** Current checkpoint record version. */
export const CHECKPOINT_SCHEMA_VERSION = 1

/** File permission bits for checkpoint records. */
const CHECKPOINT_FILE_MODE = 0o600

/** Retention policy applied after every write. */
export interface CheckpointRetention {
  /** Maximum checkpoints kept per task; the oldest are removed first. */
  maxPerTask: number
  /** Maximum age in days; older checkpoints are removed. */
  maxAgeDays: number
}

/** What a checkpoint write needs beyond the record itself. */
export interface CheckpointDraft {
  /** Task this checkpoint belongs to. */
  taskId: string
  /** Plan step index the checkpoint was taken at. */
  stepIndex: number
  /** 1-based attempt number of that step. */
  attempt: number
  /** Supervisor agent session id. */
  supervisorSessionId: string
  /** Terminal the checkpoint refers to, when one was supervised. */
  terminalSessionId?: string
  /** Git facts, when the working directory is a repository. */
  gitRef?: SupervisorCheckpoint['gitRef']
  /** Output log path, when spill was enabled. */
  outputSpillPath?: string
  /** Terminal facts needed to relaunch. */
  terminalState?: SupervisorCheckpoint['terminalState']
}

/**
 * One directory of checkpoints per task, newest kept per the retention policy.
 */
export class CheckpointStore {
  constructor(
    private readonly directory: string,
    private readonly retention: CheckpointRetention,
  ) {}

  /**
   * Write a checkpoint and apply retention.
   * @param draft - checkpoint contents.
   * @param now - epoch milliseconds of the write.
   * @returns the stored record and its file path.
   */
  async create(draft: CheckpointDraft, now: number): Promise<{ checkpoint: SupervisorCheckpoint; path: string }> {
    const checkpoint: SupervisorCheckpoint = {
      schemaVersion: CHECKPOINT_SCHEMA_VERSION,
      checkpointId: `cp-${now.toString(36)}-${randomBytes(3).toString('hex')}`,
      taskId: draft.taskId,
      stepIndex: draft.stepIndex,
      timestamp: now,
      attempt: draft.attempt,
      supervisorSessionId: draft.supervisorSessionId,
      ...draft.gitRef === undefined ? {} : { gitRef: draft.gitRef },
      ...draft.terminalSessionId === undefined ? {} : { terminalSessionId: draft.terminalSessionId },
      ...draft.outputSpillPath === undefined ? {} : { outputSpillPath: draft.outputSpillPath },
      ...draft.terminalState === undefined ? {} : { terminalState: draft.terminalState },
    }
    const path = this.fileFor(checkpoint.taskId, checkpoint.checkpointId)
    await writeFileAtomic(path, `${JSON.stringify(checkpoint, null, 2)}\n`, {
      mode: CHECKPOINT_FILE_MODE,
      dirMode: 0o700,
    })
    await this.prune(checkpoint.taskId, now)
    return { checkpoint, path }
  }

  /**
   * Read one checkpoint, or the newest for a task.
   * @param taskId - task whose checkpoint to read.
   * @param checkpointId - specific checkpoint; omitted selects the newest.
   * @returns the record, or undefined when the task has no matching checkpoint.
   */
  async read(taskId: string, checkpointId?: string): Promise<SupervisorCheckpoint | undefined> {
    if (checkpointId !== undefined) {
      return await this.readFile(this.fileFor(taskId, checkpointId))
    }
    const all = await this.list(taskId)
    return all.at(-1)
  }

  /**
   * List a task's checkpoints.
   * @param taskId - task whose checkpoints to list.
   * @returns records ordered oldest first; unreadable files are skipped.
   */
  async list(taskId: string): Promise<SupervisorCheckpoint[]> {
    let names: string[]
    try {
      names = await readdir(this.taskDirectory(taskId))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const records: SupervisorCheckpoint[] = []
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const record = await this.readFile(join(this.taskDirectory(taskId), name))
      if (record) records.push(record)
    }
    return records.sort((left, right) => left.timestamp - right.timestamp)
  }

  /**
   * Apply the retention policy to one task's checkpoints.
   * @param taskId - task to prune.
   * @param now - epoch milliseconds of the pass.
   * @returns the checkpoint ids removed.
   */
  async prune(taskId: string, now: number): Promise<string[]> {
    const records = await this.list(taskId)
    const maxAgeMs = this.retention.maxAgeDays * 24 * 60 * 60 * 1000
    const expired = records.filter(record => now - record.timestamp > maxAgeMs)
    const survivors = records.filter(record => !expired.includes(record))
    const excess = survivors.length > this.retention.maxPerTask
      ? survivors.slice(0, survivors.length - this.retention.maxPerTask)
      : []
    const removed = [...expired, ...excess]
    for (const record of removed) {
      await rm(this.fileFor(taskId, record.checkpointId), { force: true })
    }
    return removed.map(record => record.checkpointId)
  }

  /** Read one checkpoint file, treating a missing or malformed file as absent. */
  private readFile(path: string): Promise<SupervisorCheckpoint | undefined> {
    return readRecordFile<SupervisorCheckpoint>(path)
  }

  /** Directory holding one task's checkpoints. */
  private taskDirectory(taskId: string): string {
    return taskDirectory(this.directory, taskId)
  }

  /** Absolute path of one checkpoint file. */
  private fileFor(taskId: string, checkpointId: string): string {
    return recordFile(this.directory, taskId, checkpointId)
  }
}
