// Background questions: when a branch is pushed (it has an upstream and nothing left to push, after it had something
// or no upstream), has code changes and no check, and is not a default branch, its questions are written quietly. One
// run at a time; never twice for the same commit. Setting codeNotes.understanding.background (SETTINGS.background).
import * as vscode from 'vscode'
import * as path from 'path'
import { BG_COMMITS_KEPT, BG_KEY, REFRESH_SOON_MS, SETTINGS } from './constants'
import type { CheckHost } from './host'
import type { CheckCore } from './state'
import type { Writer } from './writer'
import { fireAndForget } from '../platform/run'
import { STATE } from '../platform/state'

/** The parts of VS Code's git extension API used here. */
export interface GitRepo {
  rootUri: vscode.Uri
  state: { HEAD?: { name?: string; commit?: string; upstream?: unknown; ahead?: number }; onDidChange: vscode.Event<void> }
}
export interface GitApi { repositories: GitRepo[]; onDidOpenRepository: vscode.Event<GitRepo> }

/** What background questions need: the state, a refresh, the workspace memory and the writer. */
export interface BackgroundPorts extends Pick<CheckCore, 'state' | 'refresh'> {
  host: Pick<CheckHost, 'stored'>
  refreshSoon(ms: number, force: boolean): void
  writer: Pick<Writer, 'writing' | 'write'>
}

export class BackgroundQuestions implements vscode.Disposable {
  /** What the push watcher saw last (integration test). */
  trace: string[] = []
  private subs: vscode.Disposable[] = []

  constructor(private ports: BackgroundPorts) {}

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
    const folder = this.ports.state.folder
    if (!folder || path.resolve(r.rootUri.fsPath) !== path.resolve(folder.uri.fsPath)) return
    // A branch first seen already pushed (a checkout) starts nothing.
    const was = new Map<string, boolean>()
    this.subs.push(r.state.onDidChange(() => this.onRepoChange(r, was)))
  }

  /** The Git view read the repository again (a file changed, a commit, a checkout, a push). */
  private onRepoChange(r: GitRepo, was: Map<string, boolean>): void {
    // Whatever the check shows follows, if it changed (gated: nothing is read again otherwise).
    this.ports.refreshSoon(REFRESH_SOON_MS, false)
    const h = r.state.HEAD
    if (!h?.name) return
    const pushed = !!h.upstream && h.ahead === 0
    const before = was.get(h.name)
    was.set(h.name, pushed)
    const seen = `${h.name} ${pushed ? 'pushed' : 'unpushed'}${before === undefined ? ' (new)' : ''}`
    this.trace = [...this.trace.slice(-9), seen]
    if (pushed && before === false) fireAndForget(this.pushed(h.name, h.commit), 'background: pushed')
  }

  /** `branch` was just pushed at `commit`: its questions, if it needs some (see the top of this file). */
  private async pushed(branch: string, commit: string | undefined): Promise<void> {
    const ports = this.ports
    const on = vscode.workspace.getConfiguration('codeNotes').get<boolean>(SETTINGS.background, true)
    if (!on || ports.writer.writing || !commit) return
    const done = ports.host.stored.get(STATE.checkBackgroundHeads)
    if (done.includes(commit)) return
    await ports.refresh()
    const st = ports.state.st
    if (!st || st.branch !== branch || st.state.phase !== 'none') return
    // A default branch (the CLI's isDefaultBranch: origin's HEAD, else main or master; or the branch compared with).
    if (st.onBase) return
    await ports.host.stored.set(STATE.checkBackgroundHeads, [...done.slice(-BG_COMMITS_KEPT), commit])
    await ports.writer.write(false, { background: true })
  }

  dispose(): void { for (const s of this.subs) s.dispose() }
}
