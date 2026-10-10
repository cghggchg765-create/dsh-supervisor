/**
 * Git operations behind checkpoints, executed as argv through the repository's
 * shell-free `runNativeCommand` runner. No command string is ever assembled, so
 * a branch name, path, or commit message cannot be re-interpreted as shell
 * syntax.
 * @module @deepseek-ai/dsh-supervisor-tasks/git
 */

import { runNativeCommand } from '@deepseek-ai/dsh-native-command'

/** Outcome of one git invocation. */
export interface GitResult {
  /** Whether git exited zero. */
  ok: boolean
  /** Exit code, or null when git died from a signal or could not be resolved. */
  exitCode: number | null
  /** Captured standard output. */
  stdout: string
  /** Captured standard error. */
  stderr: string
}

/** File statistics of one commit range. */
export interface GitDiffStat {
  /** Files added in the range. */
  filesAdded: number
  /** Files modified in the range. */
  filesModified: number
  /** Files deleted in the range. */
  filesDeleted: number
  /** Lines inserted in the range. */
  linesInserted: number
  /** Lines deleted in the range. */
  linesDeleted: number
}

/** Zero statistics, used when a range cannot be summarized. */
const EMPTY_DIFF_STAT: GitDiffStat = {
  filesAdded: 0,
  filesModified: 0,
  filesDeleted: 0,
  linesInserted: 0,
  linesDeleted: 0,
}

/**
 * Runs git commands inside one repository on behalf of the supervisor.
 */
export class GitRunner {
  /**
   * Run one git command.
   * @param cwd - directory git runs in.
   * @param args - argv after the program name.
   * @param signal - caller-owned cancellation; a run without one is unabortable.
   * @returns exit facts and captured output. A missing git executable yields `ok: false`, not a rejection.
   */
  async run(cwd: string, args: readonly string[], signal?: AbortSignal): Promise<GitResult> {
    const lifetime = signal ?? new AbortController().signal
    try {
      // `-C` is git's own directory change, so the runner needs no cwd option
      // and the path stays one argv element rather than a shell-quoted fragment.
      const { stdout, stderr } = await runNativeCommand('git', ['-C', cwd, ...args], lifetime)
      return { ok: true, exitCode: 0, stdout, stderr }
    } catch (error) {
      // Every failure mode — non-zero exit, missing executable, abort — carries
      // the same shape, so callers classify from `ok` plus stderr instead of
      // re-running the command to find out what happened. `message` is required
      // because this catch only ever sees errors the runner itself threw.
      const failure = error as { code?: unknown; stdout?: string; stderr?: string; message: string }
      return {
        ok: false,
        exitCode: typeof failure.code === 'number' ? failure.code : null,
        stdout: failure.stdout ?? '',
        stderr: failure.stderr ?? failure.message,
      }
    }
  }

  /**
   * Resolve the repository root of a directory.
   * @param cwd - directory inside the work tree.
   * @param signal - caller-owned cancellation.
   * @returns the absolute top-level path, or undefined outside a repository.
   */
  async topLevel(cwd: string, signal?: AbortSignal): Promise<string | undefined> {
    const result = await this.run(cwd, ['rev-parse', '--show-toplevel'], signal)
    const path = result.stdout.trim()
    return result.ok && path !== '' ? path : undefined
  }

  /**
   * Resolve the current commit.
   * @param cwd - repository directory.
   * @param signal - caller-owned cancellation.
   * @returns the full commit hash, or an empty string when there is no commit yet.
   */
  async head(cwd: string, signal?: AbortSignal): Promise<string> {
    const result = await this.run(cwd, ['rev-parse', 'HEAD'], signal)
    return result.ok ? result.stdout.trim() : ''
  }

  /**
   * Resolve the checked-out branch name.
   * @param cwd - repository directory.
   * @param signal - caller-owned cancellation.
   * @returns the branch name, or an empty string on a detached HEAD.
   */
  async branch(cwd: string, signal?: AbortSignal): Promise<string> {
    const result = await this.run(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'], signal)
    const name = result.ok ? result.stdout.trim() : ''
    return name === 'HEAD' ? '' : name
  }

  /**
   * Whether the work tree has staged or unstaged changes.
   * @param cwd - repository directory.
   * @param signal - caller-owned cancellation.
   * @returns true when `git status --porcelain` reported any entry.
   */
  async hasUncommitted(cwd: string, signal?: AbortSignal): Promise<boolean> {
    const result = await this.run(cwd, ['status', '--porcelain'], signal)
    return result.ok && result.stdout.trim() !== ''
  }

  /**
   * Create or reset the checkpoint branch and commit the current work tree.
   * @param repoPath - repository root.
   * @param branch - checkpoint branch to create or move.
   * @param message - commit message.
   * @param signal - caller-owned cancellation.
   * @param excludes - repo-relative directory paths to leave out of the commit,
   *   passed as exclusion pathspecs. A checkpoint must not swallow the plugin's
   *   own state directory or worktrees: a later `reset --hard` to an older
   *   checkpoint would otherwise delete newer records.
   * @returns the commit hash, or undefined when the branch or commit failed.
   */
  async commitAll(
    repoPath: string,
    branch: string,
    message: string,
    signal?: AbortSignal,
    excludes: readonly string[] = [],
  ): Promise<string | undefined> {
    const created = await this.run(repoPath, ['checkout', '-B', branch], signal)
    if (!created.ok) return undefined
    const pathspecs = excludes.map(exclude => `:(exclude)${exclude}`)
    const staged = await this.run(repoPath, ['add', '-A', ...pathspecs], signal)
    if (!staged.ok) return undefined
    const committed = await this.run(
      repoPath,
      [
        '-c', 'user.name=dsh-supervisor',
        '-c', 'user.email=supervisor@localhost',
        'commit', '--allow-empty', '-m', message,
      ],
      signal,
    )
    if (!committed.ok) return undefined
    const head = await this.head(repoPath, signal)
    return head === '' ? undefined : head
  }

  /**
   * Point a work tree at one checkpoint commit.
   * @param repoPath - repository root.
   * @param branch - checkpoint branch to check out.
   * @param commitHash - commit to reset to.
   * @param signal - caller-owned cancellation.
   * @returns true when the reset succeeded.
   */
  async resetHard(
    repoPath: string,
    branch: string,
    commitHash: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const checkedOut = await this.run(repoPath, ['checkout', '-B', branch, commitHash], signal)
    if (!checkedOut.ok) return false
    const reset = await this.run(repoPath, ['reset', '--hard', commitHash], signal)
    return reset.ok
  }

  /**
   * Read the textual diff of one commit range.
   * @param repoPath - repository root.
   * @param from - exclusive base revision.
   * @param to - inclusive head revision.
   * @param signal - caller-owned cancellation.
   * @returns the unified diff, or undefined when git refused the range.
   */
  async diff(repoPath: string, from: string, to: string, signal?: AbortSignal): Promise<string | undefined> {
    const result = await this.run(repoPath, ['diff', '--no-color', from, to], signal)
    return result.ok ? result.stdout : undefined
  }

  /**
   * Merge one branch into the checked-out branch without fast-forwarding.
   * @param repoPath - repository root.
   * @param branch - branch to merge.
   * @param signal - caller-owned cancellation.
   * @returns true when the merge committed, false on conflict or refusal.
   */
  async merge(repoPath: string, branch: string, signal?: AbortSignal): Promise<boolean> {
    const result = await this.run(
      repoPath,
      [
        '-c', 'user.name=dsh-supervisor',
        '-c', 'user.email=supervisor@localhost',
        'merge', '--no-ff', '--no-edit', branch,
      ],
      signal,
    )
    return result.ok
  }

  /**
   * Summarize one commit range.
   * @param repoPath - repository root.
   * @param from - exclusive base revision.
   * @param to - inclusive head revision.
   * @param signal - caller-owned cancellation.
   * @returns per-status file counts and line totals; all zero when the range is unknown.
   */
  async diffStat(
    repoPath: string,
    from: string,
    to: string,
    signal?: AbortSignal,
  ): Promise<GitDiffStat> {
    if (from === '' || to === '') return { ...EMPTY_DIFF_STAT }
    const result = await this.run(repoPath, ['diff', '--numstat', from, to], signal)
    if (!result.ok) return { ...EMPTY_DIFF_STAT }
    const stat: GitDiffStat = { ...EMPTY_DIFF_STAT }
    for (const line of result.stdout.split('\n')) {
      const [inserted, deleted, path] = line.split('\t')
      if (inserted === undefined || deleted === undefined || path === undefined || path === '') continue
      const added = Number.parseInt(inserted, 10)
      const removed = Number.parseInt(deleted, 10)
      if (Number.isFinite(added)) stat.linesInserted += added
      if (Number.isFinite(removed)) stat.linesDeleted += removed
      if (inserted === '0' && deleted === '0') stat.filesModified += 1
      else if (inserted === '0') stat.filesDeleted += 1
      else if (deleted === '0') stat.filesAdded += 1
      else stat.filesModified += 1
    }
    return stat
  }
}
