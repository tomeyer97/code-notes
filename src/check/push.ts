// Commit & push: the check file (and what goes with it: the setup files, an applied fix, a ticked TODO) committed and
// pushed from the Check view; a merge in progress finished first; after a rejected push, Pull. The commit and the push
// are the CLI's (commitAndPush); the other git calls are pushGit.ts's.
import * as vscode from 'vscode'
import * as path from 'path'
import { concernOf, settledConcern } from './concernState'
import { checkOfText, onlyTourChanged } from './checkText'
import { unsavedIn } from './unsaved'
import type { CommitPlan } from './viewModel'
import { PUSHED_MESSAGE_MS, REPO_FILES } from './constants'
import type { CheckHost } from './host'
import { PushGit } from './pushGit'
import { type CheckCore, updateCheck } from './state'
import type { PushResult } from './types'
import { fireAndForget, showError } from '../platform/run'

/** What Commit & push needs: the check's core and the time. */
export interface PusherPorts extends CheckCore {
  host: Pick<CheckHost, 'now'>
}

/** What Commit & push takes (refreshed while the check is done). */
export type Plan = Omit<CommitPlan, 'include' | 'exclude'>

/**
 * What the last Commit & push (or Pull) did, and its line for the view: pushed (said until another branch), or
 * stopped (said until HEAD moves on from `head`).
 */
type Outcome = { kind: 'pushed'; line: string } | { kind: 'stopped'; line: string; head: string | undefined }

/** The files of a commit, as the status bar names them. */
const names = (files: string[]) => files.map((f) => path.basename(f)).join(', ')

export class Pusher {
  /** Ahead of its upstream, or no upstream at all (undefined: not known; only read while the check is done). */
  unpushed: boolean | undefined
  private last: Outcome | undefined
  /** The host's "create a merge request" link the last push printed (a branch without one). */
  mr: string | undefined
  pushing = false
  /** What Commit & push would commit (refreshed while the check is done). */
  commit: Plan | undefined
  /** The TODO files ticked to go with it. */
  readonly include = new Set<string>()
  /** Files of an applied fix the person unticked (they go with Commit & push unless unticked). */
  readonly exclude = new Set<string>()

  constructor(private ports: PusherPorts) {}

  /** What the last Commit & push (or Pull) said, until the branch (or, when it stopped, HEAD) moves on. */
  get pushed(): string | undefined { return this.last?.line }

  private git(): PushGit { return new PushGit(this.ports.state.repo!) }

  /** Another branch: what was said about the last push is not about it. */
  forgetBranch(): void {
    this.last = undefined
    this.mr = undefined
  }
  /** What a Commit & push that stopped said (a rejected push, a failed commit) is stale once HEAD has moved on. */
  async forgetIfMoved(repo: string): Promise<void> {
    const last = this.last
    if (last?.kind !== 'stopped' || last.head === undefined) return
    if ((await new PushGit(repo).head()) !== last.head) this.last = undefined
  }
  /**
   * Pushed? (only while done), and what Commit & push would take (an applied fix is said on its question before the
   * check is done, too).
   */
  async read(repo: string): Promise<void> {
    const st = this.ports.state.st
    const ahead = st?.state.phase === 'done' ? await new PushGit(repo).ahead() : undefined
    this.unpushed = ahead === undefined ? undefined : ahead !== 0
    this.commit = st?.check ? await this.plan() : undefined
  }
  /** A box ticked or unticked in the view: a fix goes unless unticked; a TODO only when ticked. */
  tick(file: string, on: boolean): void {
    const [set, ticked] = this.commit?.fixes?.includes(file) ? [this.exclude, !on] : [this.include, on]
    if (ticked) set.add(file)
    else set.delete(file)
  }

  /**
   * What Commit & push commits: the check file and the setup files `init` changed; `todos`: files a TODO was added to
   * from the check (uncommitted), committed only when ticked; `fixes`: an applied fix still in the code, not committed
   * (`applied`: the questions it answers); `fold`: the repository's first check commit also adds the .gitattributes line
   * that folds check files in diffs (written on commit). Nothing else the person changed.
   */
  private async plan(): Promise<Plan> {
    const { state, cli } = this.ports, repo = state.repo!, st = state.st!
    const fixFiles = Object.entries(state.fixes.get(st.branch))
    // Changed on disk: git lists it as changed (or new). One git status for every file the plan may name.
    const changed = await this.git().changed([...REPO_FILES, ...state.todoFiles(), ...fixFiles.map(([, f]) => f)])
    const plan: Plan = {
      files: [st.file, ...REPO_FILES.filter((f) => changed.has(f))],
      todos: state.todoFiles().filter((f) => changed.has(f)),
    }
    // A fix applied and not saved yet counts too (Commit & push saves it first).
    const pending = (f: string) => !!unsavedIn(vscode.workspace.textDocuments, repo, f) || changed.has(f)
    const stillOpen = (qid: string) => {
      const q = st.check?.questions.find((x) => x.id === qid)
      return !!q && !!concernOf(q)
    }
    const applied = fixFiles.filter(([q, f]) => stillOpen(q) && pending(f))
    if (applied.length) {
      plan.fixes = [...new Set(applied.map(([, f]) => f))]
      plan.applied = applied.map(([q]) => q)
    }
    if (st.dirty && !st.untracked && await this.tourOnly()) plan.tourOnly = true
    if (!plan.files.includes('.gitattributes') && cli.foldMissing(repo)) {
      plan.fold = true
      plan.foldText = cli.FOLD_TEXT
    }
    return plan
  }
  /** The check file's only change since it was committed is its tour (the answers are in the commit). */
  private async tourOnly(): Promise<boolean> {
    const st = this.ports.state.st!
    const text = st.check && await this.git().committed(st.file)
    const was = text ? checkOfText(text) : undefined
    return !!was && onlyTourChanged(was, st.check!)
  }

  /**
   * Commit & push: exactly the files named in the view (the check file, .gitattributes on the first check, ticked TODO
   * files), then the push.
   */
  async commitPush(): Promise<void> {
    const { state } = this.ports, repo = state.repo, st = state.st
    if (!repo || !st || this.pushing) return
    const { files, fixing } = await this.prepareCommit()
    this.pushing = true
    this.ports.post()
    try {
      this.markFixed(fixing)
      // A merge in progress (its conflict resolved here): the merge commit first; the push then takes it.
      const merging = await this.git().merging()
      if (merging && !(await this.finishMerge(st.file))) return
      const r = await this.ports.cli.commitAndPush(repo, files, `Understanding check: ${st.branch}`)
      await this.afterPush(r, { files, fixing, merged: merging })
    } finally {
      this.pushing = false
      await this.ports.refresh()
    }
  }

  /**
   * The files Commit & push commits (the plan's, the .gitattributes line on the first check, the ticked TODO files,
   * the fixes not unticked, saved first); `fixing`: the fixes' files.
   */
  private async prepareCommit(): Promise<{ files: string[]; fixing: string[] }> {
    const repo = this.ports.state.repo!, st = this.ports.state.st!
    const { files, todos, fixes = [], fold } = await this.plan()
    const fixing = fixes.filter((f) => !this.exclude.has(f))
    // The repository's first check commit: the .gitattributes line that folds check files in diffs goes with it.
    if (fold && st.dirty && this.writeFold(repo)) files.push('.gitattributes')
    // The fixes it takes are saved first; with them go the TODO files ticked (a fix's file goes as a fix).
    for (const f of fixing) await unsavedIn(vscode.workspace.textDocuments, repo, f)?.save()
    const ticked = todos.filter((f) => this.include.has(f) && !fixes.includes(f))
    return { files: [...files, ...ticked, ...fixing], fixing }
  }
  /** The .gitattributes line that folds check files in diffs; false when nothing was written. */
  private writeFold(repo: string): boolean {
    try {
      return this.ports.cli.foldDiffs(repo).length > 0
    } catch (e) {
      this.ports.log.error(`couldn't write .gitattributes: ${(e as Error).message}`)
      return false
    }
  }

  /** What a commit and push did, said: in the view, the status bar and the log; the fixes it committed forgotten. */
  private async afterPush(r: PushResult, o: { files: string[]; fixing: string[]; merged: boolean }): Promise<void> {
    const { state } = this.ports, st = state.st!
    await this.settle(r.pushed ? { kind: 'pushed', line: r.line } : { kind: 'stopped', line: r.line })
    this.mr = r.ok ? r.mr : undefined
    state.say(undefined)
    // Said where the person looks (the status item may have done it): what went, and that it was pushed.
    if (r.ok) {
      const what = r.committed || o.merged ? `Committed ${names(o.files)} and pushed` : 'Pushed'
      const noMr = r.mr ? ' · no merge request yet' : ''
      vscode.window.setStatusBarMessage(`$(check) ${what}${noMr}`, PUSHED_MESSAGE_MS)
    }
    // The fixes committed are no longer offered.
    if (r.committed && o.fixing.length) {
      const left = Object.entries(state.fixes.get(st.branch)).filter(([, f]) => !o.fixing.includes(f))
      await state.fixes.replace(st.branch, Object.fromEntries(left))
    }
    this.ports.log.info(`commit & push: ${r.line}`)
    if (!r.ok) fireAndForget(showError(r.line), 'push: showError')
  }

  /**
   * A concern whose fix goes in this commit (`fixing`: its files): marked fixed in the check file (off the merge
   * request), in the same commit.
   */
  private markFixed(fixing: string[]): void {
    const { state } = this.ports
    const fixes = Object.entries(state.fixes.get(state.st?.branch))
    const done = new Set(fixes.filter(([, f]) => fixing.includes(f)).map(([q]) => q))
    if (!done.size) return
    const at = this.ports.host.now()
    updateCheck(this.ports, (check) => {
      for (const q of check.questions) {
        if (!done.has(q.id) || !q.concern || q.concern.dismissed || q.concern.fixed) continue
        q.concern = settledConcern(q.concern, q.concern.text, { fixed: true }, state.who, at)
      }
    })
  }
  /** The merge commit (the check file's conflict resolved); false, with the line that says why, when it can't be made. */
  private async finishMerge(file: string): Promise<boolean> {
    const git = this.git()
    if (await git.commitMerge(file)) return true
    const left = await git.unmerged()
    const line = left.length
      ? `Finish the merge first: ${names(left)} still ${left.length === 1 ? 'has' : 'have'} conflicts.`
      : "Couldn't finish the merge: commit it yourself."
    await this.settle({ kind: 'stopped', line })
    return false
  }
  /** What Commit & push (or Pull) did (undefined: nothing to say); a stop is said until HEAD moves on. */
  private async settle(o: { kind: 'pushed'; line: string } | { kind: 'stopped'; line: string } | undefined): Promise<void> {
    const head = await this.git().head()
    this.last = o?.kind === 'stopped' ? { ...o, head } : o
  }
  /** After a rejected push: the remote's commits merged in (a conflict in the check file is then offered to merge). */
  async pull(): Promise<void> {
    const repo = this.ports.state.repo
    if (!repo || this.pushing) return
    this.pushing = true
    this.ports.post()
    try {
      const git = new PushGit(repo)
      const ok = (await git.pull()) || (await git.merging())
      await this.settle(ok ? undefined : { kind: 'stopped', line: "Couldn't pull: pull in a terminal to see why." })
    } finally {
      this.pushing = false
      await this.ports.refresh()
    }
  }
}

/**
 * The open document of `repo`'s file `f` that has unsaved edits (an applied fix edited again), if any.
 * @deprecated Call unsavedIn (unsaved.ts) with vscode.workspace.textDocuments; kept while the controller imports it.
 */
export function unsavedDocument(repo: string, f: string): vscode.TextDocument | undefined {
  return unsavedIn(vscode.workspace.textDocuments, repo, f)
}
