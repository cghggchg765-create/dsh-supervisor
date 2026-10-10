#!/usr/bin/env node
/**
 * Test driver: boot the shutdown Loader composition through the real app boot
 * path, let the configured countdown reach the operator gate, and record the
 * assembled tool registry and the command's reported exit code in
 * `./supervisor-shutdown-loader-report.json` for the spec. The command itself
 * prints to stdout and powers nothing off.
 */

import { writeFile } from 'node:fs/promises'
import { boot, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'

const configPath = process.argv[2]
if (configPath === undefined) throw new Error('supervisor shutdown driver requires a config path')

const ctx = await boot('supervisor-shutdown-loader-smoke', resolveConfigPath(configPath, undefined))
try {
  // The plugin reports each command through the logger; the driver watches
  // those lines so no shell monkey-patching is needed.
  const reports: string[] = []
  const logger = ctx.logger
  const info = logger.info.bind(logger)
  logger.info = ((message: string) => {
    reports.push(message)
    info(message)
  }) as never

  const deadline = Date.now() + 30_000
  const commandReport = (): string | undefined => reports.find(line => line.includes('shutdown finished with exit code'))
  while (commandReport() === undefined && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 25))
  }

  const exitText = /exit code (none|\d+)/.exec(commandReport() ?? '')?.[1]
  await writeFile('./supervisor-shutdown-loader-report.json', JSON.stringify({
    tools: ctx.tools.schemas().map(schema => schema.name).sort(),
    command: /exit code \S+(?: \(timed out\))?: (.+)$/.exec(commandReport() ?? '')?.[1] ?? '',
    exitCode: exitText === undefined || exitText === 'none' ? null : Number(exitText),
  }))
} finally {
  await ctx.fiber.dispose()
}
