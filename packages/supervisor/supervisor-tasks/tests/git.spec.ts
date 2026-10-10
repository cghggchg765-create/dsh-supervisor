import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GitRunner, type GitResult } from '../src/git.ts'

let repo = ''

/** Whether a usable git executable is on PATH for this environment. */
async function gitAvailable(): Promise<boolean> {
  const runner = new GitRunner()
  const probe = await runner.run(process.cwd(), ['--version'])
  return probe.ok
}

const execGit = promisify(execFile)

/**
 * Run one real git command for fixture setup. The author and committer
 * identities are supplied here so setup does not depend on the host's git
 * configuration or on the class under test.
 */
async function setupGit(cwd: string, args: readonly string[]): Promise<void> {
  await execGit('git', ['-C', cwd, ...args], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'dsh-supervisor-test',
      GIT_AUTHOR_EMAIL: 'supervisor@localhost',
      GIT_COMMITTER_NAME: 'dsh-supervisor-test',
      GIT_COMMITTER_EMAIL: 'supervisor@localhost',
    },
  })
}

/** Zero statistics for a range that cannot be summarized. */
const NO_DIFF_STAT = {
  filesAdded: 0,
  filesModified: 0,
  filesDeleted: 0,
  linesInserted: 0,
  linesDeleted: 0,
}

const hasGit = await gitAvailable()

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'dsh-supervisor-repo-'))
})

afterEach(async () => {
  await rm(repo, { recursive: true, force: true })
})

describe('git operations', () => {
  it.skipIf(!hasGit)('recognizes a work tree and reports its branch and head', async () => {
    const runner = new GitRunner()
    expect(await runner.topLevel(repo)).toBeUndefined()
    expect(await runner.run(repo, ['init'])).toMatchObject({ ok: true })
    expect(await runner.topLevel(repo)).toBeDefined()
    expect(await runner.head(repo)).toBe('')
  })

  it.skipIf(!hasGit)('commits the work tree on a checkpoint branch and restores it', async () => {
    const runner = new GitRunner()
    await runner.run(repo, ['init'])
    const file = join(repo, 'work.txt')
    await writeFile(file, 'first\n', 'utf8')
    const firstCommit = await runner.commitAll(repo, 'supervisor/task-a', 'checkpoint: task-a@step-0')
    expect(firstCommit).toMatch(/^[0-9a-f]{7,}$/)
    expect(await runner.branch(repo)).toBe('supervisor/task-a')

    await writeFile(file, 'second\n', 'utf8')
    const secondCommit = await runner.commitAll(repo, 'supervisor/task-a', 'checkpoint: task-a@step-1')
    expect(secondCommit).not.toBe(firstCommit)
    const stat = await runner.diffStat(repo, firstCommit ?? '', secondCommit ?? '')
    expect(stat.filesModified).toBe(1)
    expect(stat.linesInserted).toBe(1)

    expect(await runner.resetHard(repo, 'supervisor/task-a', firstCommit ?? '')).toBe(true)
    // Checkout may rewrite line endings per the host's core.autocrlf setting.
    expect((await readFile(file, 'utf8')).replaceAll('\r\n', '\n')).toBe('first\n')
  })

  it.skipIf(!hasGit)('reports uncommitted work before it is committed', async () => {
    const runner = new GitRunner()
    await runner.run(repo, ['init'])
    await writeFile(join(repo, 'dirty.txt'), 'x\n', 'utf8')
    expect(await runner.hasUncommitted(repo)).toBe(true)
    await runner.commitAll(repo, 'supervisor/task-a', 'checkpoint')
    expect(await runner.hasUncommitted(repo)).toBe(false)
  })

  it.skipIf(!hasGit)('reports a failing command as a result rather than a rejection', async () => {
    const runner = new GitRunner()
    await runner.run(repo, ['init'])
    const result = await runner.run(repo, ['rev-parse', 'HEAD'])
    expect(result.ok).toBe(false)
    expect(result.exitCode).not.toBe(0)
  })

  it('reports a missing git executable as a failed result', async () => {
    const runner = new GitRunner()
    const result = await runner.run(repo, ['--version'], AbortSignal.abort())
    expect(result.ok).toBe(false)
  })

  it.skipIf(!hasGit)('reports no repository facts outside a work tree', async () => {
    const runner = new GitRunner()
    expect(await runner.topLevel(repo)).toBeUndefined()
    expect(await runner.branch(repo)).toBe('')
    expect(await runner.head(repo)).toBe('')
  })

  it.skipIf(!hasGit)('reports an empty branch on a detached HEAD', async () => {
    const runner = new GitRunner()
    await runner.run(repo, ['init'])
    await writeFile(join(repo, 'work.txt'), 'first\n', 'utf8')
    await setupGit(repo, ['add', '-A'])
    await setupGit(repo, ['commit', '-m', 'base'])
    await setupGit(repo, ['checkout', '--detach'])
    expect(await runner.branch(repo)).toBe('')
    expect(await runner.head(repo)).toMatch(/^[0-9a-f]{7,}$/)
  })

  it.skipIf(!hasGit)('fails the reset when the commit is unknown', async () => {
    const runner = new GitRunner()
    await runner.run(repo, ['init'])
    await writeFile(join(repo, 'work.txt'), 'first\n', 'utf8')
    await setupGit(repo, ['add', '-A'])
    await setupGit(repo, ['commit', '-m', 'base'])
    expect(await runner.resetHard(repo, 'supervisor/task-a', '0123456789abcdef0123456789abcdef01234567')).toBe(false)
  })

  it.skipIf(!hasGit)('summarizes an empty or unknown range as zero statistics', async () => {
    const runner = new GitRunner()
    expect(await runner.diffStat(repo, '', 'HEAD')).toEqual(NO_DIFF_STAT)
    expect(await runner.diffStat(repo, 'HEAD', '')).toEqual(NO_DIFF_STAT)
    await runner.run(repo, ['init'])
    await writeFile(join(repo, 'work.txt'), 'first\n', 'utf8')
    await setupGit(repo, ['add', '-A'])
    await setupGit(repo, ['commit', '-m', 'base'])
    expect(await runner.diffStat(repo, 'not-a-revision', 'HEAD')).toEqual(NO_DIFF_STAT)
  })

  it.skipIf(!hasGit)('reads a commit-range diff and reports a refused range as no diff', async () => {
    const runner = new GitRunner()
    await runner.run(repo, ['init'])
    await writeFile(join(repo, 'work.txt'), 'first\n', 'utf8')
    await setupGit(repo, ['add', '-A'])
    await setupGit(repo, ['commit', '-m', 'base'])
    const base = await runner.head(repo)
    await writeFile(join(repo, 'work.txt'), 'second\n', 'utf8')
    await setupGit(repo, ['commit', '-am', 'second'])
    const head = await runner.head(repo)

    const text = await runner.diff(repo, base, head)
    expect(text).toContain('-first')
    expect(text).toContain('+second')
    // An unresolvable range is refused rather than answered with an empty diff.
    expect(await runner.diff(repo, 'not-a-revision', head)).toBeUndefined()
  })

  it.skipIf(!hasGit)('merges a diverging branch without fast-forwarding and reports a conflict', async () => {
    const runner = new GitRunner()
    await runner.run(repo, ['init'])
    await writeFile(join(repo, 'work.txt'), 'base\n', 'utf8')
    await setupGit(repo, ['add', '-A'])
    await setupGit(repo, ['commit', '-m', 'base'])
    const trunk = await runner.branch(repo)

    await setupGit(repo, ['checkout', '-b', 'supervisor/feature'])
    await writeFile(join(repo, 'feature.txt'), 'feature\n', 'utf8')
    await setupGit(repo, ['add', '-A'])
    await setupGit(repo, ['commit', '-m', 'feature'])
    await setupGit(repo, ['checkout', trunk])
    expect(await runner.merge(repo, 'supervisor/feature')).toBe(true)
    // Checkout may rewrite line endings per the host's core.autocrlf setting.
    expect((await readFile(join(repo, 'feature.txt'), 'utf8')).replaceAll('\r\n', '\n')).toBe('feature\n')

    await setupGit(repo, ['checkout', '-b', 'supervisor/conflict'])
    await writeFile(join(repo, 'work.txt'), 'branch\n', 'utf8')
    await setupGit(repo, ['commit', '-am', 'branch'])
    await setupGit(repo, ['checkout', trunk])
    await writeFile(join(repo, 'work.txt'), 'trunk\n', 'utf8')
    await setupGit(repo, ['commit', '-am', 'trunk'])
    expect(await runner.merge(repo, 'supervisor/conflict')).toBe(false)
  })

  it.skipIf(!hasGit)('summarizes added, modified, deleted, empty, and binary files', async () => {
    const runner = new GitRunner()
    await runner.run(repo, ['init'])
    await writeFile(join(repo, 'modified.txt'), 'one\ntwo\n', 'utf8')
    await writeFile(join(repo, 'deleted.txt'), 'gone\n', 'utf8')
    await writeFile(join(repo, 'binary.bin'), 'binary\u0000payload', 'utf8')
    await setupGit(repo, ['add', '-A'])
    await setupGit(repo, ['commit', '-m', 'base'])
    const base = await runner.head(repo)
    expect(base).not.toBe('')

    await writeFile(join(repo, 'modified.txt'), 'one\nTWO\n', 'utf8')
    await writeFile(join(repo, 'added.txt'), 'added\n', 'utf8')
    await writeFile(join(repo, 'empty.txt'), '', 'utf8')
    await writeFile(join(repo, 'binary.bin'), 'binary\u0000changed', 'utf8')
    await rm(join(repo, 'deleted.txt'))
    await setupGit(repo, ['add', '-A'])
    await setupGit(repo, ['commit', '-m', 'second'])

    expect(await runner.diffStat(repo, base, await runner.head(repo))).toEqual({
      filesAdded: 1,
      filesModified: 3,
      filesDeleted: 1,
      linesInserted: 2,
      linesDeleted: 2,
    })
  })
})

describe('git result classification', () => {
  const OK: GitResult = { ok: true, exitCode: 0, stdout: '', stderr: '' }
  const FAILED: GitResult = { ok: false, exitCode: 1, stdout: '', stderr: 'scripted failure' }

  /** A runner whose git invocations answer from a script instead of spawning git. */
  function scripted(answers: (args: readonly string[]) => GitResult): GitRunner {
    const runner = new GitRunner()
    runner.run = async (_cwd, args) => answers(args)
    return runner
  }

  it('reports a command that never spawned as a failed result', async () => {
    const runner = new GitRunner()
    const result = await runner.run('bad\u0000path', ['--version'])
    expect(result).toMatchObject({ ok: false, exitCode: null, stdout: '' })
    expect(result.stderr).toContain('null bytes')
  })

  it('returns no checkpoint when the checkpoint branch cannot be created', async () => {
    const runner = scripted(args => args[0] === 'checkout' ? FAILED : OK)
    expect(await runner.commitAll(repo, 'supervisor/task-a', 'checkpoint: task-a@step-0')).toBeUndefined()
  })

  it('returns no checkpoint when staging the work tree fails', async () => {
    const runner = scripted(args => args[0] === 'add' ? FAILED : OK)
    expect(await runner.commitAll(repo, 'supervisor/task-a', 'checkpoint: task-a@step-0')).toBeUndefined()
  })

  it('returns no checkpoint when the commit fails', async () => {
    const runner = scripted(args => args.includes('commit') ? FAILED : OK)
    expect(await runner.commitAll(repo, 'supervisor/task-a', 'checkpoint: task-a@step-0')).toBeUndefined()
  })

  it('returns no checkpoint when the commit leaves HEAD unresolved', async () => {
    // Every invocation exits zero, but `rev-parse HEAD` reports no commit to pin.
    const runner = scripted(() => OK)
    expect(await runner.commitAll(repo, 'supervisor/task-a', 'checkpoint: task-a@step-0')).toBeUndefined()
  })

  it('skips numstat rows that carry no path', async () => {
    const runner = scripted(() => ({
      ok: true,
      exitCode: 0,
      stdout: ['1\t1\t', '3\t0\tadded.txt', 'not a numstat row', '1\t2'].join('\n'),
      stderr: '',
    }))
    // A row that names no file contributes nothing, lines included: its numbers
    // describe no file the caller could act on.
    expect(await runner.diffStat(repo, 'base', 'head')).toEqual({
      filesAdded: 1,
      filesModified: 0,
      filesDeleted: 0,
      linesInserted: 3,
      linesDeleted: 0,
    })
  })
})
