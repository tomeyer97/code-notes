// Commit & push: the check file (and what goes with it: the setup files, an applied fix, a ticked TODO) committed and
// pushed from the Check view; a merge in progress finished first; after a rejected push, Pull.
import * as vscode from 'vscode'
import * as fs from 'fs'
import * as path from 'path'
import { concernOf, settledConcern } from './concernState'
import { CommitPlan } from './viewModel'
import { gitOut } from '../git'
import { PUSHED_MESSAGE_MS, REPO_FILES } from './constants'
import type { CheckController } from './controller'

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

  constructor(private ctl: CheckController) {}

  private get host() { return this.ctl.host }

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
    const st = this.ctl.st
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
    const ctl = this.ctl, repo = ctl.repo!, st = ctl.st!
    // Changed on disk: git lists it as changed (or new).
    const changedInGit = async (f: string) => {
      return fs.existsSync(path.join(repo, f)) && !!(await gitOut(repo, ['status', '--porcelain', '--', f], true))
    }
    // A fix applied and not saved yet counts too (Commit & push saves it first). Here the first open document of the
    // file decides (unsavedDocument looks for an unsaved one among them).
    const unsavedInEditor = (f: string) => !!vscode.workspace.textDocuments.find((d) => d.uri.fsPath === path.join(repo, f))?.isDirty
    const files = [st.file]
    for (const f of REPO_FILES) if (await changedInGit(f)) files.push(f)
    const todos: string[] = []
    for (const f of ctl.todoFiles()) if (await changedInGit(f)) todos.push(f)
    // An applied fix still in the code, not committed: its file, and the questions it answers.
    const fixes: string[] = [], applied: string[] = []
    const open = (q: string) => {
      const x = st.check?.questions.find((y) => y.id === q)
      return !!x && !!concernOf(x)
    }
    for (const [q, f] of Object.entries(ctl.fixes.get(st.branch))) {
      if (!open(q) || !(unsavedInEditor(f) || await changedInGit(f))) continue
      if (!fixes.includes(f)) fixes.push(f)
      applied.push(q)
    }
    const fold = !files.includes('.gitattributes') && ctl.cli.foldMissing(repo)
    return {
      files, todos,
      ...(fixes.length ? { fixes, applied } : {}),
      ...(st.dirty && !st.untracked && await this.tourOnly() ? { tourOnly: true } : {}),
      ...(fold ? { fold, foldText: ctl.cli.FOLD_TEXT } : {}),
    }
  }
  /** The check file's only change since it was committed is its tour (the answers are in the commit). */
  private async tourOnly(): Promise<boolean> {
    const st = this.ctl.st!
    const was = await gitOut(this.ctl.repo!, ['show', `HEAD:${st.file}`], true)
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
    const ctl = this.ctl, repo = ctl.repo, st = ctl.st
    if (!repo || !st || this.pushing) return
    const { files, todos, fixes = [], fold } = await this.toCommit()
    const fixing = fixes.filter((f) => !this.exclude.has(f))
    // The repository's first check commit: the .gitattributes line that folds check files in diffs goes with it.
    if (fold && st.dirty) {
      try {
        if (ctl.cli.foldDiffs(repo).length) files.push('.gitattributes')
      } catch (e) {
        this.ctl.log.error(`couldn't write .gitattributes: ${(e as Error).message}`)
      }
    }
    // The fixes it takes are saved first; with them go the TODO files ticked (a fix's file goes as a fix).
    for (const f of fixing) await unsavedDocument(repo, f)?.save()
    const ticked = todos.filter((f) => this.include.has(f) && !fixes.includes(f))
    files.push(...ticked, ...fixing)
    this.pushing = true
    ctl.post()
    try {
      this.markFixed(fixing)
      // A merge in progress (its conflict resolved here): the merge commit first; the push then takes it.
      const merging = await this.merging()
      if (merging && !(await this.finishMerge(repo, st.file))) return
      const r = await ctl.cli.commitAndPush(repo, files, `Understanding check: ${st.branch}`)
      await this.said(repo, r.line)
      this.mr = r.ok ? r.mr : undefined
      ctl.said = undefined
      // Said where the person looks (the status item may have done it): what went, and that it was pushed.
      if (r.ok) {
        const what = r.committed || merging ? `Committed ${files.map((f) => path.basename(f)).join(', ')} and pushed` : 'Pushed'
        vscode.window.setStatusBarMessage(`$(check) ${what}${r.mr ? ' · no merge request yet' : ''}`, PUSHED_MESSAGE_MS)
      }
      // The fixes committed are no longer offered.
      if (r.committed && fixing.length) {
        const left = Object.entries(ctl.fixes.get(st.branch)).filter(([, f]) => !fixing.includes(f))
        await ctl.fixes.replace(st.branch, Object.fromEntries(left))
      }
      this.ctl.log.info(`commit & push: ${r.line}`)
      if (!r.ok) void vscode.window.showWarningMessage(`Code Notes: ${r.line}`)
    } finally {
      this.pushing = false
      await ctl.refresh()
    }
  }
  /** A concern whose fix goes in this commit (`fixing`: its files): marked fixed in the check file (off the merge request), in the same commit. */
  private markFixed(fixing: string[]): void {
    const ctl = this.ctl, abs = ctl.abs
    const done = Object.entries(ctl.fixes.get(ctl.st?.branch)).filter(([, f]) => fixing.includes(f)).map(([q]) => q)
    if (!done.length || !abs) return
    const check = ctl.cli.readCheck(abs)
    const at = this.host.now()
    for (const q of check.questions) {
      if (!done.includes(q.id) || !q.concern || q.concern.dismissed || q.concern.fixed) continue
      q.concern = settledConcern(q.concern, q.concern.text, { fixed: true }, ctl.who, at)
    }
    ctl.save(abs, check)
  }
  /** The merge commit (the check file's conflict resolved); false, with the line that says why, when it can't be made. */
  private async finishMerge(repo: string, file: string): Promise<boolean> {
    await gitOut(repo, ['add', '--', file], true)
    if ((await gitOut(repo, ['commit', '--no-edit', '-q'], true)) !== undefined) return true
    const left = ((await gitOut(repo, ['diff', '--name-only', '--diff-filter=U'], true)) ?? '').split('\n').filter(Boolean)
    const names = left.map((f) => path.basename(f)).join(', ')
    await this.said(repo, left.length
      ? `Finish the merge first: ${names} still ${left.length === 1 ? 'has' : 'have'} conflicts.`
      : "Couldn't finish the merge: commit it yourself.")
    return false
  }
  /** What Commit & push (or Pull) says (`line`), and the commit it left HEAD at: the line goes once HEAD moves on. */
  private async said(repo: string, line: string | undefined): Promise<void> {
    this.pushed = line
    this.pushedHead = await gitOut(repo, ['rev-parse', 'HEAD'])
  }
  /** A merge is in progress (MERGE_HEAD in the git dir). */
  private async merging(): Promise<boolean> {
    const p = await gitOut(this.ctl.repo!, ['rev-parse', '--git-path', 'MERGE_HEAD'])
    return !!p && fs.existsSync(path.resolve(this.ctl.repo!, p))
  }
  /** After a rejected push: the remote's commits merged in (a conflict in the check file is then offered to merge). */
  async pull(): Promise<void> {
    const repo = this.ctl.repo
    if (!repo || this.pushing) return
    this.pushing = true
    this.ctl.post()
    try {
      const ok = await gitOut(repo, ['pull', '--no-rebase', '--no-edit', '-q'], true) !== undefined
      await this.said(repo, ok || await this.merging() ? undefined : "Couldn't pull: pull in a terminal to see why.")
    } finally {
      this.pushing = false
      await this.ctl.refresh()
    }
  }
}

/** The open document of `repo`'s file `f` that has unsaved edits (an applied fix edited again), if any. */
export function unsavedDocument(repo: string, f: string): vscode.TextDocument | undefined {
  return vscode.workspace.textDocuments.find((d) => d.uri.fsPath === path.join(repo, f) && d.isDirty)
}
