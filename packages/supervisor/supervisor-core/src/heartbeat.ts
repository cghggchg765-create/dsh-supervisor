/**
 * Heartbeat records for supervised terminals. A heartbeat is the last time a
 * terminal produced output; the watchdog compares its age against the configured
 * timeout to raise `heartbeat-stale`. Records are written one file per terminal
 * so an external watcher can observe progress without loading this plugin.
 * @module @deepseek-ai/dsh-supervisor-core/heartbeat
 */

import { readFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { Heartbeat } from './types.ts'

/** File permission bits for heartbeat records. */
const HEARTBEAT_FILE_MODE = 0o600

/**
 * Durable heartbeat store rooted at one directory.
 */
export class HeartbeatStore {
  constructor(
    private readonly directory: string,
    private readonly timeoutSec: number,
  ) {}

  /**
   * Record observed output for a terminal.
   * @param sessionId - terminal session the output came from.
   * @param waitReason - wait reason of the settlement that produced the output.
   * @param now - epoch milliseconds of the observation.
   * @returns the stored record.
   */
  async touch(sessionId: string, waitReason: string, now: number): Promise<Heartbeat> {
    const previous = await this.read(sessionId)
    const record: Heartbeat = {
      sessionId,
      lastOutputAt: now,
      lastWaitReason: waitReason,
      consecutiveStaleChecks: 0,
    }
    if (previous) record.lastOutputAt = Math.max(previous.lastOutputAt, now)
    await this.write(record)
    return record
  }

  /**
   * Read one terminal's heartbeat.
   * @param sessionId - terminal session to read.
   * @returns the stored record, or undefined when the terminal has none.
   */
  async read(sessionId: string): Promise<Heartbeat | undefined> {
    try {
      const text = await readFile(this.fileFor(sessionId), 'utf8')
      return JSON.parse(text) as Heartbeat
    } catch (error) {
      // A missing record is the normal first-observation path; anything else
      // (unreadable file, malformed JSON) is reported as absent rather than
      // failing the tool call that merely wanted a liveness hint.
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || error instanceof SyntaxError) return undefined
      throw error
    }
  }

  /**
   * Record one watchdog pass's verdict for this terminal.
   * @param record - the record read by the watchdog.
   * @param stale - whether this pass found the heartbeat stale.
   * @returns the updated record.
   */
  async recordCheck(record: Heartbeat, stale: boolean): Promise<Heartbeat> {
    const updated: Heartbeat = {
      ...record,
      consecutiveStaleChecks: stale ? record.consecutiveStaleChecks + 1 : 0,
    }
    await this.write(updated)
    return updated
  }

  /**
   * List every stored heartbeat.
   * @returns records in directory order; malformed files are skipped.
   */
  async list(): Promise<Heartbeat[]> {
    let names: string[]
    try {
      names = await readdir(this.directory)
    } catch (error) {
      // No directory yet means nothing has been supervised.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const records: Heartbeat[] = []
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const record = await this.read(name.slice(0, -'.json'.length))
      if (record) records.push(record)
    }
    return records
  }

  /**
   * Drop a terminal's heartbeat, e.g. after the terminal was closed.
   * @param sessionId - terminal session to forget.
   */
  async remove(sessionId: string): Promise<void> {
    await rm(this.fileFor(sessionId), { force: true })
  }

  /**
   * Whether a record is older than the configured timeout.
   * @param record - heartbeat record to test.
   * @param now - epoch milliseconds to measure against.
   * @returns true when the record exceeded the timeout.
   */
  isStale(record: Heartbeat, now: number): boolean {
    return now - record.lastOutputAt >= this.timeoutSec * 1000
  }

  /** Absolute path of one terminal's heartbeat file. */
  private fileFor(sessionId: string): string {
    return join(this.directory, `${sanitize(sessionId)}.json`)
  }

  /** Atomically replace one terminal's heartbeat file. */
  private async write(record: Heartbeat): Promise<void> {
    await writeFileAtomic(
      this.fileFor(record.sessionId),
      `${JSON.stringify(record, null, 2)}\n`,
      { mode: HEARTBEAT_FILE_MODE, dirMode: 0o700 },
    )
  }
}

/**
 * Make one session id safe as a path segment.
 * @param value - terminal session id or task id.
 * @returns the id with path separators and traversal segments replaced.
 */
export function sanitize(value: string): string {
  return value.replaceAll(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_').slice(0, 120)
}
