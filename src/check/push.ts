// Commit & push: the check file (and what goes with it: the setup files, an applied fix, a ticked TODO) committed and
// pushed from the Check view; a merge in progress finished first; after a rejected push, Pull.
import * as vscode from 'vscode'
import * as fs from 'fs'
import * as path from 'path'
import { CommitPlan, concernOf, whoOf } from '../checkModel'
import { gitOut } from '../git'
import { PUSHED_MESSAGE_MS, REPO_FILES } from './constants'
import type { Understanding } from './index'

export class Pusher {
  /** Ahead of its upstream, or no upstream at all (undefined: not known; only read while the check is done). */
  unpushed: boolean | undefined
  /** What the last Commit & push (or Pull) said, until the branch or HEAD moves on. */
  pushed: string | undefined
  /** The commit Commit & push left HEAD at: its line goes once HEAD moves on (a pull, a merge, a commit). */
  private pushedHead: string | undefined
  /** The host's "create a merge request" link the last push printed (a branch without one). */
  mr: string | undefined
  pushing = false
  /** What Commit & push would commit (refreshed while the check is done). */
  commit: Omit<CommitPlan, 'include' | 'exclude'> | undefined
  /** The TODO files ticked to go with it. */
  readonly include = new Set<string>()
  /** Files of an applied fix the person unticked (they go with Commit & push unless unticked). */
  readonly exclude = new Set<string>()

  constructor(private u: Understanding) {}

  private get host() { return this.u.host }

  /** Another branch: what was said about the last push is not about it. */
  forgetBranch(): void {
    this.pushed = undefined
    this.mr = undefined
  }
  /** What the last Commit & push said (a rejected push, a failed commit) is stale once HEAD has moved on. */
  async forgetIfMoved(repo: string): Promise<void> {
    if (!this.pushed || this.pushed === 'Pushed.' || this.pushedHead === undefined) return
    if ((await gitOut(repo, ['rev-parse', 'HEAD'])) !== this.pushedHead) this.pushed = undefined
  }
  /** Pushed? (only while done), and what Commit & push would take (an applied fix is said on its question before the check is done, too). */
  async read(repo: string): Promise<void> {
    const st = this.u.st
    const ahead = st?.state.phase === 'done' ? await gitOut(repo, ['rev-list', '--count', '@{u}..HEAD'], true) : undefined
    this.unpushed = ahead === undefined ? undefined : ahead !== '0'
    this.commit = st?.check ? await this.toCommit() : undefined
  }
  /** A box ticked or unticked in the view: a fix goes unless unticked; a TODO only when ticked. */
  tick(file: string, on: boolean): void {
    const [set, ticked] = this.commit?.fixes?.includes(file) ? [this.exclude, !on] : [this.include, on]
    if (ticked) set.add(file)
    else set.delete(file)
  }

  /**
   * What Commit & push commits: the check file and the setup files `init` changed; `todos`: files a TODO was added to
   * from the check (uncommitted), committed only when ticked; `fold`: the repository's first check commit also adds the
   * .gitattributes line that folds check files in diffs (written on commit). Nothing else the person changed.
   */
  private async toCommit(): Promise<Omit<CommitPlan, 'include' | 'exclude'>> {
    const u = this.u, repo = u.repo!, st = u.st!
    const dirty = async (f: string) => fs.existsSync(path.join(repo, f)) && !!(await gitOut(repo, ['status', '--porcelain', '--', f], true))
    // A fix applied and not saved yet counts too (Commit & push saves it first).
    const edited = (f: string) => !!vscode.workspace.textDocuments.find((d) => d.uri.fsPath === path.join(repo, f))?.isDirty
    const files = [st.file]
    for (const f of REPO_FILES) if (await dirty(f)) files.push(f)
    const todos: string[] = []
    for (const f of u.todoFiles()) if (await dirty(f)) todos.push(f)
    // An applied fix still in the code, not committed: its file, and the questions it answers.
    const fixes: string[] = [], applied: string[] = []
    const open = (q: string) => {
      const x = st.check?.questions.find((y) => y.id === q)
      return !!x && !!concernOf(x)
    }
    for (const [q, f] of Object.entries(u.fixes.get(st.branch))) {
      if (!open(q) || !(edited(f) || await dirty(f))) continue
      if (!fixes.includes(f)) fixes.push(f)
      applied.push(q)
    }
    const fold = !files.includes('.gitattributes') && u.cli.foldMissing(repo)
    return {
      files, todos,
      ...(fixes.length ? { fixes, applied } : {}),
      ...(st.dirty && !st.untracked && await this.tourOnly() ? { tourOnly: true } : {}),
      ...(fold ? { fold, foldText: u.cli.FOLD_TEXT } : {}),
    }
  }
  /** The check file's only change since it was committed is its tour (the answers are in the commit). */
  private async tourOnly(): Promise<boolean> {
    const st = this.u.st!
    const was = await gitOut(this.u.repo!, ['show', `HEAD:${st.file}`], true)
    if (!was || !st.check) return false
    const bare = (c: Record<string, unknown>) => JSON.stringify({ ...c, journey: undefined, result: undefined, updatedAt: undefined })
    try {
      const old = JSON.parse(was)
      const tourChanged = !!st.check.journey && JSON.stringify(old.journey ?? null) !== JSON.stringify(st.check.journey)
      return tourChanged && bare(old) === bare(st.check as unknown as Record<string, unknown>)
    } catch {
      return false
    }
  }

  /** Commit & push: exactly the files named in the view (the check file, .gitattributes on the first check, ticked TODO files), then the push. */
  async commitPush(): Promise<void> {
    const u = this.u, repo = u.repo, st = u.st
    if (!repo || !st || this.pushing) return
    const { files, todos, fixes = [], fold } = await this.toCommit()
    const fixing = fixes.filter((f) => !this.exclude.has(f))
    // The repository's first check commit: the .gitattributes line that folds check files in diffs goes with it.
    if (fold && st.dirty) {
      try {
        if (u.cli.foldDiffs(repo).length) files.push('.gitattributes')
      } catch (e) {
        this.host.log.error(`understanding check: couldn't write .gitattributes: ${(e as Error).message}`)
      }
    }
    for (const f of fixing) await vscode.workspace.textDocuments.find((d) => d.uri.fsPath === path.join(repo, f) && d.isDirty)?.save()
    files.push(...todos.filter((f) => this.include.has(f) && !fixes.includes(f)), ...fixing)
    this.pushing = true
    u.post()
    try {
      this.markFixed(fixing)
      // A merge in progress (its conflict resolved here): the merge commit first; the push then takes it.
      const merging = await this.merging()
      if (merging && !(await this.finishMerge(repo, st.file))) return
      const r = await u.cli.commitAndPush(repo, files, `Understanding check: ${st.branch}`)
      this.pushed = r.line
      this.pushedHead = await gitOut(repo, ['rev-parse', 'HEAD'])
      this.mr = r.ok ? r.mr : undefined
      u.said = undefined
      // Said where the person looks (the status item may have done it): what went, and that it was pushed.
      if (r.ok) {
        const what = r.committed || merging ? `Committed ${files.map((f) => path.basename(f)).join(', ')} and pushed` : 'Pushed'
        vscode.window.setStatusBarMessage(`$(check) ${what}${r.mr ? ' · no merge request yet' : ''}`, PUSHED_MESSAGE_MS)
      }
      // The fixes committed are no longer offered.
      if (r.committed && fixing.length) {
        const left = Object.entries(u.fixes.get(st.branch)).filter(([, f]) => !fixing.includes(f))
        await u.fixes.replace(st.branch, Object.fromEntries(left))
      }
      this.host.log.info(`understanding check: commit & push: ${r.line}`)
      if (!r.ok) void vscode.window.showWarningMessage(`Code Notes: ${r.line}`)
    } finally {
      this.pushing = false
      await u.refresh()
    }
  }
  /** A concern whose fix goes in this commit (`fixing`: its files): marked fixed in the check file (off the merge request), in the same commit. */
  private markFixed(fixing: string[]): void {
    const u = this.u, abs = u.abs
    const done = Object.entries(u.fixes.get(u.st?.branch)).filter(([, f]) => fixing.includes(f)).map(([q]) => q)
    if (!done.length || !abs) return
    const check = u.cli.readCheck(abs)
    const me = u.who, at = this.host.now()
    for (const q of check.questions) {
      if (!done.includes(q.id) || !q.concern || q.concern.dismissed || q.concern.fixed) continue
      q.concern = { ...q.concern, flagged: false, fixed: { ...(me?.name || me?.email ? { by: whoOf(me) } : {}), at } }
    }
    u.save(abs, check)
  }
  /** The merge commit (the check file's conflict resolved); false, with the line that says why, when it can't be made. */
  private async finishMerge(repo: string, file: string): Promise<boolean> {
    await gitOut(repo, ['add', '--', file], true)
    if ((await gitOut(repo, ['commit', '--no-edit', '-q'], true)) !== undefined) return true
    const left = ((await gitOut(repo, ['diff', '--name-only', '--diff-filter=U'], true)) ?? '').split('\n').filter(Boolean)
    this.pushed = left.length
      ? `Finish the merge first: ${left.map((f) => path.basename(f)).join(', ')} still ${left.length === 1 ? 'has' : 'have'} conflicts.`
      : "Couldn't finish the merge: commit it yourself."
    this.pushedHead = await gitOut(repo, ['rev-parse', 'HEAD'])
    return false
  }
  /** A merge is in progress (MERGE_HEAD in the git dir). */
  private async merging(): Promise<boolean> {
    const p = await gitOut(this.u.repo!, ['rev-parse', '--git-path', 'MERGE_HEAD'])
    return !!p && fs.existsSync(path.resolve(this.u.repo!, p))
  }
  /** After a rejected push: the remote's commits merged in (a conflict in the check file is then offered to merge). */
  async pull(): Promise<void> {
    const repo = this.u.repo
    if (!repo || this.pushing) return
    this.pushing = true
    this.u.post()
    try {
      const ok = await gitOut(repo, ['pull', '--no-rebase', '--no-edit', '-q'], true) !== undefined
      this.pushed = ok || await this.merging() ? undefined : "Couldn't pull: pull in a terminal to see why."
      this.pushedHead = await gitOut(repo, ['rev-parse', 'HEAD'])
    } finally {
      this.pushing = false
      await this.u.refresh()
    }
  }
}
