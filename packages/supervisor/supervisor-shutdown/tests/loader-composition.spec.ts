/**
 * REAL-composition tier (packages/AGENTS.md): boot a test-only `cordis.yml`
 * through the same app/boot path a deployment uses, let the configured
 * one-second countdown reach the operator gate, and assert the assembled tool
 * registry plus the exit code the shell seam reported. The operator command is
 * a print, so nothing asks the machine to power off.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'

/**
 * Every tool the composition assembles: the control plane's six, the task
 * services' four, the operations tools' four, and this package's one.
 */
const COMPOSED_TOOLS = [
  'supervisor_agent_launch',
  'supervisor_budget',
  'supervisor_checkpoint',
  'supervisor_issue',
  'supervisor_notify',
  'supervisor_plan',
  'supervisor_power',
  'supervisor_report',
  'supervisor_review',
  'supervisor_shutdown',
  'supervisor_status',
  'supervisor_terminal_read',
  'supervisor_terminal_run',
  'supervisor_terminal_send',
  'supervisor_terminal_signal',
].sort()

/** What the driver writes into the run directory for this spec to inspect. */
interface ShutdownLoaderReport {
  tools: string[]
  command: string
  exitCode: number | null
}

const driver = fileURLToPath(new URL('./fixtures/loader/driver.ts', import.meta.url))
const configPath = fileURLToPath(new URL('./fixtures/loader/cordis.yml', import.meta.url))
const repoTsconfig = fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url))

describe('automatic shutdown through a real Loader composition', () => {
  const processTimeoutMs = 90_000

  it('runs the operator command once the configured countdown elapses', async () => {
    let report: ShutdownLoaderReport | undefined
    const { stderr } = await runLoaderSmoke({
      label: 'supervisor shutdown loader smoke',
      tempDirPrefix: 'supervisor-shutdown-loader-',
      binScript: driver,
      libBinScript: driver,
      configPath,
      tsconfigPath: repoTsconfig,
      processTimeoutMs,
      inspect: async (cwd) => {
        report = JSON.parse(await readFile(join(cwd, 'supervisor-shutdown-loader-report.json'), 'utf8')) as ShutdownLoaderReport
      },
    })
    expect(stderr).not.toContain('UNHANDLED')
    expect(report).toBeDefined()

    // The assembled model-visible surface, including this component's one tool.
    expect(report?.tools).toEqual(COMPOSED_TOOLS)
    // The gate ran the operator's command and its exit code reached the report.
    expect(report?.command).toBe('echo fired')
    expect(report?.exitCode).toBe(0)
  }, processTimeoutMs + 15_000)
})
