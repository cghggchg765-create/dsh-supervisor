/**
 * Bundle contract: the plugin manager renders one card per bundle and one
 * component per patch row, and each component inherits the display metadata of
 * the package that row names. These assertions are what keeps the bundle
 * installable (`dsh.bundle.patch`), keeps every row resolvable from this
 * package's production dependencies, and keeps the six components visibly
 * distinct instead of repeating the bundle's own name and description.
 */

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { load } from 'js-yaml'

/** One component row of the bundle under test, in patch order. */
interface ComponentRow {
  /** Row id a profile patch targets. */
  readonly id: string
  /** Package the row mounts. */
  readonly name: string
}

/** The component rows the bundle declares, in the order the patch inserts them. */
const COMPONENT_ROWS: readonly ComponentRow[] = [
  { id: 'supervisor', name: '@deepseek-ai/dsh-supervisor-core' },
  { id: 'supervisor-tasks', name: '@deepseek-ai/dsh-supervisor-tasks' },
  { id: 'supervisor-orchestration', name: '@deepseek-ai/dsh-supervisor-orchestration' },
  { id: 'supervisor-ops', name: '@deepseek-ai/dsh-supervisor-ops' },
  { id: 'supervisor-pacing', name: '@deepseek-ai/dsh-supervisor-pacing' },
  { id: 'supervisor-shutdown', name: '@deepseek-ai/dsh-supervisor-shutdown' },
]

/** The bundle's own directory. */
const bundleDir = fileURLToPath(new URL('..', import.meta.url))

/** Read and parse one JSON file, failing loudly on anything unexpected. */
function readJson(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
}

/** Read one package's `locale/<language>.json` title and description. */
function localeText(packageDir: string, language: string): { title: string; description: string } {
  const parsed = readJson(join(packageDir, 'locale', `${language}.json`)) as {
    meta?: { title?: string; description?: string }
  }
  const title = parsed.meta?.title
  const description = parsed.meta?.description
  if (typeof title !== 'string' || typeof description !== 'string') {
    throw new Error(`${packageDir}/locale/${language}.json must declare meta.title and meta.description`)
  }
  return { title, description }
}

describe('the supervisor bundle', () => {
  const manifest = readJson(join(bundleDir, 'package.json')) as {
    name?: string
    version?: string
    description?: string
    dependencies?: Record<string, string>
    files?: string[]
    dsh?: { bundle?: { patch?: string | string[] } }
  }

  it('declares a bundle patch, because the plugin manager installs nothing else', () => {
    // A path install without `dsh.bundle.patch` is refused as `not-a-bundle`,
    // and the patch file itself must ship in `files` or the installed package
    // cannot be loaded at all.
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    expect(manifest.files).toContain('cordis.patch.yml')
    expect(manifest.files).toContain('icon.svg')
    expect(manifest.files).toContain('locale/*.json')
  })

  it('inserts one row per component, in the declared order, and depends on every one of them', () => {
    const patch = load(readFileSync(join(bundleDir, 'cordis.patch.yml'), 'utf8'))
    expect(patch).toEqual([{ insert: COMPONENT_ROWS }])
    for (const row of COMPONENT_ROWS) {
      // `verify-cordis-config` enforces the same rule repository-wide: a row can
      // only be resolved from a production dependency of the bundle.
      expect(manifest.dependencies?.[row.name]).toBe('workspace:*')
    }
  })

  it('ships six distinct components, each with its own icon and localized title', () => {
    const bundleTitle = localeText(bundleDir, 'en').title
    const bundleDescription = localeText(bundleDir, 'en').description
    const titles = new Set<string>()
    const descriptions = new Set<string>()
    for (const row of COMPONENT_ROWS) {
      const packageDir = join(bundleDir, '..', row.name.replace('@deepseek-ai/dsh-', ''))
      expect(existsSync(join(packageDir, 'package.json'))).toBe(true)
      const component = readJson(join(packageDir, 'package.json')) as { name?: string; version?: string; icon?: string }
      expect(component.name).toBe(row.name)
      expect(component.version).toBe(manifest.version)
      expect(component.icon).toBe('./icon.svg')
      expect(existsSync(join(packageDir, 'icon.svg'))).toBe(true)

      for (const language of ['en', 'zh']) {
        const text = localeText(packageDir, language)
        expect(text.title.length).toBeGreaterThan(0)
        expect(text.description.length).toBeGreaterThan(text.title.length)
      }
      const english = localeText(packageDir, 'en')
      // The component list must not repeat the bundle's own text: a component
      // row inherits the metadata of the package it names, so identical text
      // would render as one lumped-together entry again.
      expect(english.title).not.toBe(bundleTitle)
      expect(english.description).not.toBe(bundleDescription)
      titles.add(english.title)
      descriptions.add(english.description)
    }
    expect(titles.size).toBe(COMPONENT_ROWS.length)
    expect(descriptions.size).toBe(COMPONENT_ROWS.length)
  })

  it('mounts no plugin of its own, so the bundle card never duplicates a component', () => {
    const entry = readFileSync(join(bundleDir, 'src', 'index.ts'), 'utf8')
    // A bundle that also registered its own plugin would appear as one more,
    // identically named component beside the six it inserts.
    expect(entry).toContain('export {}')
    expect(entry).not.toContain('export function apply')
  })
})
