/**
 * Shared vocabulary for the supervisor plugin: hosted agent kinds, deterministic
 * state marks, L1 rule hits, task plans, and checkpoints.
 *
 * Every type here is either a model-facing tool payload (validated at the tool
 * boundary) or a durable record stored under the configured state directory.
 * @module @deepseek-ai/dsh-supervisor-core/types
 */

/** External CLI agent kinds this plugin knows how to launch and drive. */
export type AgentKind = 'claude-code' | 'codex' | 'kimi-code' | 'qwen-code' | 'trae' | 'dsh'

/**
 * Deterministic observation derived from one terminal settlement. A mark is a
 * fact about what the terminal returned, never a judgement: the hosted model
 * decides whether one is abnormal and what to do about it.
 */
export type StateMark =
  /** The terminal settled at an input prompt (`stdin_read` or `inferred_idle`). */
  | 'prompt-idle'
  /** The output matches an interactive confirmation prompt. */
  | 'waiting-input'
  /** The output carries an activity marker of the hosted agent CLI. */
  | 'working'
  /** The wait timed out with no prompt; the child may still be working or stuck. */
  | 'silence'
  /** The top-level session exited with code 0. */
  | 'exit-ok'
  /** The top-level session exited with a non-zero code or a signal. */
  | 'exit-bad'
  /** The heartbeat file for this session is older than the configured timeout. */
  | 'heartbeat-stale'

/** Severity ladder shared by L1 rules and checkpoint failure escalation. */
export type L1Severity = 'low' | 'medium' | 'high' | 'critical'

/** One deterministic L1 rule match. */
export interface L1RuleHit {
  /** Built-in rule id that matched. */
  ruleId: string
  /** Configured severity of that rule. */
  severity: L1Severity
  /** Verbatim output fragment that triggered the match, bounded for display. */
  evidence: string
  /** Epoch milliseconds of the scan that produced this hit. */
  timestamp: number
}

/** Verification method of one acceptance criterion on a task plan. */
export type VerificationMethod = 'test-command' | 'file-exists' | 'output-contains' | 'manual' | 'llm-judge'

/** One acceptance criterion of a planned task or subtask. */
export interface AcceptanceCriterion {
  /** Stable id unique within the plan. */
  id: string
  /** What must be true for this criterion to pass. */
  description: string
  /** How the criterion is verified. */
  verificationMethod: VerificationMethod
  /** Method-specific inputs (command string, file glob, expected substring). */
  verificationSpec?: Record<string, string>
  /** Latest known result; `pending` until the hosted model reports one. */
  status: 'pending' | 'passed' | 'failed'
}

/** Effort estimate of one subtask, used only for scheduling hints. */
export type EstimatedEffort = 'small' | 'medium' | 'large'

/** Lifecycle state of one subtask. */
export type SubTaskStatus = 'pending' | 'in-progress' | 'completed' | 'failed' | 'skipped'

/** One independently verifiable unit of a decomposed task. */
export interface SubTask {
  /** Stable id unique within the plan; referenced by `dependsOn`. */
  id: string
  /** Short imperative title. */
  title: string
  /** What to do, including the acceptance points the hosted agent must satisfy. */
  description: string
  /** Ids of subtasks that must complete before this one starts; forms a DAG. */
  dependsOn: string[]
  /** Skills the hosted agent must use to complete this subtask. */
  requiredSkills: string[]
  /** Agent kind best suited to this subtask, when the planner has a preference. */
  preferredAgent?: AgentKind
  /** Rough effort estimate. */
  estimatedEffort: EstimatedEffort
  /** Subtask-level acceptance criteria. */
  acceptanceCriteria: string[]
  /** Current lifecycle state. */
  status: SubTaskStatus
}

/** Merge strategy for combining subtask work. */
export type IntegrationStrategy = 'sequential-merge' | 'parallel-merge' | 'staged'

/** The whole decomposed task, persisted per task id. */
export interface TaskPlan {
  /** Task identity owned by this plan. */
  taskId: string
  /** The user-visible goal of the task. */
  goal: string
  /** Constraints the hosted agents must respect. */
  constraints: string[]
  /** Task-level acceptance criteria. */
  acceptanceCriteria: AcceptanceCriterion[]
  /** Decomposed subtasks; `dependsOn` edges form a DAG. */
  subTasks: SubTask[]
  /** How completed subtask work is merged. */
  integrationStrategy: IntegrationStrategy
  /** Epoch milliseconds when the plan was first written. */
  createdAt: number
  /** Epoch milliseconds of the most recent write. */
  updatedAt: number
}

/** Git facts captured with a checkpoint. */
export interface GitRef {
  /** Absolute path of the repository the checkpoint belongs to. */
  repoPath: string
  /** Branch the checkpoint commits on. */
  branch: string
  /** Commit the checkpoint pins, or an empty string when no commit was made. */
  commitHash: string
  /** Whether tracked files were dirty when the checkpoint was taken. */
  hasUncommitted: boolean
}

/** Terminal facts captured with a checkpoint so a relaunch can reproduce them. */
export interface TerminalStateRecord {
  /** Hosted agent kind running in the terminal. */
  agentKind: AgentKind
  /** Exact launch command used last, including substituted model and prompt. */
  lastLaunchCommand: string
  /** Model requested at launch or through a switch command, when known. */
  lastModel?: string
  /** Last observed session status. */
  state: string
  /** Input the supervisor still owed the terminal when the checkpoint was taken. */
  pendingInput?: string
}

/** One restorable checkpoint of a task. */
export interface SupervisorCheckpoint {
  /** Durable record version; incremented only for structural changes. */
  schemaVersion: number
  /** Identity of this checkpoint. */
  checkpointId: string
  /** Task this checkpoint belongs to. */
  taskId: string
  /** Plan step index the checkpoint was taken at. */
  stepIndex: number
  /** Epoch milliseconds when the checkpoint was taken. */
  timestamp: number
  /** 1-based attempt number of the step that produced this checkpoint. */
  attempt: number
  /** Git facts, absent when no repository was resolvable. */
  gitRef?: GitRef
  /** Supervisor agent session id, for cross-referencing the dsh session log. */
  supervisorSessionId: string
  /** Terminal this checkpoint refers to, when one was supervised. */
  terminalSessionId?: string
  /** Append-only output log of that terminal, when spill was enabled. */
  outputSpillPath?: string
  /** Terminal facts needed to relaunch. */
  terminalState?: TerminalStateRecord
}

/** Per-terminal liveness record maintained while a hosted agent runs. */
export interface Heartbeat {
  /** Terminal session the heartbeat tracks. */
  sessionId: string
  /** Epoch milliseconds of the last observed output. */
  lastOutputAt: number
  /** Wait reason of the settlement that produced that output. */
  lastWaitReason: string
  /** Consecutive watchdog passes that found this heartbeat stale. */
  consecutiveStaleChecks: number
}
