// The Listen view: a webview view (in the Code Notes side bar, under Journeys) where a journey's audio plays
// (media/listen.js, with media/journey-podcast.js as the host; the panel's remote while the panel plays it:
// audioHost.ts). VS Code keeps it alive while hidden (retainContextWhenHidden), so the episode goes on when the journey
// panel closes, is behind another tab, or the side bar is closed; the panel's player is mostly a remote of this one
// (audioHost.ts relays). The view is there only while a journey is listened to (`codeNotes.listening`, statusItem.ts); it is
// made only once it has been shown: `ensure()` brings it in and shows it once, then gives the keyboard back.
//
// Why there and not in the bottom panel: the ▶ people press first is on a Journeys row, right above it, so the view is
// usually already on screen (no panel pops up over the code), and it is small enough to stay open.

import * as vscode from 'vscode'
import type { FromListen, ToListen } from '../protocol/listen'
import { PAGES_DIR, pageScript, webviewPage } from '../webview/page'
import { WebviewChannel } from '../webview/channel'
import { journeysFolderName } from '../journeys/journeys'
import { folderName } from '../notes/notesFolder'
import { setCtx } from '../platform/context'
import { fireAndForget } from '../platform/run'

export const LISTEN_VIEW = 'codeNotes.listen'
/** The context key that brings the view in (package.json: the view's and the transport commands' `when`). */
export const LISTENING_CTX = 'codeNotes.listening'

export class ListenView implements vscode.WebviewViewProvider, vscode.Disposable {
  private view: vscode.WebviewView | undefined
  /** The page's messages (src/protocol/listen.ts): what it is sent waits until it is ready. */
  private channel: WebviewChannel<FromListen, ToListen>
  private waiting: (() => void)[] = []
  private subs: vscode.Disposable[] = []
  /** `on.message`: what the page says; `on.gone`: the view's page went (the view was closed for good), the audio with
   *  it. */
  constructor(private extensionUri: vscode.Uri, private log: vscode.LogOutputChannel, private readonly on: { message: (m: FromListen) => void; gone: () => void }) {
    this.channel = new WebviewChannel('listen view', log, { onReady: () => { for (const w of this.waiting.splice(0)) w() } })
  }

  register(): vscode.Disposable {
    return vscode.window.registerWebviewViewProvider(LISTEN_VIEW, this, { webviewOptions: { retainContextWhenHidden: true } })
  }

  /** The page is there and listening. */
  get alive(): boolean { return !!this.view && this.channel.ready }
  get visible(): boolean { return !!this.view?.visible }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view
    const media = (f: string) => vscode.Uri.joinPath(this.extensionUri, 'media', f)
    view.webview.options = { enableScripts: true, localResourceRoots: this.roots() }
    view.webview.html = webviewPage(view.webview, {
      css: [media('common.css'), media('journey-podcast.css'), media('listen.css')],
      body: '<div id="app"></div>',
      scripts: [pageScript(this.extensionUri, 'listen')],
      allow: { media: true },
    })
    this.subs.push(
      this.channel.attach(view.webview, (m) => this.on.message(m)),
      view.onDidDispose(() => this.disposed()),
    )
  }

  /** The extension's media, and the journeys folders (a podcast's audio is next to its journey). */
  private roots(): vscode.Uri[] {
    const roots = [vscode.Uri.joinPath(this.extensionUri, 'media'), vscode.Uri.joinPath(this.extensionUri, ...PAGES_DIR)]
    for (const f of vscode.workspace.workspaceFolders ?? []) {
      for (const rel of new Set([journeysFolderName(), `${folderName()}/journeys`])) roots.push(vscode.Uri.joinPath(f.uri, rel))
    }
    return roots
  }

  private disposed(): void {
    this.view = undefined
    this.channel.detach()
    for (const s of this.subs) s.dispose()
    this.subs = []
    this.on.gone()
  }

  /** A file as the view loads it (undefined: no view yet). */
  toUri(u: vscode.Uri): string | undefined { return this.view?.webview.asWebviewUri(u).toString() }

  /** Tests: the page ignores the extension's pauses (as a page that can't act on them would). */
  ignorePauses = false

  /** A message for the page: sent once it is ready (dropped while there is no view: `ensure()` first). */
  send(m: ToListen): void {
    if (!this.view) return
    if (this.ignorePauses && m.type === 'podcastCmd' && m.action === 'pause') return
    this.channel.send(m)
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
