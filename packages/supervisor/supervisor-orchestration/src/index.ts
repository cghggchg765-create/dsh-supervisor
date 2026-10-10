/**
 * Orchestration for supervised long runs: it keeps per-agent skill inventories
 * with matching, switches a hosted CLI's model by task phase through that CLI's
 * own in-session command, isolates parallel subtasks in git worktrees, and
 * reports the next batch the configured concurrency allows. This package
 * publishes no service: it registers four tools on `ctx.tools` and reads the
 * control plane (`ctx.supervisor`) and the task services (`ctx.supervisorTasks`)
 * it composes with.
 * @module @deepseek-ai/dsh-supervisor-orchestration
 */

import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { resolveOrchestrationConfig, type OrchestrationConfig } from './config.ts'
import { SkillStore } from './skills.ts'
import { TASK_PHASES } from './switch.ts'
import { registerTools } from './tools.ts'
import { WorktreeManager } from './worktree.ts'

/** Cordis plugin name. */
export const name = 'supervisor-orchestration'

/** Services the orchestration tools register on, read, and drive. */
export const inject = ['tools', 'terminals', 'supervisor', 'supervisorTasks']

/** Plugin configuration schema. */
export const Config: z<OrchestrationConfig> = z.object({
  modelRules: z.array(z.object({
    phases: z.array(z.union(TASK_PHASES.map(phase => z.const(phase)))).default([]),
    model: z.string().required(),
    fallbackModels: z.array(z.string()),
  })).default([]),
  skillRoots: z.object({
    homeDir: z.string(),
    workspaceDir: z.string(),
  }).default({}),
  worktreeBranchPrefix: z.string().default('supervisor/'),
  maxConcurrency: z.number().step(1).min(1).default(4),
})

/**
 * Resolve this package's settings against the mounted control plane and
 * register the four orchestration tools.
 * @param ctx - the context carrying the tools, supervisor, and task services.
 * @param config - plugin configuration as authored.
 * @throws TypeError when a model rule or a positive-number field is unusable.
 */
export function apply(ctx: Context, config: OrchestrationConfig = {}): void {
  const settings = resolveOrchestrationConfig(config, ctx.supervisor.config)
  const skills = new SkillStore(join(ctx.supervisor.config.stateDir, 'skills'))
  const worktrees = new WorktreeManager(ctx.supervisorTasks.git, settings.worktreeBase, settings.worktreeBranchPrefix)
  registerTools(ctx, {
    runtime: ctx.supervisor,
    git: ctx.supervisorTasks.git,
    skills,
    skillRoots: settings.skillRoots,
    modelRules: settings.modelRules,
    worktrees,
    worktreeBranchPrefix: settings.worktreeBranchPrefix,
    maxConcurrency: settings.maxConcurrency,
  })
}
