/**
 * REAL-composition tier (packages/AGENTS.md): boot a test-only `cordis.yml`
 * through the same app/boot path a deployment uses, let a scripted model
 * adapter fail one request with a rate limit, and assert that automatic pacing
 * resumed the run with the pinned model-visible notice.
 */

import { readFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'

/** What the driver writes into the run directory for this spec to inspect. */
interface PacingLoaderReport {
  notice: string
  notices: number
  requests: number
  messages: string
}

const driver = fileURLToPath(new URL('./fixtures/loader/driver.ts', import.meta.url))
const configPath = fileURLToPath(new URL('./fixtures/loader/cordis.yml', import.meta.url))
const repoTsconfig = fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url))

/**
 * Render one expected notice, substituting `{name}` placeholders.
 * @param name - file name under `tests/expected`.
 * @param values - placeholder values keyed by name.
 * @returns the exact text the run must produce.
 */
function expectedOutput(name: string, values: Record<string, string | number>): string {
  const template = readFileSync(fileURLToPath(new URL(`./expected/${name}`, import.meta.url)), 'utf8')
  return template.trimEnd().replaceAll(/\{(\w+)\}/g, (_match, key: string) => {
    const value = values[key]
    if (value === undefined) throw new Error(`expected/${name} names unknown placeholder ${key}`)
    return String(value)
  })
}

describe('automatic pacing through a real Loader composition', () => {
  const processTimeoutMs = 90_000

  it('resumes the agent after a rate limit and tells it what happened', async () => {
    let report: PacingLoaderReport | undefined
    const { stderr } = await runLoaderSmoke({
      label: 'supervisor pacing loader smoke',
      tempDirPrefix: 'supervisor-pacing-loader-',
      binScript: driver,
      libBinScript: driver,
      configPath,
      tsconfigPath: repoTsconfig,
      processTimeoutMs,
      inspect: async (cwd) => {
        report = JSON.parse(await readFile(join(cwd, 'supervisor-pacing-loader-report.json'), 'utf8')) as PacingLoaderReport
      },
    })
    expect(stderr).not.toContain('UNHANDLED')
    expect(report).toBeDefined()

    // The pinned model-visible notice, delivered exactly once.
    expect(report?.notice).toBe(expectedOutput('pacing-resume-notice.txt', { resume: 1, max: 3 }))
    expect(report?.notices).toBe(2)
    // The resumed turn ran, and the model saw the notice in its request.
    expect(report?.requests).toBe(2)
    expect(report?.messages).toContain('[pacing] the previous turn failed.')
  }, processTimeoutMs + 15_000)
})
