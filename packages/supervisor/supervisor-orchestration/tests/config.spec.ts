/**
 * This package's configuration resolver: defaults taken from the mounted
 * control plane, explicit values resolved to absolute paths, and the
 * validation that refuses an unusable value before the plugin loads.
 */

import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveOrchestrationConfig } from '../src/config.ts'

/** Resolved core paths a mount would supply. */
const core = { workspaceDir: '/workspace', worktreeBase: '/workspace/.worktrees' }

describe('resolveOrchestrationConfig', () => {
  it('takes the paths the control plane owns and defaults the rest', () => {
    const settings = resolveOrchestrationConfig({}, core)
    expect(settings).toEqual({
      modelRules: [],
      skillRoots: { homeDir: homedir(), workspaceDir: resolve('/workspace', '.') },
      worktreeBase: '/workspace/.worktrees',
      worktreeBranchPrefix: 'supervisor/',
      maxConcurrency: 4,
    })
  })

  it('resolves a relative skill workspace against the control plane workspace', () => {
    const settings = resolveOrchestrationConfig({
      modelRules: [{ phases: ['coding'], model: 'standard', fallbackModels: ['cheap'] }],
      skillRoots: { homeDir: '/home/operator', workspaceDir: 'skills' },
      worktreeBranchPrefix: 'checkpoint/',
      maxConcurrency: 2,
    }, core)
    expect(settings.modelRules).toEqual([{ phases: ['coding'], models: ['standard', 'cheap'] }])
    expect(settings.skillRoots).toEqual({ homeDir: '/home/operator', workspaceDir: resolve('/workspace', 'skills') })
    expect(settings.worktreeBranchPrefix).toBe('checkpoint/')
    expect(settings.maxConcurrency).toBe(2)
  })

  it('refuses a concurrency that could never start a subtask', () => {
    expect(() => resolveOrchestrationConfig({ maxConcurrency: 0 }, core))
      .toThrow('supervisor configuration field "maxConcurrency" must be a positive number')
    expect(() => resolveOrchestrationConfig({ maxConcurrency: Number.NaN }, core))
      .toThrow('supervisor configuration field "maxConcurrency" must be a positive number')
  })

  it('refuses a model rule the phase table cannot resolve', () => {
    expect(() => resolveOrchestrationConfig({
      modelRules: [{ phases: ['refactoring' as never], model: 'standard', fallbackModels: [] }],
    }, core)).toThrow('supervisor model rule names unknown task phase "refactoring"')
  })
})
