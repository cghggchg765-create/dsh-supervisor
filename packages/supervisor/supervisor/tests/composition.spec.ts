/**
 * REAL-composition tier (packages/AGENTS.md): boot the bundle's component rows
 * through the same app/boot path a deployment uses, drive one tool call per
 * tool-registering component through the assembled registry, and read the
 * session projection automatic pacing registers. The fixture mounts all six
 * rows `cordis.patch.yml` inserts, so this is the test that proves the shipped
 * patch resolves as one working control plane — nineteen tools from the five
 * tool-registering components, a live pacing projection, and the durable
 * records in the run directory — rather than six plugins that happen to load.
 */

import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'

/** Every tool the components of this composition contribute together, sorted. */
const SUPERVISOR_TOOLS = [
  'supervisor_agent_launch',
  'supervisor_agent_switch',
  'supervisor_budget',
  'supervisor_checkpoint',
  'supervisor_dispatch',
  'supervisor_issue',
  'supervisor_notify',
  'supervisor_plan',
  'supervisor_power',
  'supervisor_report',
  'supervisor_review',
  'supervisor_shutdown',
  'supervisor_skills',
  'supervisor_status',
  'supervisor_terminal_read',
  'supervisor_terminal_run',
  'supervisor_terminal_send',
  'supervisor_terminal_signal',
  'supervisor_worktree',
].sort()

/** What the driver writes into the run directory for this spec to inspect. */
interface SupervisorLoaderReport {
  tools: string[]
  sessionId: string
  waitReason: string
  stateMarks: string[]
  l1RuleIds: string[]
  spillPath: string
  planPath: string
  skillsScanned: boolean
  budgetTaskUSD: number
  /** Outcome the pacing projection reports, or `missing` when pacing never registered it. */
  pacingOutcome: string
}

const driver = fileURLToPath(new URL('./fixtures/loader/driver.ts', import.meta.url))
const configPath = fileURLToPath(new URL('./fixtures/loader/cordis.yml', import.meta.url))
const repoTsconfig = fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url))

describe('the supervisor bundle through a real Loader composition', () => {
  const processTimeoutMs = 90_000

  it('mounts all six fixture rows as one control plane over nineteen tools and a pacing projection', async () => {
    let report: SupervisorLoaderReport | undefined
    let spill = ''
    let plan = ''
    const { stderr } = await runLoaderSmoke({
      label: 'supervisor loader smoke',
      tempDirPrefix: 'supervisor-loader-',
      binScript: driver,
      libBinScript: driver,
      configPath,
      tsconfigPath: repoTsconfig,
      processTimeoutMs,
      inspect: async (cwd) => {
        report = JSON.parse(await readFile(join(cwd, 'supervisor-loader-report.json'), 'utf8')) as SupervisorLoaderReport
        spill = await readFile(resolve(cwd, report.spillPath), 'utf8')
        plan = await readFile(resolve(cwd, report.planPath), 'utf8')
      },
    })
    expect(stderr).not.toContain('UNHANDLED')
    expect(report).toBeDefined()

    // The assembled model-visible surface: every component registered its tools.
    expect(report?.tools).toEqual(SUPERVISOR_TOOLS)

    // The core drove the settlement and the task component persisted its plan.
    expect(report?.waitReason).toBe('stdin_read')
    expect(report?.stateMarks).toContain('prompt-idle')
    expect(report?.l1RuleIds).toContain('rate-limit')
    expect(report?.skillsScanned).toBe(true)
    expect(report?.budgetTaskUSD).toBe(0)

    // Automatic pacing registers no tool: it proves it is mounted by owning the
    // `pacing` session projection, whose empty-log state is `none`.
    expect(report?.pacingOutcome).toBe('none')

    // The durable records an interrupted run resumes from.
    expect(spill).toContain('HTTP 429 Too Many Requests')
    expect(JSON.parse(plan)).toMatchObject({ taskId: 'loader-task', goal: 'prove the assembled surface' })
  }, processTimeoutMs + 15_000)
})
