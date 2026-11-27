// Background questions: when a branch is pushed (it has an upstream and nothing left to push, after it had something
// or no upstream), has code changes and no check, is not a default branch, and the repository uses the check, its
// questions are written quietly (backgroundRule.ts decides). One run at a time; never twice for the same commit.
// Setting codeNotes.understanding.background (SETTINGS.background).
import * as vscode from 'vscode'
import * as path from 'path'
import { REFRESH_SOON_MS, SETTINGS } from './constants'
import { BackgroundWrites } from './backgroundRule'
import type { CheckHost } from './host'
import { PushWatch } from './pushSeen'
import type { CheckCore } from './state'
import type { Writer } from './writer'
import { fireAndForget } from '../platform/run'
import { cfg } from '../platform/settings'

/** The parts of VS Code's git extension API used here. */
export interface GitRepo {
  rootUri: vscode.Uri
  state: { HEAD?: { name?: string; commit?: string; upstream?: unknown; ahead?: number }; onDidChange: vscode.Event<void> }
}
export interface GitApi { repositories: GitRepo[]; onDidOpenRepository: vscode.Event<GitRepo> }

/** What background questions need: the state, a refresh, the log, the workspace memory, the git reads and the writer. */
export interface BackgroundPorts extends Pick<CheckCore, 'state' | 'refresh' | 'log'> {
  host: Pick<CheckHost, 'stored'>
  refreshSoon(ms: number, force: boolean): void
  /** The repository uses the check (backgroundRule.ts usesCheck). */
  usesCheck(refs: string[]): Promise<boolean>
  writer: Pick<Writer, 'writing' | 'write'>
}

/** How many lines of what the push watcher saw are kept for the integration test (also in the log, at debug). */
const TRACE_KEPT = 10

export class BackgroundQuestions implements vscode.Disposable {
  private seen: string[] = []
  private subs: vscode.Disposable[] = []
  private readonly writes: BackgroundWrites

  constructor(private ports: BackgroundPorts) {
    this.writes = new BackgroundWrites({
      state: ports.state, refresh: ports.refresh, stored: ports.host.stored, writer: ports.writer, usesCheck: ports.usesCheck,
      // Its default (on) is package.json's.
      enabled: () => cfg().get<boolean>(SETTINGS.background) !== false,
    })
  }

  /** What the push watcher saw last (read by the integration test through the controller's snapshot). */
  get trace(): readonly string[] { return this.seen }

  /** A line of what the push watcher saw: in the log at debug level, and the last few kept (trace). */
  private saw(line: string): void {
    this.ports.log.debug(`background: ${line}`)
    this.seen = [...this.seen.slice(1 - TRACE_KEPT), line]
  }

  /** Follows VS Code's git extension: each push of this folder's repository. */
  watchPushes(): void {
    const git = vscode.extensions.getExtension<{ getAPI(v: 1): GitApi }>('vscode.git')
    if (!git) { this.saw('no git extension'); return }
    const hook = (api: GitApi) => {
      this.saw(`git api: ${api.repositories.length} repositories`)
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
    const watch = new PushWatch()
    this.subs.push(r.state.onDidChange(() => this.onRepoChange(r, watch)))
  }

  /**
   * The Git view read the repository again (a file changed, a commit, a checkout, a push). This is one of the check's
   * refresh triggers; the others (file watchers, focus, saves) are the controller's watchTriggers.
   */
  private onRepoChange(r: GitRepo, watch: PushWatch): void {
    // Whatever the check shows follows, if it changed (gated: nothing is read again otherwise).
    this.ports.refreshSoon(REFRESH_SOON_MS, false)
    const h = r.state.HEAD
    const look = watch.look(h)
    if (!look) return
    this.saw(look.line)
    if (look.pushedNow) fireAndForget(this.writes.pushed(look.branch, h?.commit), 'background: pushed')
  }

  dispose(): void { for (const s of this.subs) s.dispose() }
}
