/**
 * REAL-composition tier (packages/AGENTS.md): boot a test-only `cordis.yml`
 * through the same app/boot path a deployment uses, drive one settlement
 * through the assembled tool registry, and assert the model-visible surface
 * plus the durable records the run directory holds.
 */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'

/** Every tool the control-plane core contributes, sorted; a new tool updates this list. */
const CORE_TOOLS = [
  'supervisor_agent_launch',
  'supervisor_status',
  'supervisor_terminal_read',
  'supervisor_terminal_run',
  'supervisor_terminal_send',
  'supervisor_terminal_signal',
].sort()

/** What the driver writes into the run directory for this spec to inspect. */
interface CoreLoaderReport {
  tools: string[]
  sessionId: string
  waitReason: string
  stateMarks: string[]
  l1RuleIds: string[]
  spillLogged: boolean
  spillPath: string
}

const driver = fileURLToPath(new URL('./fixtures/loader/driver.ts', import.meta.url))
const configPath = fileURLToPath(new URL('./fixtures/loader/cordis.yml', import.meta.url))
const repoTsconfig = fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url))

describe('supervisor core through a real Loader composition', () => {
  const processTimeoutMs = 90_000

  it('registers the six core tools and records the settlement under the state directory', async () => {
    let report: CoreLoaderReport | undefined
    let spill = ''
    const { stderr } = await runLoaderSmoke({
      label: 'supervisor-core loader smoke',
      tempDirPrefix: 'supervisor-core-loader-',
      binScript: driver,
      libBinScript: driver,
      configPath,
      tsconfigPath: repoTsconfig,
      processTimeoutMs,
      inspect: async (cwd) => {
        report = JSON.parse(await readFile(`${cwd}/supervisor-core-loader-report.json`, 'utf8')) as CoreLoaderReport
        spill = await readFile(`${cwd}/state/spill/_unbound/${report.sessionId}.log`, 'utf8')
      },
    })
    expect(stderr).not.toContain('UNHANDLED')
    expect(report).toBeDefined()

    // The assembled model-visible surface.
    expect(report?.tools).toEqual(CORE_TOOLS)
    expect(report?.waitReason).toBe('stdin_read')
    expect(report?.stateMarks).toContain('prompt-idle')
    expect(report?.l1RuleIds).toContain('rate-limit')

    // The durable record an interrupted run resumes from.
    expect(report?.spillLogged).toBe(true)
    expect(spill).toContain('HTTP 429 Too Many Requests')
  }, processTimeoutMs + 15_000)
})
