import { describe, expect, it } from 'vitest'
import { AGENT_CHARACTERISTICS, characteristicsFor, classifyOutput } from '../src/adapter.ts'
import {
  DEFAULT_THRESHOLDS,
  SessionWindows,
  deriveMarks,
  isFailedObservation,
  normalizeForWindow,
  resolveRules,
  scanText,
  type ResolvedRule,
} from '../src/guard.ts'

const RULES = resolveRules([])

/** Run one settlement scan with the default rules. */
function scan(text: string, now = 1_000_000): ReturnType<typeof scanText> {
  return scanText(text, RULES, now, DEFAULT_THRESHOLDS)
}

describe('L1 pattern scanning', () => {
  it('reports a transport errno as api-disconnect', () => {
    const hits = scan('Error: read ECONNRESET from provider')
    expect(hits.map(hit => hit.ruleId)).toContain('api-disconnect')
    expect(hits[0]?.severity).toBe('high')
  })

  it('reports a literal disconnect phrase that carries no errno', () => {
    expect(scan('socket hang up').map(hit => hit.ruleId)).toContain('api-disconnect')
  })

  it('reports an HTTP 429 as rate-limit', () => {
    expect(scan('HTTP 429 Too Many Requests').map(hit => hit.ruleId)).toContain('rate-limit')
  })

  it('reports an interactive confirmation and a numbered menu as permission-prompt', () => {
    expect(scan('Do you want to continue? (y/n)').map(hit => hit.ruleId)).toContain('permission-prompt')
    expect(scan('❯ 1. Yes\n  2. No').map(hit => hit.ruleId)).toContain('permission-prompt')
  })

  it('leaves an ordinary numbered list alone', () => {
    expect(scan('1. install dependencies\n2. run the tests').map(hit => hit.ruleId)).not.toContain('permission-prompt')
  })

  it('reports a rejected model switch', () => {
    expect(scan('/model gpt-9\ninvalid model: gpt-9').map(hit => hit.ruleId)).toContain('model-switch-fail')
  })

  it('reports one settlement larger than the context-bloat bound', () => {
    const hits = scanText('x'.repeat(60 * 1024), RULES, 1, DEFAULT_THRESHOLDS)
    expect(hits.map(hit => hit.ruleId)).toContain('context-bloat')
  })

  it('honours a configured context-bloat bound', () => {
    const thresholds = { ...DEFAULT_THRESHOLDS, contextBloatBytes: 8 }
    expect(scanText('ninebytes', RULES, 1, thresholds).map(hit => hit.ruleId)).toContain('context-bloat')
    expect(scanText('ninebytes', RULES, 1, DEFAULT_THRESHOLDS).map(hit => hit.ruleId)).not.toContain('context-bloat')
  })

  it('keeps the matched fragment as bounded evidence', () => {
    const hit = scan(`ECONNRESET ${'y'.repeat(500)}`).find(entry => entry.ruleId === 'api-disconnect')
    expect(hit?.evidence.length).toBeLessThanOrEqual(201)
  })

  it('elides a matched fragment longer than the evidence bound', () => {
    const hit = scan(`Allow ${'x'.repeat(400)}?`).find(entry => entry.ruleId === 'permission-prompt')
    expect(hit?.evidence).toHaveLength(201)
    expect(hit?.evidence.endsWith('…')).toBe(true)
  })
})

describe('L1 rule configuration', () => {
  it('disables a rule and raises the severity of another', () => {
    const rules = resolveRules([
      { id: 'rate-limit', enabled: false },
      { id: 'permission-prompt', severity: 'critical' },
    ])
    expect(scanText('429 rate limit', rules, 1, DEFAULT_THRESHOLDS).map(hit => hit.ruleId)).not.toContain('rate-limit')
    expect(scanText('(y/n)', rules, 1, DEFAULT_THRESHOLDS)[0]?.severity).toBe('critical')
  })

  it('activates the drift rule only once keywords are configured', () => {
    const disabled = resolveRules([]).find(rule => rule.id === 'goal-drift-signal')
    expect(disabled?.enabled).toBe(false)
    const rules = resolveRules([{ id: 'goal-drift-signal', keywords: ['redesign the logo'] }])
    const hits = scanText('maybe we should redesign the logo instead', rules, 1, DEFAULT_THRESHOLDS)
    expect(hits.map(hit => hit.ruleId)).toContain('goal-drift-signal')
  })

  it('ignores keywords the caller left blank', () => {
    const rules = resolveRules([{ id: 'goal-drift-signal', keywords: ['  '] }])
    expect(rules.find(rule => rule.id === 'goal-drift-signal')?.enabled).toBe(false)
  })

  it('scans a keywords rule that declares no matcher and one that matches nothing', () => {
    const rules: ResolvedRule[] = [
      { id: 'configured-drift', severity: 'medium', kind: 'keywords', enabled: true, keywords: ['redesign the logo'] },
      { id: 'keywordless-drift', severity: 'medium', kind: 'keywords', enabled: true },
    ]
    expect(scanText('maybe we redesign the logo later', rules, 1, DEFAULT_THRESHOLDS).map(hit => hit.ruleId))
      .toEqual(['configured-drift'])
    expect(scanText('nothing configured matches this text', rules, 1, DEFAULT_THRESHOLDS)).toEqual([])
  })

  it('rejects an unknown rule id', () => {
    expect(() => resolveRules([{ id: 'not-a-rule' }])).toThrow(/unknown supervisor L1 rule/)
  })
})

describe('window rules', () => {
  /** Feed one session a sequence of observations. */
  function observeAll(
    windows: SessionWindows,
    entries: readonly { at: number; text: string; failed: boolean; exitCode?: number }[],
  ) {
    return entries.flatMap(entry => windows.observe(entry, DEFAULT_THRESHOLDS, RULES).map(hit => hit.ruleId))
  }

  it('reports a repeated identical output as empty-loop', () => {
    const windows = new SessionWindows()
    const hits = observeAll(windows, [
      { at: 0, text: 'waiting for build', failed: false },
      { at: 1000, text: 'waiting for build', failed: false },
      { at: 2000, text: 'waiting for build', failed: false },
    ])
    expect(hits).toContain('empty-loop')
  })

  it('reports an identical repeat as converged', () => {
    const windows = new SessionWindows()
    const entries = [0, 1000, 2000].map(at => ({ at, text: 'retry the same command', failed: false }))
    const hits = entries.flatMap(entry => windows.observe(entry, DEFAULT_THRESHOLDS, RULES))
    expect(hits.find(hit => hit.ruleId === 'empty-loop')?.convergence).toBe('identical')
  })

  it('reports a repeat inside still-growing output as changing', () => {
    const windows = new SessionWindows()
    const entries = [
      { at: 0, text: 'step 1 done\nstep 2 running', failed: false },
      { at: 1000, text: 'step 1 done', failed: false },
      { at: 2000, text: 'step 1 done', failed: false },
      { at: 3000, text: 'step 1 done', failed: false },
    ]
    const hits = entries.flatMap(entry => windows.observe(entry, DEFAULT_THRESHOLDS, RULES))
    expect(hits.find(hit => hit.ruleId === 'empty-loop')?.convergence).toBe('changing')
  })

  it('reports three consecutive failures as error-streak and clears on success', () => {
    const windows = new SessionWindows()
    const failures = [0, 1, 2].map(index => ({ at: index * 1000, text: `Error ${index}`, failed: true }))
    expect(observeAll(windows, failures)).toContain('error-streak')
    const afterSuccess = windows.observe({ at: 4000, text: 'ok', failed: false }, DEFAULT_THRESHOLDS, RULES)
    expect(afterSuccess.map(hit => hit.ruleId)).not.toContain('error-streak')
  })

  it('reports repeated non-zero exits as crash-loop', () => {
    const windows = new SessionWindows()
    const exits = [0, 1, 2].map(index => ({ at: index * 1000, text: `exit ${index}`, failed: true, exitCode: 1 }))
    expect(observeAll(windows, exits)).toContain('crash-loop')
  })

  it('drops exits that fell out of the crash window', () => {
    const windows = new SessionWindows()
    const old = [0, 1].map(index => ({ at: index * 1000, text: 'boom', failed: true, exitCode: 1 }))
    observeAll(windows, old)
    const late = windows.observe({ at: 11 * 60_000, text: 'boom', failed: true, exitCode: 1 }, DEFAULT_THRESHOLDS, RULES)
    expect(late.map(hit => hit.ruleId)).not.toContain('crash-loop')
  })

  it('keeps only the newest 64 observations in the window', () => {
    const windows = new SessionWindows()
    const entries = Array.from({ length: 65 }, (_, index) => ({ at: index, text: 'same output', failed: false }))
    const hits = entries.flatMap(entry => windows.observe(entry, DEFAULT_THRESHOLDS, RULES))
    // The 65th observation evicts the oldest, so the repeat count stops at 64.
    expect(hits.at(-1)?.evidence).toBe('64 repeats of the same output (identical)')
  })

  it('reports no repeat for an empty settlement', () => {
    const windows = new SessionWindows()
    const hits = observeAll(windows, [
      { at: 0, text: '', failed: false },
      { at: 1000, text: '', failed: false },
      { at: 2000, text: '', failed: false },
    ])
    expect(hits).not.toContain('empty-loop')
  })
})

describe('state marks', () => {
  const base = { sessionStatus: { kind: 'running' } as const }

  it('marks an input prompt as prompt-idle and a clean exit as exit-ok', () => {
    expect(deriveMarks({ ...base, waitReason: 'inferred_idle' })).toContain('prompt-idle')
    expect(deriveMarks({
      ...base,
      waitReason: 'session_exit',
      sessionStatus: { kind: 'exited', exitCode: 0, signal: null },
    })).toEqual(['exit-ok'])
  })

  it('marks a non-zero exit as exit-bad', () => {
    const marks = deriveMarks({
      ...base,
      waitReason: 'session_exit',
      sessionStatus: { kind: 'exited', exitCode: 1, signal: null },
    })
    expect(marks).toContain('exit-bad')
  })

  it('marks a timed-out settlement as silence and a confirmation prompt as waiting-input', () => {
    expect(deriveMarks({ ...base, waitReason: 'timeout' })).toContain('silence')
    const marks = deriveMarks({
      ...base,
      waitReason: 'stdin_read',
      classification: { kind: 'waiting-input', evidence: 'Allow access?' },
    })
    expect(marks).toContain('waiting-input')
  })

  it('marks an activity marker as working, and a read as neither idle nor silent', () => {
    expect(deriveMarks({
      ...base,
      waitReason: 'stdin_read',
      classification: { kind: 'working', evidence: 'esc to interrupt' },
    })).toContain('working')
    expect(deriveMarks({ ...base, waitReason: undefined })).toEqual([])
  })

  it('marks a stale heartbeat', () => {
    const marks = deriveMarks({
      ...base,
      waitReason: 'timeout',
      heartbeatStale: true,
    })
    expect(marks).toContain('heartbeat-stale')
  })
})

describe('output classification', () => {
  it('classifies a confirmation prompt ahead of an error quoted in the same output', () => {
    const characteristics = AGENT_CHARACTERISTICS['claude-code']
    const classified = classifyOutput(['Error: expected 200', 'Do you want to continue? (y/n)'].join('\n'), characteristics)
    expect(classified.kind).toBe('waiting-input')
    expect(classified.evidence).toContain('y/n')
  })

  it('classifies an activity marker as working and a clean prompt as completed', () => {
    const characteristics = AGENT_CHARACTERISTICS['claude-code']
    expect(classifyOutput('Thinking… (12s)', characteristics).kind).toBe('working')
    expect(classifyOutput(['done', '❯ '].join('\n'), characteristics).kind).toBe('completed')
  })

  it('classifies an unhandled failure as error and unrelated text as unknown', () => {
    const characteristics = AGENT_CHARACTERISTICS.codex
    expect(classifyOutput('Error: ENOENT no such file', characteristics).kind).toBe('error')
    expect(classifyOutput('just some ordinary chatter', characteristics).kind).toBe('unknown')
  })

  it('reads only the tail of a long settlement', () => {
    const characteristics = AGENT_CHARACTERISTICS.codex
    const text = ['Do you want to continue? (y/n)', ...Array.from({ length: 20 }, () => 'ordinary line')].join('\n')
    expect(classifyOutput(text, characteristics).kind).toBe('unknown')
  })

  it('bounds the evidence it reports', () => {
    const characteristics = AGENT_CHARACTERISTICS['claude-code']
    const classified = classifyOutput(`Allow ${'x'.repeat(400)}?`, characteristics)
    expect(classified.evidence?.length).toBeLessThanOrEqual(201)
  })

  it('falls back to the union of prompt patterns when no agent kind is declared', () => {
    const declared = characteristicsFor('codex')
    expect(declared.source).toBe('built-in')
    const fallback = characteristicsFor(undefined)
    expect(fallback.source).toBe('default')
    expect(classifyOutput('Do you want to continue? (y/n)', fallback.characteristics).kind).toBe('waiting-input')
    expect(classifyOutput('Thinking… (12s)', fallback.characteristics).kind).toBe('unknown')
  })
})

describe('observation helpers', () => {
  it('collapses whitespace and keeps the tail of a long output', () => {
    const normalized = normalizeForWindow(`start\n\n\n${'z'.repeat(600)}`)
    expect(normalized).not.toContain('\n')
    expect(normalized.length).toBe(400)
    expect(normalized.endsWith('z')).toBe(true)
  })

  it('treats a non-zero exit or an error line as a failed observation', () => {
    expect(isFailedObservation('all good')).toBe(false)
    expect(isFailedObservation('all good', 2)).toBe(true)
    expect(isFailedObservation('all good', 0)).toBe(false)
    expect(isFailedObservation('all good', null)).toBe(false)
    expect(isFailedObservation('Traceback (most recent call last)')).toBe(true)
    expect(isFailedObservation('Error: no such file')).toBe(true)
  })

  it('treats a failed build, a fatal error, and a panic as failures', () => {
    expect(isFailedObservation('BUILD FAILED in 3s')).toBe(true)
    expect(isFailedObservation('fatal: not a git repository')).toBe(true)
    expect(isFailedObservation('thread panic: index out of bounds')).toBe(true)
  })
})
