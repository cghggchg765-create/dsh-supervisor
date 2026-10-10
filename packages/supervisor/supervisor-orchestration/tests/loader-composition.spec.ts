/**
 * REAL-composition tier (packages/AGENTS.md): boot a test-only `cordis.yml`
 * through the same app/boot path a deployment uses, drive a skill scan, a model
 * switch, and a dispatch through the assembled tool registry, and assert the
 * model-visible surface plus the durable inventory the run directory holds.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'

/** The four tools this package contributes, in catalog order. */
const ORCHESTRATION_TOOLS = [
  'supervisor_agent_switch',
  'supervisor_dispatch',
  'supervisor_skills',
  'supervisor_worktree',
]

/**
 * Every tool the composition assembles: the control plane's six, the task
 * services' four, and this package's four. A new tool updates this list.
 */
const COMPOSED_TOOLS = [
  'supervisor_agent_launch',
  'supervisor_agent_switch',
  'supervisor_checkpoint',
  'supervisor_dispatch',
  'supervisor_issue',
  'supervisor_plan',
  'supervisor_review',
  'supervisor_skills',
  'supervisor_status',
  'supervisor_terminal_read',
  'supervisor_terminal_run',
  'supervisor_terminal_send',
  'supervisor_terminal_signal',
  'supervisor_worktree',
].sort()

/** What the driver writes into the run directory for this spec to inspect. */
interface OrchestrationLoaderReport {
  tools: string[]
  sessionId: string
  skills: { agentKind: string; skills: string[] }[]
  switched: boolean
  model?: string
  batch: string[]
}

const driver = fileURLToPath(new URL('./fixtures/loader/driver.ts', import.meta.url))
const configPath = fileURLToPath(new URL('./fixtures/loader/cordis.yml', import.meta.url))
const repoTsconfig = fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url))

describe('supervisor orchestration through a real Loader composition', () => {
  const processTimeoutMs = 90_000

  it('registers its four tools on top of the composed set and records a scan, a switch, and a dispatch', async () => {
    let report: OrchestrationLoaderReport | undefined
    let inventory = ''
    const { stderr } = await runLoaderSmoke({
      label: 'supervisor orchestration loader smoke',
      tempDirPrefix: 'supervisor-orchestration-loader-',
      binScript: driver,
      libBinScript: driver,
      configPath,
      tsconfigPath: repoTsconfig,
      processTimeoutMs,
      inspect: async (cwd) => {
        report = JSON.parse(await readFile(join(cwd, 'orchestration-loader-report.json'), 'utf8')) as OrchestrationLoaderReport
        inventory = await readFile(join(cwd, 'state', 'skills', 'claude-code.json'), 'utf8')
      },
    })
    expect(stderr).not.toContain('UNHANDLED')
    expect(report).toBeDefined()

    // The assembled model-visible surface: exactly four orchestration tools.
    expect(report?.tools).toEqual(COMPOSED_TOOLS)
    expect(report?.tools.filter(name => ORCHESTRATION_TOOLS.includes(name))).toEqual(ORCHESTRATION_TOOLS)

    // The durable inventory a scan wrote under the state directory.
    expect(JSON.parse(inventory)).toMatchObject({
      agentKind: 'claude-code',
      skills: ['react-component'],
      available: true,
    })
    expect(report?.skills).toMatchObject([{ agentKind: 'claude-code', skills: ['react-component'] }])

    // The switch went through the hosted CLI's own in-session command.
    expect(report?.switched).toBe(true)
    expect(report?.model).toBe('/model sonnet')

    // Dispatch read the plan the driver stored through the control plane.
    expect(report?.batch).toEqual(['st-1'])
  }, processTimeoutMs + 15_000)
})
