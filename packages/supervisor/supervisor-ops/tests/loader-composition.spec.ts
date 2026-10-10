/**
 * REAL-composition tier (packages/AGENTS.md): boot a test-only `cordis.yml`
 * through the same app/boot path a deployment uses, drive the four operations
 * tools through the assembled registry, and assert the model-visible surface,
 * the chat transport seam, and the durable report the run directory holds.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'

/** Terminal tools the control plane contributes when the composition boots. */
const CORE_TOOLS = [
  'supervisor_agent_launch',
  'supervisor_status',
  'supervisor_terminal_read',
  'supervisor_terminal_run',
  'supervisor_terminal_send',
  'supervisor_terminal_signal',
].sort()

/** Task-state tools the planning component contributes beside the control plane. */
const TASKS_TOOLS = [
  'supervisor_checkpoint',
  'supervisor_issue',
  'supervisor_plan',
  'supervisor_review',
].sort()

/** Tools this package contributes, sorted; a new tool updates this list. */
const OPS_TOOLS = [
  'supervisor_budget',
  'supervisor_notify',
  'supervisor_report',
  'supervisor_shutdown',
].sort()

/** What the driver writes into the run directory for this spec to inspect. */
interface OpsLoaderReport {
  tools: string[]
  budgetTokens: number
  budgetEntries: number
  notifyBeforeTransport: boolean
  notifyAfterTransport: boolean
  chatSent: string[]
  shutdownAllowed: boolean
  steered: string[]
  reportPath: string
  chatForgotten: boolean
}

const driver = fileURLToPath(new URL('./fixtures/loader/driver.ts', import.meta.url))
const configPath = fileURLToPath(new URL('./fixtures/loader/cordis.yml', import.meta.url))
const repoTsconfig = fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url))

describe('supervisor-ops through a real Loader composition', () => {
  const processTimeoutMs = 90_000

  it('registers exactly its four tools on top of the assembled set and steers a chat message to the owner', async () => {
    let report: OpsLoaderReport | undefined
    let written = ''
    const { stderr } = await runLoaderSmoke({
      label: 'supervisor-ops loader smoke',
      tempDirPrefix: 'supervisor-ops-loader-',
      binScript: driver,
      libBinScript: driver,
      configPath,
      tsconfigPath: repoTsconfig,
      processTimeoutMs,
      inspect: async (cwd) => {
        report = JSON.parse(await readFile(join(cwd, 'supervisor-ops-loader-report.json'), 'utf8')) as OpsLoaderReport
        written = await readFile(join(cwd, 'state', 'deliverables', 'loader-task', 'report.md'), 'utf8')
      },
    })
    expect(stderr).not.toContain('UNHANDLED')
    expect(report).toBeDefined()

    // The assembled supervisor surface is the core set, the task-state set, and
    // exactly this package's four tools.
    expect(report?.tools).toEqual([...CORE_TOOLS, ...TASKS_TOOLS, ...OPS_TOOLS].sort())

    // The budget ledger and the chat transport seam, both driven through tools.
    expect(report).toMatchObject({
      budgetTokens: 1500,
      budgetEntries: 1,
      notifyBeforeTransport: false,
      notifyAfterTransport: true,
      chatSent: ['[supervisor] task-completed: loader-task'],
      shutdownAllowed: false,
      chatForgotten: true,
    })

    // The default routing: a plain message reaches the terminal's owner.
    expect(report?.steered).toEqual(['[chat] u-9: 进度？'])

    // The durable deliverable the report tool wrote under the state directory.
    expect(written).toContain('# 任务交付报告：Ops loader')
    expect(report?.reportPath.endsWith(join('state', 'deliverables', 'loader-task', 'report.md'))).toBe(true)
  }, processTimeoutMs + 15_000)
})
