/**
 * Phase-aware model selection for hosted CLI agents. A supervised task is
 * planned, reasoned about, verified, coded, executed, and retrieved from; the
 * operator may want a premium model for the thinking phases and a cheap one for
 * the mechanical phases, so configuration declares one rule per set of phases.
 *
 * This module is the deterministic half of a switch: it validates the rules,
 * answers which candidate models cover a phase, and renders the in-session
 * switch commands. Whether the hosted CLI accepted the switch stays with the
 * supervising model, which reads the terminal output. A CLI without an
 * in-session switch command yields no commands at all, and the caller relaunches
 * the agent with the candidate model instead.
 * @module @deepseek-ai/dsh-supervisor-orchestration/switch
 */

/** One phase of supervised work whose model can be chosen deliberately. */
export type TaskPhase = 'planning' | 'reasoning' | 'verification' | 'coding' | 'execution' | 'retrieval'

/** Every task phase, in declaration order. */
export const TASK_PHASES: readonly TaskPhase[] = [
  'planning',
  'reasoning',
  'verification',
  'coding',
  'execution',
  'retrieval',
]

/** Configured model choice for one or more phases. */
export interface ModelRule {
  /** Phases this rule applies to. */
  phases: TaskPhase[]
  /** Model selected for those phases. */
  model: string
  /** Models to try, in order, when the selected model is rejected. */
  fallbackModels?: string[]
}

/** A rule after validation: the selected model followed by its fallbacks. */
export interface ResolvedModelRule {
  /** Phases this rule applies to, in declaration order. */
  phases: TaskPhase[]
  /** Candidate models, most preferred first; never empty. */
  models: string[]
}

/**
 * Validate configured model rules and collect the candidate models of each.
 * @param rules - rules as authored in configuration.
 * @returns one resolved rule per input rule, in declaration order.
 * @throws TypeError when a rule names an unknown phase, a later rule covers a
 * phase an earlier rule already claimed, or a declared model is blank.
 */
export function resolveModelRules(rules: readonly ModelRule[]): ResolvedModelRule[] {
  const claimed = new Map<TaskPhase, string>()
  const resolved: ResolvedModelRule[] = []
  for (const rule of rules) {
    const phases: TaskPhase[] = []
    for (const phase of rule.phases) {
      if (!TASK_PHASES.includes(phase)) {
        throw new TypeError(`supervisor model rule names unknown task phase "${phase}"; known phases: ${TASK_PHASES.join(', ')}`)
      }
      const owner = claimed.get(phase)
      if (owner !== undefined) {
        throw new TypeError(`supervisor model rules cover phase "${phase}" twice; the rule for model "${owner}" claimed it first`)
      }
      claimed.set(phase, rule.model)
      phases.push(phase)
    }
    const declared = [rule.model, ...(rule.fallbackModels ?? [])]
    resolved.push({ phases, models: declared.map(model => requireModel(model, rule)) })
  }
  return resolved
}

/**
 * Candidate models for one phase.
 * @param phase - phase to look up.
 * @param rules - resolved rule table.
 * @returns the covering rule's candidate models, or undefined when no rule covers the phase.
 */
export function modelsForPhase(phase: TaskPhase, rules: readonly ResolvedModelRule[]): string[] | undefined {
  for (const rule of rules) {
    if (rule.phases.includes(phase)) return [...rule.models]
  }
  return undefined
}

/**
 * Characters that would let one substituted model break out of a single
 * in-session command line — C0/C1 controls (newline, carriage return, tab,
 * escape) and the Unicode line separators. A model name never carries one.
 */
const UNSAFE_MODEL_CHARACTER = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/

/**
 * Whether one model name can be substituted into an in-session switch command:
 * non-empty after trimming and free of control characters.
 * @param model - model name to vet.
 * @returns true when the name is safe to substitute.
 */
export function isSwitchableModelName(model: string): boolean {
  const candidate = model.trim()
  return candidate !== '' && !UNSAFE_MODEL_CHARACTER.test(candidate)
}

/**
 * Substitute `{model}` into one in-session switch command template. The caller
 * must pass a validated single-line model; {@link switchCommands} enforces that
 * every candidate it substitutes carries no control character.
 * @param template - configured switch command.
 * @param model - model name to substitute.
 * @returns the command text with every placeholder replaced.
 */
export function renderSwitchCommand(template: string, model: string): string {
  return template.replaceAll('{model}', model)
}

/**
 * Commands to try for one model switch, most preferred first. Returns an empty
 * array when the CLI has no in-session switch command (the caller relaunches).
 * Templates are trimmed and internal whitespace is collapsed. A candidate that
 * carries a control character is skipped, so one substituted model cannot break
 * out of a single in-session command line.
 * @param template - configured switch command, or undefined when the CLI has none.
 * @param models - candidate models, most preferred first.
 * @returns the distinct non-empty commands, in candidate order.
 */
export function switchCommands(template: string | undefined, models: readonly string[]): string[] {
  if (template === undefined) return []
  const normalized = template.replaceAll(/\s+/g, ' ').trim()
  const commands: string[] = []
  for (const model of models) {
    const candidate = model.trim()
    if (!isSwitchableModelName(candidate)) continue
    const command = renderSwitchCommand(normalized, candidate)
    if (command === '' || commands.includes(command)) continue
    commands.push(command)
  }
  return commands
}

/**
 * Trim one declared model, rejecting a blank entry.
 * @param model - model as declared in configuration.
 * @param rule - rule that declared it, for the error message.
 * @returns the trimmed model name.
 * @throws TypeError when the declared model is blank.
 */
function requireModel(model: string, rule: ModelRule): string {
  const trimmed = model.trim()
  if (trimmed !== '') return trimmed
  throw new TypeError(`supervisor model rule over phases [${rule.phases.join(', ')}] needs a non-empty model`)
}
