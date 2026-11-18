// The Check view in the Code Notes sidebar (media/check.js, media/checkAnswer.js): where the check stands, the
// questions as rows, one button. This side only carries messages: the controller (index.ts) decides what they do.
import * as vscode from 'vscode'
import type { CheckViewMessage } from './viewMessages'
import type { CheckView } from './viewModel'
import { webviewPage } from '../webview/page'

export class CheckViewProvider implements vscode.WebviewViewProvider {
  private wv: vscode.WebviewView | undefined
  private ready = false
  private last: CheckView | undefined
  private queue: unknown[] = []
  /** The view as last sent to the webview: the same view again is not sent (a message to the window each time). */
  private sent: string | undefined
  /** A focus request that may be tried once more (focus): which question, tries left, the caret it was asked at. */
  private focusTries: { id: string; left: number; caret: string } | undefined
  /** What the webview reported (integration test): rows drawn, layout problems, errors. */
  private reported: { rows?: number; overflow?: string[]; errors: string[]; height?: number } = { errors: [] }

  constructor(private extUri: vscode.Uri, private log: vscode.LogOutputChannel, private onMessage: (m: CheckViewMessage) => void) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.wv = view
    this.ready = false
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.extUri, 'media')] }
    const media = (f: string) => vscode.Uri.joinPath(this.extUri, 'media', f)
    view.webview.html = webviewPage(view.webview, {
      css: [media('common.css'), media('check.css'), media('checkAnswer.css')],
      body: '<div id="app"></div>',
      scripts: [media('common.js'), media('checkAnswer.js'), media('check.js')],
    })
    view.webview.onDidReceiveMessage((m: CheckViewMessage) => {
      switch (m.type) {
        case 'ready':
          this.ready = true
          this.sent = undefined
          this.post()
          for (const q of this.queue.splice(0)) void view.webview.postMessage(q)
          break
        case 'rendered':
          this.reported = { ...this.reported, rows: m.rows, overflow: m.overflow, height: m.height }
          break
        case 'error':
          this.reported.errors.push(String(m.message))
          this.log.error(`check view: ${m.message}`)
          break
        case 'focused':
          if (m.id) this.focused(m.id, !!m.ok)
          break
      }
      this.onMessage(m)
    })
    view.onDidDispose(() => { this.wv = undefined; this.ready = false; this.sent = undefined })
  }

  /** Shows the view (opening the sidebar on it), keeping the keyboard where it is. */
  reveal(): void {
    if (this.wv) this.wv.show(true)
    else void vscode.commands.executeCommand('codeNotes.check.focus').then(() => vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup'))
  }
  update(v: CheckView | undefined): void { this.last = v; this.post() }

  /** The keyboard into question `id`'s answer box (the view shown and focused first; once more if it didn't arrive). */
  async focus(id: string): Promise<void> {
    this.focusTries = { id, left: 1, caret: caretSig(vscode.window.activeTextEditor) }
    if (this.wv) this.wv.show(false)
    else await vscode.commands.executeCommand('codeNotes.check.focus')
    this.send({ type: 'focus', id })
  }
  /** Esc, or anything else that moves on: no second try. */
  cancelFocus(): void { this.focusTries = undefined }
  private focused(id: string, ok: boolean): void {
    const t = this.focusTries
    if (ok || !t || t.id !== id || t.left <= 0 || !this.wv) {
      if (ok) this.focusTries = undefined
      return
    }
    // The person moved on meanwhile (the caret moved): leave the keyboard where they put it.
    if (caretSig(vscode.window.activeTextEditor) !== t.caret) { this.focusTries = undefined; return }
    t.left--
    this.log.info(`check view: the answer box didn't get the keyboard; again`)
    this.wv.show(false)
    this.send({ type: 'focus', id })
  }

  private post(): void {
    if (!this.wv || !this.ready) return
    const msg = { type: 'check', view: this.last ?? null }
    const text = JSON.stringify(msg, (_k, v) => (v instanceof Set ? [...v] : v))
    if (text === this.sent) return
    this.sent = text
    void this.wv.webview.postMessage(msg)
  }
  send(m: unknown): void {
    if (this.wv && this.ready) void this.wv.webview.postMessage(m)
    else this.queue.push(m)
  }
  state() { return { open: !!this.wv, visible: !!this.wv?.visible, ...this.reported } }
}

/** Where the caret is ("file|line:column"; '' without an editor): to tell whether the person moved it. */
function caretSig(e: vscode.TextEditor | undefined): string {
  return e ? `${e.document.uri}|${e.selection.active.line}:${e.selection.active.character}` : ''
}
