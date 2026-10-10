/**
 * Append-only terminal output logs. The terminal service returns a bounded
 * viewport per settlement, so this log holds what the supervisor actually
 * observed, in order, on disk — the material a checkpoint points at when a
 * resumed run has to reconstruct context that no longer fits in memory.
 * @module @deepseek-ai/dsh-supervisor-core/spill
 */

import { appendFile, mkdir, open, stat, type FileHandle } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { sanitize } from './heartbeat.ts'

/** File permission bits for output logs. */
const SPILL_FILE_MODE = 0o600

/** Result of appending one settlement to a spill log. */
export interface SpillAppendResult {
  /** Absolute path of the log. */
  path: string
  /** Whether the text was written; false when the cap was already reached. */
  written: boolean
  /** Whether the log reached its byte cap and now discards further output. */
  capped: boolean
}

/**
 * Per-terminal output logs rooted at one directory, optionally scoped by task.
 */
export class SpillLog {
  constructor(
    private readonly root: string,
    private readonly enabled: boolean,
    private readonly maxBytes: number,
  ) {}

  /**
   * Path one terminal's log would use, without creating anything.
   * @param sessionId - terminal session id.
   * @param taskId - owning task, when the terminal was launched for one.
   * @returns the absolute log path.
   */
  pathFor(sessionId: string, taskId?: string): string {
    const scope = taskId === undefined || taskId === '' ? '_unbound' : sanitize(taskId)
    return join(this.root, scope, `${sanitize(sessionId)}.log`)
  }

  /**
   * Append one settlement's output.
   * @param sessionId - terminal session id.
   * @param taskId - owning task, when known.
   * @param text - output text to append.
   * @returns the log path and whether the write landed inside the cap.
   */
  async append(sessionId: string, taskId: string | undefined, text: string): Promise<SpillAppendResult> {
    const path = this.pathFor(sessionId, taskId)
    if (!this.enabled || text === '') return { path, written: false, capped: false }
    const size = await this.sizeOf(path)
    if (size >= this.maxBytes) return { path, written: false, capped: true }
    const chunk = `${new Date().toISOString()} ${text}\n`
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    await appendFile(path, chunk, { mode: SPILL_FILE_MODE })
    return { path, written: true, capped: size + Buffer.byteLength(chunk, 'utf8') >= this.maxBytes }
  }

  /**
   * Read a bounded tail of one log, for a checkpoint restore. The read is
   * bounded on disk: a log may hold up to `spillMaxBytes`, so the whole file is
   * never loaded to take its tail.
   * @param path - absolute log path.
   * @param maxBytes - maximum bytes to return.
   * @returns the tail text, or undefined when the log does not exist. A tail
   *   that starts inside a multi-byte character leads with one replacement char.
   * @throws the read error when the path exists but cannot be read.
   */
  async readTail(path: string, maxBytes: number): Promise<string | undefined> {
    let handle: FileHandle | undefined
    try {
      handle = await open(path, 'r')
      const info = await handle.stat()
      if (info.isDirectory()) {
        // Windows opens a directory fd and reports size 0; normalize to the
        // EISDIR a POSIX host produces so an unreadable path is a failure, not
        // an empty log.
        const error = new Error(`EISDIR: illegal operation on a directory, read '${path}'`) as NodeJS.ErrnoException
        error.code = 'EISDIR'
        throw error
      }
      if (info.size === 0) return ''
      const start = Math.max(0, info.size - maxBytes)
      const buffer = Buffer.alloc(Math.min(info.size, maxBytes))
      await handle.read(buffer, 0, buffer.length, start)
      return buffer.toString('utf8')
    } catch (error) {
      // A checkpoint may outlive its log once retention removed it; the caller
      // resumes without that context instead of failing the restore.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    } finally {
      await handle?.close()
    }
  }

  /** Current size of one log, or 0 when it does not exist. */
  private async sizeOf(path: string): Promise<number> {
    try {
      return (await stat(path)).size
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
      throw error
    }
  }
}
