/**
 * Durable task state for supervised runs: plan authoring, git checkpoints with
 * retention, and issue tickets that carry review findings into a redo brief.
 * The control plane owns the sessions, plans, spill logs, and every shared
 * path, so this component resolves only its own checkpoint and ticket choices
 * and stores its records under the shared state directory.
 * @module @deepseek-ai/dsh-supervisor-tasks
 */

import { join } from 'node:path'
import { Service, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { CheckpointStore } from './checkpoint.ts'
import { resolveTaskConfig, type ResolvedTaskConfig, type SupervisorTaskConfig } from './config.ts'
import { GitRunner } from './git.ts'
import { IssueStore } from './review.ts'
import { registerTools } from './tools.ts'

/**
 * Task plans, checkpoints, and issue tickets for supervised runs: the durable
 * state an interrupted or reviewed run resumes from, stored under the control
 * plane's state directory.
 */
export class SupervisorTaskService extends Service {
  /** Services the task tools register on and read shared state from. */
  static inject = ['tools', 'supervisor']

  /** Plugin configuration schema. */
  static Config: z<SupervisorTaskConfig> = z.object({
    checkpointBranchPrefix: z.string().default('supervisor/'),
    checkpointMaxPerTask: z.number().step(1).min(1).default(10),
    checkpointMaxAgeDays: z.number().step(1).min(1).default(30),
    maxRetriesPerIssue: z.number().step(1).min(1).default(2),
  })

  /** Resolved configuration. */
  readonly config: ResolvedTaskConfig

  /** Checkpoint records, one directory per task. */
  readonly checkpoints: CheckpointStore

  /** Issue tickets, one JSON file per ticket. */
  readonly tickets: IssueStore

  /** Git operations the checkpoint tool runs. */
  readonly git: GitRunner = new GitRunner()

  /**
   * @param ctx - the context the service registers itself in.
   * @param config - validated plugin configuration.
   */
  constructor(ctx: Context, config: SupervisorTaskConfig = {}) {
    super(ctx, 'supervisorTasks')
    this.config = resolveTaskConfig(config, ctx.supervisor.config.stateDir)
    this.checkpoints = new CheckpointStore(join(this.config.stateDir, 'checkpoints'), this.config.checkpointRetention)
    this.tickets = new IssueStore(join(this.config.stateDir, 'tickets'))
    registerTools(this.ctx, this)
  }
}

export default SupervisorTaskService

export { resolveTaskConfig, type ResolvedTaskConfig, type SupervisorTaskConfig } from './config.ts'

export {
  CHECKPOINT_SCHEMA_VERSION,
  CheckpointStore,
  type CheckpointDraft,
  type CheckpointRetention,
} from './checkpoint.ts'

export { recordFile, readRecordFile, taskDirectory } from './record-file.ts'

export { GitRunner, type GitDiffStat, type GitResult } from './git.ts'

export {
  IssueStore,
  advanceTicket,
  blockingFindings,
  isBlocking,
  openTicket,
  renderRedoBrief,
  renderReviewPacket,
  type Finding,
  type FindingCategory,
  type FindingSeverity,
  type IssueTicket,
  type ReviewPacketInput,
  type TicketStatus,
} from './review.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    supervisorTasks: SupervisorTaskService
  }
}
