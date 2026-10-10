import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentKind } from '@deepseek-ai/dsh-supervisor-core'
import { SkillStore, matchAgents, renderSkillBrief, scanSkills, type SkillInventory } from '../src/skills.ts'

let root = ''
let home = ''
let workspace = ''

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-supervisor-skills-'))
  home = join(root, 'home')
  workspace = join(root, 'workspace')
  await mkdir(home, { recursive: true })
  await mkdir(workspace, { recursive: true })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** Create a directory, and its parents, under the fixture root. */
async function makeDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true })
}

/** Write a file, creating its parent directory. */
async function makeFile(path: string, text = ''): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text, 'utf8')
}

describe('skill scanning', () => {
  it('scans both claude-code roots and reports directory and Markdown skills', async () => {
    await makeDirectory(join(home, '.claude', 'skills', 'react-component'))
    await makeFile(join(home, '.claude', 'skills', 'test-writer.md'), '# test writer')
    await makeFile(join(home, '.claude', 'skills', 'notes.txt'), 'not a skill')
    await makeDirectory(join(workspace, '.claude', 'skills', 'deploy'))

    const inventory = await scanSkills('claude-code', { homeDir: home, workspaceDir: workspace }, 1_000)

    expect(inventory).toEqual({
      agentKind: 'claude-code',
      skills: ['deploy', 'react-component', 'test-writer'],
      sources: [join(home, '.claude', 'skills'), join(workspace, '.claude', 'skills')],
      available: true,
      scannedAt: 1_000,
    })
  })

  it('scans the workspace root of codex when its home root is absent', async () => {
    await makeDirectory(join(workspace, '.codex', 'skills', 'code-review'))

    const inventory = await scanSkills('codex', { homeDir: home, workspaceDir: workspace }, 2_000)

    expect(inventory.skills).toEqual(['code-review'])
    expect(inventory.sources).toEqual([join(workspace, '.codex', 'skills')])
    expect(inventory.available).toBe(true)
  })

  it('scans the home-only skills root of the remaining hosted CLIs', async () => {
    const cases = [['kimi-code', 'moonshot'], ['qwen-code', 'qwen'], ['trae', 'trae-skill']] as const
    for (const [kind, skill] of cases) {
      await makeDirectory(join(home, `.${kind}`, 'skills', skill))
      const inventory = await scanSkills(kind, { homeDir: home, workspaceDir: workspace }, 3_000)
      expect(inventory.skills).toEqual([skill])
      expect(inventory.sources).toEqual([join(home, `.${kind}`, 'skills')])
    }
  })

  it('scans dsh skill directories and the manifest skill packages', async () => {
    await makeDirectory(join(workspace, '.agents', 'skills', 'repair'))
    await makeFile(join(workspace, '.agents', 'skills', 'stray.md'), '# not a skill directory')
    await makeFile(join(workspace, 'cordis.yml'), [
      'plugins:',
      '  "@deepseek-ai/dsh-skill-office": {}',
      '  "@deepseek-ai/dsh-skill-report-writer@1.0.0": {}',
      '  "@deepseek-ai/dsh-supervisor": {}',
    ].join('\n'))

    const inventory = await scanSkills('dsh', { homeDir: home, workspaceDir: workspace }, 4_000)

    expect(inventory).toEqual({
      agentKind: 'dsh',
      skills: ['office', 'repair', 'report-writer'],
      sources: [join(workspace, '.agents', 'skills'), join(workspace, 'cordis.yml')],
      available: true,
      scannedAt: 4_000,
    })
  })

  it('scans a dsh manifest that declares no skill package', async () => {
    await makeFile(join(workspace, 'cordis.yml'), 'plugins:\n  "@deepseek-ai/dsh-supervisor": {}\n')

    const inventory = await scanSkills('dsh', { homeDir: home, workspaceDir: workspace }, 9_000)

    expect(inventory).toEqual({
      agentKind: 'dsh',
      skills: [],
      sources: [join(workspace, 'cordis.yml')],
      available: true,
      scannedAt: 9_000,
    })
  })

  it('scans dsh directories when the manifest is absent', async () => {
    await makeDirectory(join(workspace, '.agents', 'skills', 'repair'))

    const inventory = await scanSkills('dsh', { homeDir: home, workspaceDir: workspace }, 5_000)

    expect(inventory.skills).toEqual(['repair'])
    expect(inventory.sources).toEqual([join(workspace, '.agents', 'skills')])
  })

  it('reports an agent with no readable root as unavailable', async () => {
    const inventory = await scanSkills('claude-code', {
      homeDir: join(root, 'absent-home'),
      workspaceDir: join(root, 'absent-workspace'),
    }, 6_000)

    expect(inventory).toEqual({
      agentKind: 'claude-code',
      skills: [],
      sources: [],
      available: false,
      scannedAt: 6_000,
    })
  })

  it('skips a root whose path is occupied by a file', async () => {
    await makeFile(join(workspace, '.claude'), 'not a directory')

    const inventory = await scanSkills('claude-code', {
      homeDir: join(root, 'absent-home'),
      workspaceDir: workspace,
    }, 7_000)

    expect(inventory.available).toBe(false)
    expect(inventory.sources).toEqual([])
  })

  it('surfaces an unexpected filesystem failure instead of reporting no skills', async () => {
    // A NUL byte in the path is not a root the scan can answer for, so the
    // failure propagates rather than reading as "this agent has no skills".
    const homeDir = join(root, 'nul\u0000home')

    await expect(scanSkills('claude-code', { homeDir, workspaceDir: workspace }, 8_000)).rejects.toThrow()
  })
})

describe('skill inventory store', () => {
  /** An inventory with one skill, for the store round trips. */
  function inventory(kind: AgentKind, skills: string[] = ['react']): SkillInventory {
    return { agentKind: kind, skills, sources: [], available: true, scannedAt: 7 }
  }

  it('writes and reads one inventory file per agent kind', async () => {
    const store = new SkillStore(join(root, 'skills'))

    const path = await store.write(inventory('claude-code'))

    expect(path.endsWith('claude-code.json')).toBe(true)
    expect((await store.read('claude-code'))?.skills).toEqual(['react'])
  })

  it('lists inventories by agent kind and skips other files', async () => {
    const directory = join(root, 'skills')
    const store = new SkillStore(directory)
    await store.write(inventory('trae'))
    await store.write(inventory('codex'))
    await writeFile(join(directory, 'notes.txt'), 'not an inventory', 'utf8')
    await writeFile(join(directory, 'other.json'), '{}', 'utf8')

    expect((await store.list()).map(entry => entry.agentKind)).toEqual(['codex', 'trae'])
  })

  it('reports an unscanned agent as absent', async () => {
    const store = new SkillStore(join(root, 'skills'))

    expect(await store.read('dsh')).toBeUndefined()
    expect(await store.list()).toEqual([])
  })

  it('treats a malformed inventory file as absent', async () => {
    const directory = join(root, 'skills')
    const store = new SkillStore(directory)
    await makeFile(join(directory, 'dsh.json'), '{ not json')

    expect(await store.read('dsh')).toBeUndefined()
    expect(await store.list()).toEqual([])
  })

  it('surfaces an inventory file that cannot be read', async () => {
    const directory = join(root, 'skills')
    const store = new SkillStore(directory)
    await makeDirectory(join(directory, 'dsh.json'))

    await expect(store.read('dsh')).rejects.toThrow()
    await expect(store.list()).rejects.toThrow()
  })

  it('surfaces a skills directory that cannot be scanned', async () => {
    const directory = join(root, 'skills')
    await makeFile(directory, 'this is a file, not a directory')
    const store = new SkillStore(directory)

    await expect(store.list()).rejects.toThrow()
  })
})

describe('skill brief', () => {
  it('renders one line per required skill', () => {
    expect(renderSkillBrief(['react-component', 'test-writer']))
      .toBe('请使用以下技能完成：\n- react-component\n- test-writer')
  })

  it('renders nothing when no skill is required', () => {
    expect(renderSkillBrief([])).toBe('')
  })
})

describe('agent matching', () => {
  /** An inventory with the given skills. */
  function inventory(kind: AgentKind, skills: string[], scannedAt = 0): SkillInventory {
    return { agentKind: kind, skills, sources: [], available: true, scannedAt }
  }

  it('keeps the required order and reports what an agent lacks', () => {
    const rows = matchAgents(['react', 'testing', 'deploy'], [inventory('claude-code', ['deploy', 'react'])])

    expect(rows).toEqual([{ agentKind: 'claude-code', matched: ['react', 'deploy'], missing: ['testing'] }])
  })

  it('ranks agents by matched skills and then by agent kind', () => {
    const rows = matchAgents(['react', 'testing'], [
      inventory('trae', []),
      inventory('codex', ['react']),
      inventory('claude-code', ['react', 'testing']),
      inventory('dsh', ['react']),
    ])

    expect(rows.map(row => row.agentKind)).toEqual(['claude-code', 'codex', 'dsh', 'trae'])
  })

  it('keeps the input order of two inventories of the same agent kind', () => {
    const first = inventory('codex', ['react'])
    const second = inventory('codex', ['vue'])

    const rows = matchAgents(['react', 'vue'], [second, first])

    expect(rows.map(row => row.matched)).toEqual([['vue'], ['react']])
  })

  it('orders two equally matched agents by agent kind', () => {
    const rows = matchAgents([], [inventory('trae', []), inventory('codex', [])])

    expect(rows.map(row => row.agentKind)).toEqual(['codex', 'trae'])
  })

  it('reports every requirement as missing when nothing matches', () => {
    expect(matchAgents(['react'], [inventory('codex', ['testing'])]))
      .toEqual([{ agentKind: 'codex', matched: [], missing: ['react'] }])
  })

  it('matches no skill against an empty requirement list', () => {
    expect(matchAgents([], [inventory('codex', ['testing'])]))
      .toEqual([{ agentKind: 'codex', matched: [], missing: [] }])
  })
})
