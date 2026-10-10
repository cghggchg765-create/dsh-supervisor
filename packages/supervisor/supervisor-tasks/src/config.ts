/**
 * Configuration of the durable task-state component. The state directory and
 * every shared path belong to the control plane, so this resolver only turns
 * the checkpoint and issue-ticket choices into effective values.
 * @module @deepseek-ai/dsh-supervisor-tasks/config
 */

import type { CheckpointRetention } from './checkpoint.ts'

/** Plugin configuration as authored in cordis.yml. */
export interface SupervisorTaskConfig {
  /** Prefix of the branch each checkpoint commits on. */
  checkpointBranchPrefix?: string
  /** Checkpoints kept per task; the oldest are removed first. */
  checkpointMaxPerTask?: number
  /** Days a checkpoint is kept before retention removes it. */
  checkpointMaxAgeDays?: number
  /** Repairs allowed per issue ticket before it escalates. */
  maxRetriesPerIssue?: number
}

/** Configuration after defaults are applied. */
export interface ResolvedTaskConfig {
  /** Absolute state directory, shared with the control plane. */
  stateDir: string
  /** Effective checkpoint retention policy. */
  checkpointRetention: CheckpointRetention
  /** Prefix of the branch each checkpoint commits on. */
  checkpointBranchPrefix: string
  /** Repairs allowed per issue ticket. */
  maxRetriesPerIssue: number
}

/**
 * Resolve the task-state configuration.
 * @param config - configuration as authored.
 * @param stateDir - absolute state directory owned by the control plane.
 * @returns the resolved configuration.
 * @throws TypeError when a retention limit or retry budget is unusable.
 */
export function resolveTaskConfig(config: SupervisorTaskConfig, stateDir: string): ResolvedTaskConfig {
  return {
    stateDir,
    checkpointRetention: {
      maxPerTask: requirePositive(config.checkpointMaxPerTask ?? 10, 'checkpointMaxPerTask'),
      maxAgeDays: requirePositive(config.checkpointMaxAgeDays ?? 30, 'checkpointMaxAgeDays'),
    },
    checkpointBranchPrefix: config.checkpointBranchPrefix ?? 'supervisor/',
    maxRetriesPerIssue: requirePositive(config.maxRetriesPerIssue ?? 2, 'maxRetriesPerIssue'),
  }
}

/** Reject a non-positive or non-finite configured number. */
function requirePositive(value: number, field: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError(`supervisor configuration field "${field}" must be a positive number`)
  }
  return value
}
