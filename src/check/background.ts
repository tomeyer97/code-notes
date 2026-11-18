// Background questions: when a branch is pushed (it has an upstream and nothing left to push, after it had something
// or no upstream), has code changes and no check, and is not a default branch, its questions are written quietly. One
// run at a time; never twice for the same commit. Setting codeNotes.understanding.background (BACKGROUND_SETTING).
import * as vscode from 'vscode'
import * as path from 'path'
import { BACKGROUND_SETTING, BG_COMMITS_KEPT, BG_KEY, REFRESH_SOON_MS } from './constants'
import type { CheckController } from './controller'
import type { GitApi, GitRepo } from './host'

export class BackgroundQuestions implements vscode.Disposable {
  /** What the push watcher saw last (integration test). */
  trace: string[] = []
  private subs: vscode.Disposable[] = []

  constructor(private ctl: CheckController) {}

  /** Follows VS Code's git extension: each push of this folder's repository. */
  watchPushes(): void {
    const git = vscode.extensions.getExtension<{ getAPI(v: 1): GitApi }>('vscode.git')
    if (!git) { this.trace.push('no git extension'); return }
    const hook = (api: GitApi) => {
      this.trace.push(`git api: ${api.repositories.length} repositories`)
      api.repositories.forEach((r) => this.watchRepo(r))
      this.subs.push(api.onDidOpenRepository((r) => this.watchRepo(r)))
    }
    if (git.isActive) hook(git.exports.getAPI(1))
    else void git.activate().then((e) => hook(e.getAPI(1)), () => undefined)
  }

  /** A repository of VS Code's Git view: this folder's is followed (per branch: pushed as last seen). */
  private watchRepo(r: GitRepo): void {
    const folder = this.ctl.folder
    if (!folder || path.resolve(r.rootUri.fsPath) !== path.resolve(folder.uri.fsPath)) return
    // A branch first seen already pushed (a checkout) starts nothing.
    const was = new Map<string, boolean>()
    this.subs.push(r.state.onDidChange(() => this.onRepoChange(r, was)))
  }

  /** The Git view read the repository again (a file changed, a commit, a checkout, a push). */
  private onRepoChange(r: GitRepo, was: Map<string, boolean>): void {
    // Whatever the check shows follows, if it changed (gated: nothing is read again otherwise).
    this.ctl.refreshSoon(REFRESH_SOON_MS, false)
    const h = r.state.HEAD
    if (!h?.name) return
    const pushed = !!h.upstream && h.ahead === 0
    const before = was.get(h.name)
    was.set(h.name, pushed)
    const seen = `${h.name} ${pushed ? 'pushed' : 'unpushed'}${before === undefined ? ' (new)' : ''}`
    this.trace = [...this.trace.slice(-9), seen]
    if (pushed && before === false) void this.pushed(h.name, h.commit)
  }

  /** `branch` was just pushed at `commit`: its questions, if it needs some (see the top of this file). */
  private async pushed(branch: string, commit: string | undefined): Promise<void> {
    const ctl = this.ctl
    const on = vscode.workspace.getConfiguration('codeNotes').get<boolean>(BACKGROUND_SETTING, true)
    if (!on || ctl.writer.writing || !commit) return
    const done = ctl.host.memento.get<string[]>(BG_KEY) ?? []
    if (done.includes(commit)) return
    await ctl.refresh()
    const st = ctl.st
    if (!st || st.branch !== branch || st.state.phase !== 'none') return
    // A default branch: main, master, or the branch it is compared with.
    const base = (st.baseRef ?? '').replace(/^origin\//, '')
    if ([...ctl.cli.DEFAULT_BRANCHES, base].includes(branch)) return
    await ctl.host.memento.update(BG_KEY, [...done.slice(-BG_COMMITS_KEPT), commit])
    await ctl.writer.write(false, { background: true })
  }

  dispose(): void { for (const s of this.subs) s.dispose() }
}
