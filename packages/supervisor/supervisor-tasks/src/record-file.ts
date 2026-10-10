/**
 * Shared file layout and JSON reading for the durable record stores. Every
 * store keeps one directory per task (or one file per record) under the state
 * directory and reads its files as self-describing JSON, so the layout helpers
 * and the missing-or-malformed reading rule live here once.
 * @module @deepseek-ai/dsh-supervisor-tasks/record-file
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { sanitize } from '@deepseek-ai/dsh-supervisor-core'

/**
 * Read one JSON record file, treating a missing or malformed file as absent.
 * @param path - absolute file path.
 * @returns the parsed record, or undefined when the file is missing or is not JSON.
 * @throws the read error when the file exists but cannot be read.
 */
export async function readRecordFile<T>(path: string): Promise<T | undefined> {
  try {
    const text = await readFile(path, 'utf8')
    return JSON.parse(text) as T
  } catch (error) {
    // A missing file is the ordinary "no record yet" answer and a malformed one
    // is reported the same way, because both mean "nothing to resume from"; an
    // unreadable existing file is a real failure and propagates.
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || error instanceof SyntaxError) return undefined
    throw error
  }
}

/**
 * Directory holding one task's records.
 * @param root - directory the task directories live under.
 * @param taskId - task id to make path-safe.
 * @returns the absolute task directory.
 */
export function taskDirectory(root: string, taskId: string): string {
  return join(root, sanitize(taskId))
}

/**
 * Absolute path of one record file.
 * @param root - directory the task directories live under.
 * @param taskId - task the record belongs to.
 * @param recordId - record identity to make path-safe.
 * @returns the absolute record path.
 */
export function recordFile(root: string, taskId: string, recordId: string): string {
  return join(taskDirectory(root, taskId), `${sanitize(recordId)}.json`)
}
