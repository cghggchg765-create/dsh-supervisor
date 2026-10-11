import { describe, expect, it } from 'vitest'
import {
  TASK_PHASES,
  isSwitchableModelName,
  modelsForPhase,
  renderSwitchCommand,
  resolveModelRules,
  switchCommands,
  type ModelRule,
} from '../src/switch.ts'

describe('task phases', () => {
  it('lists the phases an operator can route to their own model', () => {
    expect(TASK_PHASES).toEqual(['planning', 'reasoning', 'verification', 'coding', 'execution', 'retrieval'])
  })
})

describe('model rule resolution', () => {
  it('resolves the selected model followed by its fallbacks', () => {
    const resolved = resolveModelRules([
      { phases: ['planning', 'reasoning', 'verification'], model: 'premium', fallbackModels: ['standard', 'budget'] },
      { phases: ['coding'], model: 'standard' },
    ])
    expect(resolved).toEqual([
      { phases: ['planning', 'reasoning', 'verification'], models: ['premium', 'standard', 'budget'] },
      { phases: ['coding'], models: ['standard'] },
    ])
  })

  it('trims declared models', () => {
    const resolved = resolveModelRules([{ phases: ['execution'], model: '  standard  ', fallbackModels: [' budget '] }])
    expect(resolved).toEqual([{ phases: ['execution'], models: ['standard', 'budget'] }])
  })

  it('keeps a rule that covers no phase', () => {
    expect(resolveModelRules([{ phases: [], model: 'standard' }])).toEqual([{ phases: [], models: ['standard'] }])
  })

  it('rejects a phase outside the task phases', () => {
    const phases: string[] = ['debugging']
    const rule = { phases, model: 'standard' } as ModelRule
    expect(() => resolveModelRules([rule])).toThrow('unknown task phase "debugging"')
  })

  it('rejects a phase two rules both cover', () => {
    expect(() => resolveModelRules([
      { phases: ['coding'], model: 'standard' },
      { phases: ['coding'], model: 'budget' },
    ])).toThrow(/"coding" twice/)
  })

  it('rejects a blank selected model', () => {
    expect(() => resolveModelRules([{ phases: ['coding'], model: '  ' }]))
      .toThrow(/phases \[coding\] needs a non-empty model/)
  })

  it('rejects a blank fallback model', () => {
    expect(() => resolveModelRules([{ phases: ['coding'], model: 'standard', fallbackModels: [' '] }]))
      .toThrow(/phases \[coding\] needs a non-empty model/)
  })
})

describe('phase lookup', () => {
  const rules = resolveModelRules([
    { phases: ['planning'], model: 'premium', fallbackModels: ['standard'] },
    { phases: ['coding'], model: 'standard' },
  ])

  it('returns the candidates of the rule covering the phase', () => {
    expect(modelsForPhase('planning', rules)).toEqual(['premium', 'standard'])
  })

  it('returns no candidates for a phase no rule covers', () => {
    expect(modelsForPhase('retrieval', rules)).toBeUndefined()
  })
})

describe('switch commands', () => {
  it('substitutes the model into the template', () => {
    expect(renderSwitchCommand('/model {model}', 'deepseek-v4')).toBe('/model deepseek-v4')
  })

  it('leaves a template without the placeholder unchanged', () => {
    expect(renderSwitchCommand('/model', 'deepseek-v4')).toBe('/model')
  })

  it('renders one command per candidate, in order, de-duplicating repeats', () => {
    expect(switchCommands('/model {model}', ['premium', 'standard', 'premium']))
      .toEqual(['/model premium', '/model standard'])
  })

  it('trims and collapses the template', () => {
    expect(switchCommands('  /model \n  {model}  ', ['standard'])).toEqual(['/model standard'])
  })

  it('returns no command when the CLI has no in-session switch command', () => {
    expect(switchCommands(undefined, ['standard'])).toEqual([])
    expect(switchCommands('', ['standard'])).toEqual([])
    expect(switchCommands('   ', ['standard'])).toEqual([])
  })

  it('skips a candidate that is only whitespace', () => {
    expect(switchCommands('/model {model}', ['  ', ' standard '])).toEqual(['/model standard'])
  })

  it('returns no command for an empty candidate list', () => {
    expect(switchCommands('/model {model}', [])).toEqual([])
  })

  it('skips a candidate carrying a control character so it cannot break out of the command line', () => {
    expect(switchCommands('/model {model}', ['sonnet\n!rm -rf /'])).toEqual([])
    expect(switchCommands('/model {model}', ['ok', 'bad\rname', 'worse\u001b[2J'])).toEqual(['/model ok'])
  })

  it('vets one model name for in-session substitution', () => {
    expect(isSwitchableModelName(' deepseek-v4 ')).toBe(true)
    expect(isSwitchableModelName('')).toBe(false)
    expect(isSwitchableModelName('  ')).toBe(false)
    expect(isSwitchableModelName('bad\nname')).toBe(false)
  })
})
