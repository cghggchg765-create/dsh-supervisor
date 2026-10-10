/**
 * Skill discovery and matching for hosted CLI agents. Each agent keeps its own
 * skills configuration, so the supervisor reads that agent's own roots rather
 * than assuming one shared layout. Discovery rules per kind:
 *
 * - `claude-code`: `<home>/.claude/skills` and `<workspace>/.claude/skills`;
 *   a subdirectory name or a `.md` file's basename is one skill name.
 * - `codex`: `<home>/.codex/skills` and `<workspace>/.codex/skills`, same shape.
 * - `kimi-code`, `qwen-code`, `trae`: `<home>/.<kind>/skills`, same shape.
 * - `dsh`: subdirectories of `<workspace>/.agents/skills`, plus the skill
 *   package names declared by `<workspace>/cordis.yml` as
 *   `@deepseek-ai/dsh-skill-<name>`, reported without the `dsh-skill-` prefix.
 *
 * A skill that is not a package specifier of that scope is not discovered: the
 * scan reports what the agent itself would load, not what any skill directory
 * happens to contain. A missing root and an unreadable one are both skipped, so
 * the inventory reports the roots it could read in `sources` and answers
 * `available: false` when none could be read; a launch that asked for skills is
 * never failed by one agent's absent configuration directory.
 * @module @deepseek-ai/dsh-supervisor-orchestration/skills
 */

import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { AGENT_KINDS, type AgentKind } from '@deepseek-ai/dsh-supervisor-core'

/** Where a skill scan looks for one agent's skills. */
export interface SkillScanRoots {
  /** Operator home directory, e.g. `~/.claude/skills`. */
  homeDir: string
  /** Supervised workspace, e.g. `<workspace>/.claude/skills`. */
  workspaceDir: string
}

/** Skills discovered for one hosted agent kind. */
export interface SkillInventory {
  /** Hosted agent kind the scan covered. */
  agentKind: AgentKind
  /** Skill names, sorted and de-duplicated. */
  skills: string[]
  /** Directories and files that contributed, for evidence. */
  sources: string[]
  /** Whether the agent's configuration root existed at all. */
  available: boolean
  /** Epoch milliseconds of the scan. */
  scannedAt: number
}

/** File permission bits for inventory files. */
const INVENTORY_FILE_MODE = 0o600

/** Inventory file name suffix. */
const INVENTORY_SUFFIX = '.json'

/** Markdown skill file name suffix. */
const MARKDOWN_SUFFIX = '.md'

/** Scope and name prefix of a dsh skill package; the skill name follows it. */
const SKILL_PACKAGE_PREFIX = '@deepseek-ai/dsh-skill-'

/** Matches one dsh skill package specifier in a cordis.yml manifest. */
const SKILL_PACKAGE_PATTERN = /@deepseek-ai\/dsh-skill-[A-Za-z0-9._-]+/g

/** Agent kind names, so a file name read back from disk is not trusted as one. */
const AGENT_KIND_NAMES: ReadonlySet<string> = new Set<string>(AGENT_KINDS)

/**
 * Filesystem failures that mean a root is absent or unusable rather than the
 * scan being wrong: the root is missing (`ENOENT`), a file occupies its path
 * (`ENOTDIR`), it is not readable (`EACCES`, `EPERM`, `ELOOP`), or a directory
 * occupies the path a manifest file was expected at (`EISDIR`).
 */
const SKIPPABLE_ROOT_ERRORS: ReadonlySet<string | undefined> = new Set<string | undefined>([
  'ENOENT',
  'ENOTDIR',
  'EACCES',
  'EPERM',
  'ELOOP',
  'EISDIR',
])

/**
 * Scan one agent's skill roots. Never throws for a missing root.
 * @param kind - hosted agent kind whose roots to scan.
 * @param roots - home and workspace directories the kind's roots resolve under.
 * @param now - epoch milliseconds of the scan, recorded on the inventory.
 * @returns the skills that agent would load, with the roots that supplied them.
 */
export async function scanSkills(kind: AgentKind, roots: SkillScanRoots, now: number): Promise<SkillInventory> {
  const discovered: string[] = []
  const sources: string[] = []
  for (const directory of skillDirectories(kind, roots)) {
    // Every kind but `dsh` counts a Markdown file directly under the root as a
    // skill; dsh keeps one directory per skill and its manifest supplies the
    // package-backed names instead.
    const names = await listSkills(directory, kind !== 'dsh')
    if (names === undefined) continue
    sources.push(directory)
    discovered.push(...names)
  }
  if (kind === 'dsh') {
    const manifest = join(roots.workspaceDir, 'cordis.yml')
    const text = await readRoot(() => readFile(manifest, 'utf8'))
    if (text !== undefined) {
      sources.push(manifest)
      discovered.push(...skillPackageNames(text))
    }
  }
  return {
    agentKind: kind,
    skills: [...new Set(discovered)].sort(),
    sources,
    available: sources.length > 0,
    scannedAt: now,
  }
}

/**
 * One JSON file per agent kind under a skills directory.
 */
export class SkillStore {
  constructor(private readonly directory: string) {}

  /**
   * Persist one agent kind's inventory, replacing any previous scan.
   * @param inventory - the inventory to store.
   * @returns the path written.
   */
  async write(inventory: SkillInventory): Promise<string> {
    const path = this.fileFor(inventory.agentKind)
    await writeFileAtomic(path, `${JSON.stringify(inventory, null, 2)}\n`, {
      mode: INVENTORY_FILE_MODE,
      dirMode: 0o700,
    })
    return path
  }

  /**
   * Read one agent kind's inventory.
   * @param kind - hosted agent kind to read.
   * @returns the stored inventory, or undefined when none exists.
   */
  async read(kind: AgentKind): Promise<SkillInventory | undefined> {
    try {
      const text = await readFile(this.fileFor(kind), 'utf8')
      return JSON.parse(text) as SkillInventory
    } catch (error) {
      // A missing inventory is the ordinary "not scanned yet" answer, and a
      // malformed file is reported the same way rather than failing the launch
      // that only wanted a skill hint.
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || error instanceof SyntaxError) return undefined
      throw error
    }
  }

  /**
   * List every stored inventory.
   * @returns inventories ordered by agent kind; files that are not inventories of a known agent kind are skipped.
   */
  async list(): Promise<SkillInventory[]> {
    let names: string[]
    try {
      names = await readdir(this.directory)
    } catch (error) {
      // No directory yet means nothing has been scanned.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const inventories: SkillInventory[] = []
    for (const name of names.sort()) {
      if (!name.endsWith(INVENTORY_SUFFIX)) continue
      const kind = name.slice(0, -INVENTORY_SUFFIX.length)
      if (!isAgentKind(kind)) continue
      const inventory = await this.read(kind)
      if (inventory) inventories.push(inventory)
    }
    return inventories
  }

  /** Absolute path of one agent kind's inventory file. */
  private fileFor(kind: AgentKind): string {
    return join(this.directory, `${kind}${INVENTORY_SUFFIX}`)
  }
}

/**
 * Render the skill brief a launch prompt carries.
 * @param skills - skill names the hosted agent must use.
 * @returns the brief, or an empty string when no skill is required.
 */
export function renderSkillBrief(skills: readonly string[]): string {
  if (skills.length === 0) return ''
  return `请使用以下技能完成：\n${skills.map(skill => `- ${skill}`).join('\n')}`
}

/**
 * Rank agents for a subtask's required skills.
 * @param required - skill names the subtask needs, in plan order.
 * @param inventories - one skill inventory per hosted agent kind.
 * @returns one row per inventory, most matched skills first and then by agent kind.
 */
export function matchAgents(
  required: readonly string[],
  inventories: readonly SkillInventory[],
): { agentKind: AgentKind; matched: string[]; missing: string[] }[] {
  return inventories
    .map(inventory => ({
      agentKind: inventory.agentKind,
      matched: required.filter(skill => inventory.skills.includes(skill)),
      missing: required.filter(skill => !inventory.skills.includes(skill)),
    }))
    .sort((left, right) => right.matched.length - left.matched.length || compareKinds(left.agentKind, right.agentKind))
}

/**
 * Skills directories of one agent kind, in scan order.
 * @param kind - hosted agent kind.
 * @param roots - home and workspace directories to resolve under.
 * @returns absolute directory paths to scan.
 */
function skillDirectories(kind: AgentKind, roots: SkillScanRoots): string[] {
  if (kind === 'claude-code') {
    return [join(roots.homeDir, '.claude', 'skills'), join(roots.workspaceDir, '.claude', 'skills')]
  }
  if (kind === 'codex') {
    return [join(roots.homeDir, '.codex', 'skills'), join(roots.workspaceDir, '.codex', 'skills')]
  }
  if (kind === 'dsh') return [join(roots.workspaceDir, '.agents', 'skills')]
  return [join(roots.homeDir, `.${kind}`, 'skills')]
}

/**
 * List the skill names one directory contributes.
 * @param directory - absolute skills directory to read.
 * @param markdownFiles - whether a `.md` file directly in the directory is a skill.
 * @returns the skill names found, or undefined when the directory is absent or unreadable.
 */
async function listSkills(directory: string, markdownFiles: boolean): Promise<string[] | undefined> {
  const entries = await readRoot(() => readdir(directory, { withFileTypes: true }))
  if (entries === undefined) return undefined
  const names: string[] = []
  for (const entry of entries) {
    if (entry.isDirectory()) {
      names.push(entry.name)
      continue
    }
    if (markdownFiles && entry.name.endsWith(MARKDOWN_SUFFIX)) {
      names.push(entry.name.slice(0, -MARKDOWN_SUFFIX.length))
    }
  }
  return names
}

/**
 * Skill package names declared by a cordis.yml manifest.
 * @param text - manifest text.
 * @returns skill names with the `dsh-skill-` prefix stripped, in declaration order.
 */
function skillPackageNames(text: string): string[] {
  return (text.match(SKILL_PACKAGE_PATTERN) ?? [])
    .map(specifier => specifier.slice(SKILL_PACKAGE_PREFIX.length))
}

/**
 * Run one filesystem read, reporting an absent or unreadable root as no result.
 * @param read - the filesystem read to perform.
 * @returns the read value, or undefined when the root is absent or unreadable.
 */
async function readRoot<T>(read: () => Promise<T>): Promise<T | undefined> {
  try {
    return await read()
  } catch (error) {
    if (SKIPPABLE_ROOT_ERRORS.has((error as NodeJS.ErrnoException).code)) return undefined
    throw error
  }
}

/**
 * Whether a directory entry name is a known agent kind.
 * @param value - file name without its extension.
 * @returns true when the value names an agent kind.
 */
function isAgentKind(value: string): value is AgentKind {
  return AGENT_KIND_NAMES.has(value)
}

/**
 * Order two agent kinds by name.
 * @param left - first agent kind.
 * @param right - second agent kind.
 * @returns a negative number when left sorts first, a positive number when right sorts first, and 0 when they are equal.
 */
function compareKinds(left: AgentKind, right: AgentKind): number {
  if (left === right) return 0
  return left < right ? -1 : 1
}
