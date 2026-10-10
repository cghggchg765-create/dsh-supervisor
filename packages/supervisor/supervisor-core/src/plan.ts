/**
 * Task plan storage. The supervising model authors the decomposition; this
 * store only persists it, so a resumed run and the delivery report both read
 * the same plan instead of reconstructing it from conversation.
 * @module @deepseek-ai/dsh-supervisor-core/plan
 */

import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { sanitize } from './heartbeat.ts'
import type { TaskPlan } from './types.ts'

/** File permission bits for plan records. */
const PLAN_FILE_MODE = 0o600

/**
 * One JSON file per task plan under a plans directory.
 */
export class PlanStore {
  constructor(private readonly directory: string) {}

  /**
   * Persist a plan, replacing any previous version.
   * @param plan - the complete plan to store.
   * @returns the path written.
   */
  async write(plan: TaskPlan): Promise<string> {
    const path = this.fileFor(plan.taskId)
    await writeFileAtomic(path, `${JSON.stringify(plan, null, 2)}\n`, {
      mode: PLAN_FILE_MODE,
      dirMode: 0o700,
    })
    return path
  }

  /**
   * Read one task plan.
   * @param taskId - task whose plan to read.
   * @returns the stored plan, or undefined when none exists.
   */
  async read(taskId: string): Promise<TaskPlan | undefined> {
    try {
      const text = await readFile(this.fileFor(taskId), 'utf8')
      return JSON.parse(text) as TaskPlan
    } catch (error) {
      // A missing plan is the ordinary "not planned yet" answer; a malformed
      // file is reported the same way rather than failing a status query.
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || error instanceof SyntaxError) return undefined
      throw error
    }
  }

  /**
   * List every stored plan.
   * @returns plans in directory order; unreadable files are skipped.
   */
  async list(): Promise<TaskPlan[]> {
    let names: string[]
    try {
      names = await readdir(this.directory)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const plans: TaskPlan[] = []
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const plan = await this.read(name.slice(0, -'.json'.length))
      if (plan) plans.push(plan)
    }
    return plans
  }

  /** Absolute path of one task's plan file. */
  private fileFor(taskId: string): string {
    return join(this.directory, `${sanitize(taskId)}.json`)
  }
}
