#!/usr/bin/env node
/**
 * Run the integration check: mount this repository's payload into a DeepSeek
 * Harness checkout at the matching tag, install, and run the payload's tests.
 * The steps mirror .github/workflows/integration.yml; that workflow remains the
 * executable contract and this script is the local equivalent.
 *
 * Usage:
 *   node scripts/integration.mjs [--harness <dir>] [--skip-install]
 *
 * The harness checkout defaults to `.harness-integration` in this repository
 * (git-ignored). An existing checkout is reused as-is; only a missing one is
 * cloned. Set `HARNESS_TAG` to integrate against a different tag.
 */

import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const HARNESS_REPO = 'https://github.com/deepseek-ai/deepseek-harness.git'
const HARNESS_TAG = process.env.HARNESS_TAG ?? 'dsh-v0.1.7-rc.1'
const PAYLOAD = join(REPO_ROOT, 'packages', 'supervisor')

/** Run one command from a working directory, failing the script on a non-zero exit. */
function run(command, args, cwd) {
  console.log(`\n$ ${command} ${args.join(' ')}  (cwd: ${cwd})`)
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' })
  if (result.error) throw result.error
  if (result.status !== 0) {
    console.error(`command failed with exit code ${String(result.status)}: ${command} ${args.join(' ')}`)
    process.exit(result.status ?? 1)
  }
}

/** Parse the two flags this script accepts. */
function parseArgs(argv) {
  const options = { harness: join(REPO_ROOT, '.harness-integration'), skipInstall: false }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--harness') {
      const value = argv[i + 1]
      if (value === undefined) throw new Error('--harness needs a directory')
      options.harness = resolve(value)
      i += 1
    } else if (argv[i] === '--skip-install') {
      options.skipInstall = true
    } else {
      throw new Error(`unknown argument "${argv[i]}"; expected --harness <dir> or --skip-install`)
    }
  }
  return options
}

/** Clone the harness at the pinned tag, reusing an existing checkout untouched. */
function ensureHarness(harness) {
  if (existsSync(join(harness, 'package.json'))) {
    console.log(`reusing harness checkout at ${harness}`)
    return
  }
  if (existsSync(harness)) rmSync(harness, { recursive: true, force: true })
  mkdirSync(dirname(harness), { recursive: true })
  run('git', ['clone', '--depth', '1', '--branch', HARNESS_TAG, HARNESS_REPO, harness], REPO_ROOT)
}

/** Copy every package under packages/supervisor/ into the harness workspace. */
function copyPayload(harness) {
  const target = join(harness, 'packages', 'supervisor')
  mkdirSync(target, { recursive: true })
  for (const entry of readdirSync(PAYLOAD)) {
    const source = join(PAYLOAD, entry)
    if (!statSync(source).isDirectory()) continue
    cpSync(source, join(target, entry), {
      recursive: true,
      filter: path => !/(^|[/\\])(node_modules|lib|\.mimosa|\.tmp)([/\\]|$)/.test(path),
    })
    console.log(`copied packages/supervisor/${entry}`)
  }
}

/**
 * Register the payload in the harness TypeScript project. The harness resolves
 * workspace packages to src/ through tsconfig paths and builds them through its
 * project references, and the payload carries no built lib/, so this is what
 * makes `vitest` and the loader-composition subprocesses resolve
 * `@deepseek-ai/dsh-supervisor-*` from a clean checkout.
 */
function applyRegistration(harness) {
  const patch = join(REPO_ROOT, 'integration', 'harness-tsconfig.patch')
  const already = spawnSync('git', ['apply', '--reverse', '--check', patch], { cwd: harness, stdio: 'ignore' })
  if (already.status === 0) {
    console.log('harness tsconfig registration already applied')
    return
  }
  run('git', ['apply', patch], harness)
}

try {
  const options = parseArgs(process.argv.slice(2))
  ensureHarness(options.harness)
  copyPayload(options.harness)
  applyRegistration(options.harness)
  if (!options.skipInstall) run('pnpm', ['install'], options.harness)
  run('pnpm', ['exec', 'vitest', 'run', 'packages/supervisor'], options.harness)
  run('pnpm', ['run', 'constraints'], options.harness)
  console.log('\nintegration check passed')
} catch (error) {
  console.error(`integration: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
