// The Listen view: a webview view (in the Code Notes side bar, under Journeys) where a journey's audio plays
// (media/listen.js, media/journey-podcast.js as the host; the panel's remote while the panel plays it: player.ts
// hostIn). VS Code keeps it alive while hidden (retainContextWhenHidden), so the episode goes on when the journey
// panel closes, is behind another tab, or the side bar is closed; the panel's player is mostly a remote of this one
// (player.ts relays). The view is there only while a journey is listened to (`codeNotes.listening`, player.ts); it is
// made only once it has been shown: `ensure()` brings it in and shows it once, then gives the keyboard back.
//
// Why there and not in the bottom panel: the ▶ people press first is on a Journeys row, right above it, so the view is
// usually already on screen (no panel pops up over the code), and it is small enough to stay open.

import * as vscode from 'vscode'
import { webviewPage } from '../webview/page'
import { journeysFolderName } from '../journeys/journeys'
import { folderName } from '../notes/store'
import { setCtx } from '../app'
import { fireAndForget } from '../platform/run'

export const LISTEN_VIEW = 'codeNotes.listen'
/** The context key that brings the view in (package.json: the view's and the transport commands' `when`). */
export const LISTENING_CTX = 'codeNotes.listening'

/** What the Listen view sends: journey-podcast.js's host messages, and its own. */
export type ListenMessage =
  | { type: 'ready' }
  | { type: 'error'; message?: string }
  | { type: 'podcastTime'; t: number; playing: boolean; rate?: number; seek?: boolean; of?: string }
  | { type: 'podcastState'; of: string; [k: string]: unknown }
  | { type: 'podcastError'; message: string; of?: string }
  | { type: 'podcastMeta'; duration: number; of?: string }
  | { type: 'podcastWhy' }
  | { type: 'podcastOpen' }
  | { type: 'podcastEnd'; of?: string; action: 'walk' | 'next' }
  // While the journey panel plays the audio, the Listen view's player is its remote (src/podcast/player.ts hostIn).
  | { type: 'podcastUnlocked' }
  | { type: 'podcastAsk'; of?: string; action: string; at?: number; until?: number; to?: number; by?: number; dir?: number; rate?: number; muted?: boolean }

export class ListenView implements vscode.WebviewViewProvider, vscode.Disposable {
  private view: vscode.WebviewView | undefined
  private ready = false
  private queue: unknown[] = []
  private waiting: (() => void)[] = []
  private subs: vscode.Disposable[] = []
  /** The view's page went (the view was closed for good): the audio with it. */
  onGone: (() => void) | undefined

  constructor(private extensionUri: vscode.Uri, private log: vscode.LogOutputChannel, private onMessage: (m: ListenMessage) => void) {}

  register(): vscode.Disposable {
    return vscode.window.registerWebviewViewProvider(LISTEN_VIEW, this, { webviewOptions: { retainContextWhenHidden: true } })
  }

  /** The page is there and listening. */
  get alive(): boolean { return !!this.view && this.ready }
  get visible(): boolean { return !!this.view?.visible }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view
    this.ready = false
    const media = (f: string) => vscode.Uri.joinPath(this.extensionUri, 'media', f)
    view.webview.options = { enableScripts: true, localResourceRoots: this.roots() }
    view.webview.html = webviewPage(view.webview, {
      css: [media('common.css'), media('journey-podcast.css'), media('listen.css')],
      body: '<div id="app"></div>',
      scripts: [media('common.js'), media('journey-podcast.js'), media('listen.js')],
      allow: { media: true },
    })
    this.subs.push(
      view.webview.onDidReceiveMessage((m: ListenMessage) => this.receive(m)),
      view.onDidDispose(() => this.disposed()),
    )
  }

  /** The extension's media, and the journeys folders (a podcast's audio is next to its journey). */
  private roots(): vscode.Uri[] {
    const roots = [vscode.Uri.joinPath(this.extensionUri, 'media')]
    for (const f of vscode.workspace.workspaceFolders ?? []) {
      for (const rel of new Set([journeysFolderName(), `${folderName()}/journeys`])) roots.push(vscode.Uri.joinPath(f.uri, rel))
    }
    return roots
  }

  private receive(m: ListenMessage): void {
    if (m?.type === 'ready') {
      this.ready = true
      for (const q of this.queue.splice(0)) fireAndForget(this.view?.webview.postMessage(q), 'listenView: view?.webview.postMessage')
      for (const w of this.waiting.splice(0)) w()
    }
    if (m?.type === 'error') this.log.error(`listen view: ${m.message}`)
    this.onMessage(m)
  }

  private disposed(): void {
    this.view = undefined
    this.ready = false
    this.queue = []
    for (const s of this.subs) s.dispose()
    this.subs = []
    this.onGone?.()
  }

  /** A file as the view loads it (undefined: no view yet). */
  toUri(u: vscode.Uri): string | undefined { return this.view?.webview.asWebviewUri(u).toString() }

  /** Tests: the page ignores the extension's pauses (as a page that can't act on them would). */
  ignorePauses = false

  /** A message for the page: sent once it is ready (dropped while there is no view: `ensure()` first). */
  send(m: unknown): void {
    if (!this.view) return
    if (this.ignorePauses && (m as { action?: string })?.action === 'pause') return
    if (this.ready) fireAndForget(this.view.webview.postMessage(m), 'listenView: view.webview.postMessage')
    else this.queue.push(m)
  }

  /**
   * The view made (shown once, so VS Code creates it; the keyboard then goes back to where it was): resolves true once
   * its page is ready, false if it could not be shown.
   */
  async ensure(): Promise<boolean> {
    if (this.alive) return true
    const ready = new Promise<void>((r) => this.waiting.push(r))
    if (!this.view) {
      try {
        await setCtx(LISTENING_CTX, true)
        await vscode.commands.executeCommand(`${LISTEN_VIEW}.focus`)
      } catch (e) {
        this.log.warn(`listen view: could not be shown (${e})`)
        return false
      }
      // The keyboard back in the editor area (the group last used: the code, or the journey panel).
      fireAndForget(vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup'), 'listenView: command workbench.action.focusActiveEditorGroup')
    }
    const timeout = new Promise<'late'>((r) => setTimeout(() => r('late'), 10000))
    return (await Promise.race([ready, timeout])) !== 'late'
  }

  dispose(): void {
    for (const s of this.subs) s.dispose()
  }
}
