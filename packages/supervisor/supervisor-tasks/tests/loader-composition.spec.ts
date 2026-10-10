/**
 * REAL-composition tier (packages/AGENTS.md): boot a test-only `cordis.yml`
 * through the same app/boot path a deployment uses, drive a plan write through
 * the assembled tool registry, and assert the model-visible surface plus the
 * durable plan the run directory holds.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'

/** Every tool the composition assembles, sorted; a new tool updates this list. */
const COMPOSED_TOOLS = [
  'supervisor_agent_launch',
  'supervisor_checkpoint',
  'supervisor_issue',
  'supervisor_plan',
  'supervisor_review',
  'supervisor_status',
  'supervisor_terminal_read',
  'supervisor_terminal_run',
  'supervisor_terminal_send',
  'supervisor_terminal_signal',
].sort()

/** The four tools the task-state plugin contributes to the composition. */
const TASKS_TOOLS = [
  'supervisor_checkpoint',
  'supervisor_issue',
  'supervisor_plan',
  'supervisor_review',
].sort()

/** What the driver writes into the run directory for this spec to inspect. */
interface TasksLoaderReport {
  tools: string[]
  planPath: string
  readyToStart: string[]
}

const driver = fileURLToPath(new URL('./fixtures/loader/driver.ts', import.meta.url))
const configPath = fileURLToPath(new URL('./fixtures/loader/cordis.yml', import.meta.url))
const repoTsconfig = fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url))

describe('supervisor tasks through a real Loader composition', () => {
  const processTimeoutMs = 90_000

  it('registers the ten composed tools and records the plan write under the state directory', async () => {
    let report: TasksLoaderReport | undefined
    let plan = ''
    const { stderr } = await runLoaderSmoke({
      label: 'supervisor-tasks loader smoke',
      tempDirPrefix: 'supervisor-tasks-loader-',
      binScript: driver,
      libBinScript: driver,
      configPath,
      tsconfigPath: repoTsconfig,
      processTimeoutMs,
      inspect: async (cwd) => {
        report = JSON.parse(await readFile(join(cwd, 'supervisor-tasks-loader-report.json'), 'utf8')) as TasksLoaderReport
        plan = await readFile(join(cwd, 'state', 'plans', 'loader-task.json'), 'utf8')
      },
    })
    expect(stderr).not.toContain('UNHANDLED')
    expect(report).toBeDefined()

    // The assembled model-visible surface: the control plane's six tools and
    // exactly the task-state plugin's four.
    expect(report?.tools).toEqual(COMPOSED_TOOLS)
    expect(report?.tools.filter(name => TASKS_TOOLS.includes(name))).toEqual(TASKS_TOOLS)

    // The durable plan the tool wrote under the control plane's state directory.
    expect(report?.planPath.endsWith(join('state', 'plans', 'loader-task.json'))).toBe(true)
    expect(report?.readyToStart).toEqual(['st-1'])
    expect(JSON.parse(plan)).toMatchObject({
      taskId: 'loader-task',
      goal: 'ship the loader plan',
      subTasks: [{ id: 'st-1', status: 'pending' }, { id: 'st-2', status: 'pending', dependsOn: ['st-1'] }],
    })
  }, processTimeoutMs + 15_000)
})
