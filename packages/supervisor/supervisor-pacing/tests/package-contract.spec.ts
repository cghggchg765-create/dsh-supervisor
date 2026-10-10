/**
 * Package contract: the manifest invariants, publication files, and display
 * metadata the bundle's fifth component row renders.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/** This package's directory. */
const packageDir = fileURLToPath(new URL('..', import.meta.url))

/** The manifest under test. */
const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as {
  name?: string
  version?: string
  type?: string
  main?: string
  types?: string
  icon?: string
  exports?: Record<string, unknown>
  files?: string[]
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

describe('the supervisor-pacing package', () => {
  it('declares the entry points and publication files a dsh package needs', () => {
    expect(manifest.name).toBe('@deepseek-ai/dsh-supervisor-pacing')
    expect(manifest.type).toBe('module')
    expect(manifest.main).toBe('lib/index.js')
    expect(manifest.types).toBe('lib/types/index.d.ts')
    expect(manifest.exports).toMatchObject({
      '.': { types: './lib/types/index.d.ts', default: './lib/index.js' },
    })
    expect(manifest.files).toEqual(['icon.svg', 'locale/*.json', 'lib/index.js', 'lib/types/**/*.d.ts'])
  })

  it('ships the display metadata its component row renders', () => {
    expect(manifest.icon).toBe('./icon.svg')
    expect(existsSync(join(packageDir, 'icon.svg'))).toBe(true)
    for (const language of ['en', 'zh']) {
      const locale = JSON.parse(readFileSync(join(packageDir, 'locale', `${language}.json`), 'utf8')) as {
        meta?: { title?: string; description?: string }
      }
      expect(locale.meta?.title).toBeTruthy()
      expect(locale.meta?.description?.length ?? 0).toBeGreaterThan(locale.meta?.title?.length ?? 0)
    }
  })

  it('mirrors every peer dependency in devDependencies', () => {
    const peers = Object.keys(manifest.peerDependencies ?? {})
    expect(peers.length).toBeGreaterThan(0)
    for (const peer of peers) {
      expect(manifest.devDependencies?.[peer]).toBe(manifest.peerDependencies?.[peer])
    }
    expect(manifest.dependencies?.['@deepseek-ai/schemastery']).toBe('workspace:~')
  })
})
