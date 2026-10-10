/**
 * This package's own configuration: the phase-to-model rule table, the skill
 * roots a scan reads, and the worktree branch prefix and concurrency dispatch
 * uses. Values owned by the control plane — the state directory, the workspace
 * directory, and the worktree base — are read from the mounted core service
 * instead of being declared again here.
 * @module @deepseek-ai/dsh-supervisor-orchestration/config
 */

import { homedir } from 'node:os'
import { resolve } from 'node:path'
import type { ResolvedConfig } from '@deepseek-ai/dsh-supervisor-core'
import type { SkillScanRoots } from './skills.ts'
import { resolveModelRules, type ModelRule, type ResolvedModelRule } from './switch.ts'

/** Plugin configuration as authored in cordis.yml. */
export interface OrchestrationConfig {
  /** Phase-to-model rules `supervisor_agent_switch` resolves a phase through. */
  modelRules?: ModelRule[]
  /** Roots the skill scan reads. */
  skillRoots?: {
    /** Operator home directory the per-agent skill roots resolve under; defaults to the OS home directory. */
    homeDir?: string
    /** Workspace the project-local skill roots resolve under; defaults to the core workspace directory. */
    workspaceDir?: string
  }
  /** Prefix of the branch each worktree checks out. */
  worktreeBranchPrefix?: string
  /** Terminals `supervisor_dispatch` may start at once. */
  maxConcurrency?: number
}

/** Configuration after defaults are applied and paths are resolved. */
export interface OrchestrationSettings {
  /** Effective phase-to-model rules. */
  modelRules: ResolvedModelRule[]
  /** Absolute roots the skill scan reads. */
  skillRoots: SkillScanRoots
  /** Absolute directory worktrees are created under, resolved by the control plane. */
  worktreeBase: string
  /** Prefix of the branch each worktree checks out. */
  worktreeBranchPrefix: string
  /** Terminals the dispatcher may start at once. */
  maxConcurrency: number
}

/** The resolved core values this package's defaults are resolved against. */
export type OrchestrationPaths = Pick<ResolvedConfig, 'workspaceDir' | 'worktreeBase'>

/**
 * Resolve this package's configuration over the mounted control plane's paths.
 * @param config - configuration as authored.
 * @param core - resolved core configuration holding the workspace and worktree base.
 * @returns the orchestration configuration, with absolute paths and effective values.
 * @throws TypeError when a model rule names an unknown or twice-claimed phase, a
 * declared model is blank, or a positive-number field is not positive.
 */
export function resolveOrchestrationConfig(config: OrchestrationConfig, core: OrchestrationPaths): OrchestrationSettings {
  return {
    modelRules: resolveModelRules(config.modelRules ?? []),
    skillRoots: {
      homeDir: config.skillRoots?.homeDir ?? homedir(),
      workspaceDir: resolve(core.workspaceDir, config.skillRoots?.workspaceDir ?? '.'),
    },
    worktreeBase: core.worktreeBase,
    worktreeBranchPrefix: config.worktreeBranchPrefix ?? 'supervisor/',
    maxConcurrency: requirePositive(config.maxConcurrency ?? 4, 'maxConcurrency'),
  }
}

/** Reject a non-positive or non-finite configured number. */
function requirePositive(value: number, field: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError(`supervisor configuration field "${field}" must be a positive number`)
  }
  return value
}
