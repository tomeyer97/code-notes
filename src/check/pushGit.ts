// The git calls Commit & push makes from the extension host, in one place. The commit and the push themselves are the
// CLI's (commitAndPush, also used by CI); these few stay here because they read what the Check view shows (ahead of
// the upstream, which files changed) or finish what the person started in this window (a merge, a pull). No vscode
// here: unit-tested on scratch repositories (test/checkPushGit.test.ts).
import * as fs from 'fs'
import * as path from 'path'
import { gitOut, gitRaw, statusPaths } from '../platform/git'

export class PushGit {
  constructor(private readonly repo: string) {}

  private run(args: string[]): Promise<string | undefined> { return gitOut(this.repo, args, true) }

  /** The commit HEAD is at, or undefined. */
  head(): Promise<string | undefined> { return gitOut(this.repo, ['rev-parse', 'HEAD']) }

  /** Commits on HEAD its upstream doesn't have; undefined: no upstream (or git failed). */
  async ahead(): Promise<number | undefined> {
    const n = await this.run(['rev-list', '--count', '@{u}..HEAD'])
    return n === undefined || n === '' ? undefined : Number(n)
  }

  /**
   * Which of `files` (relative to the repository folder) git lists as changed or new, in one `git status`. A file not
   * on disk is never one of them.
   */
  async changed(files: readonly string[]): Promise<Set<string>> {
    const there = [...new Set(files)].filter((f) => fs.existsSync(path.join(this.repo, f)))
    if (!there.length) return new Set()
    // Paths in git's status are the repository root's; the folder may be below it.
    const [prefix, out] = await Promise.all([
      this.run(['rev-parse', '--show-prefix']),
      gitRaw(this.repo, ['status', '--porcelain=v2', '-z', '--untracked-files=all', '--', ...there]),
    ])
    if (out === undefined) return new Set()
    const listed = new Set(statusPaths(out))
    return new Set(there.filter((f) => listed.has(`${prefix ?? ''}${f}`)))
  }

  /** `file` as committed at HEAD; undefined: not there (or git failed). */
  async committed(file: string): Promise<string | undefined> {
    return (await this.run(['show', `HEAD:${file}`])) || undefined
  }

  /** A merge is in progress (MERGE_HEAD in the git dir). */
  async merging(): Promise<boolean> {
    const p = await gitOut(this.repo, ['rev-parse', '--git-path', 'MERGE_HEAD'])
    return !!p && fs.existsSync(path.resolve(this.repo, p))
  }

  /** The merge commit, with `file` (its conflict resolved) added; false when it can't be made. */
  async commitMerge(file: string): Promise<boolean> {
    await this.run(['add', '--', file])
    return (await this.run(['commit', '--no-edit', '-q'])) !== undefined
  }

  /** The files that still have conflicts. */
  async unmerged(): Promise<string[]> {
    return ((await this.run(['diff', '--name-only', '--diff-filter=U'])) ?? '').split('\n').filter(Boolean)
  }

  /** The upstream's commits merged in (no rebase, no editor); false when the pull failed. */
  async pull(): Promise<boolean> {
    return (await this.run(['pull', '--no-rebase', '--no-edit', '-q'])) !== undefined
  }
}
