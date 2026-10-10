/**
 * Package-contract test: the delivered manifest, icon, locale dictionaries, and
 * entry-point invariant. A change to any of them is a delivery change, not a
 * refactor, so it fails here first.
 */

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const packageDir = fileURLToPath(new URL('..', import.meta.url))

/** The delivered manifest, parsed from the package directory. */
function manifest(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as Record<string, unknown>
}

/** One locale dictionary, parsed from the package's locale directory. */
function dictionary(name: string): { meta?: { title?: string; description?: string } } {
  return JSON.parse(readFileSync(join(packageDir, 'locale', name), 'utf8')) as {
    meta?: { title?: string; description?: string }
  }
}

describe('package contract', () => {
  it('keeps the published name, version, and ESM entry point', () => {
    const value = manifest()
    expect(value.name).toBe('@deepseek-ai/dsh-supervisor-core')
    expect(value.version).toBe('0.1.7-rc.1')
    expect(value.type).toBe('module')
    expect(value.main).toBe('lib/index.js')
    expect(value.types).toBe('lib/types/index.d.ts')
    expect(value.exports).toMatchObject({
      '.': { types: './lib/types/index.d.ts', default: './lib/index.js' },
    })
  })

  it('ships exactly the icon, locale dictionaries, and built entry point', () => {
    const value = manifest()
    expect(value.files).toEqual([
      'icon.svg',
      'locale/*.json',
      'lib/index.js',
      'lib/types/**/*.d.ts',
    ])
    expect(value.icon).toBe('./icon.svg')
    expect(existsSync(join(packageDir, 'icon.svg'))).toBe(true)
  })

  it('describes itself in both shipped locales', () => {
    for (const name of ['en.json', 'zh.json']) {
      const meta = dictionary(name).meta
      expect(meta?.title).toBeTruthy()
      expect(meta?.description).toBeTruthy()
    }
  })

  it('mirrors every peer dependency in devDependencies at the same range', () => {
    const value = manifest()
    const peers = value.peerDependencies as Record<string, string>
    const dev = value.devDependencies as Record<string, string>
    for (const [name, range] of Object.entries(peers)) {
      expect(dev[name], `${name} is a peer but not a devDependency`).toBe(range)
    }
    // The harness's own plugin runtime is a peer and a dev dependency at once.
    expect(peers['@deepseek-ai/cordis']).toBe('workspace:~')
  })
})
