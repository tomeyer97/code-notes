// The Check view in the Code Notes sidebar (media/check.js, media/checkAnswer.js): where the check stands, the
// questions as rows, one button. This side only carries messages (src/protocol/check.ts): the controller
// (controller.ts) decides what they do.
import * as vscode from 'vscode'
import type { FromCheck, ToCheck } from '../protocol/check'
import type { CheckView } from './viewModel'
import { PAGES_DIR, pageScript, webviewPage } from '../webview/page'
import { WebviewChannel } from '../webview/channel'
import { fireAndForget } from '../platform/run'
import { HiddenCmd } from '../platform/commands'

export class CheckViewProvider implements vscode.WebviewViewProvider {
  private wv: vscode.WebviewView | undefined
  private last: CheckView | undefined
  /** The page's messages: a focus asked for before the view is made waits for it. */
  private channel: WebviewChannel<FromCheck, ToCheck>
  /** A focus request that may be tried once more (focus): which question, tries left, the caret it was asked at. */
  private focusTries: { id: string; left: number; caret: string } | undefined
  /** What the webview reported (integration test): rows drawn, layout problems, errors. */
  private reported: { rows?: number; overflow?: string[]; errors: string[]; height?: number } = { errors: [] }

  constructor(private extUri: vscode.Uri, private log: vscode.LogOutputChannel, private onMessage: (m: FromCheck) => void) {
    this.channel = new WebviewChannel('check view', log, { queueWithoutPage: true, onReady: () => this.post() })
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.wv = view
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.extUri, 'media'), vscode.Uri.joinPath(this.extUri, ...PAGES_DIR)] }
    const media = (f: string) => vscode.Uri.joinPath(this.extUri, 'media', f)
    view.webview.html = webviewPage(view.webview, {
      css: [media('common.css'), media('check.css'), media('checkAnswer.css')],
      body: '<div id="app"></div>',
      scripts: [pageScript(this.extUri, 'check')],
    })
    this.channel.attach(view.webview, (m) => {
      switch (m.type) {
        case 'rendered':
          this.reported = { ...this.reported, rows: m.rows, overflow: m.overflow, height: m.height }
          break
        case 'error': // logged by the channel
          this.reported.errors.push(String(m.message))
          break
        case 'focused':
          if (m.id) this.focused(m.id, !!m.ok)
          break
      }
      this.onMessage(m)
    })
    view.onDidDispose(() => { this.wv = undefined; this.channel.detach() })
  }

  /** Shows the view (opening the sidebar on it), keeping the keyboard where it is. */
  reveal(): void {
    if (this.wv) this.wv.show(true)
    else fireAndForget(vscode.commands.executeCommand(HiddenCmd.checkFocus).then(() => vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup')), 'view: command codeNotes.check.focus')
  }
  update(v: CheckView | undefined): void { this.last = v; this.post() }

  /** The keyboard into question `id`'s answer box (the view shown and focused first; once more if it didn't arrive). */
  async focus(id: string): Promise<void> {
    this.focusTries = { id, left: 1, caret: caretSig(vscode.window.activeTextEditor) }
    if (this.wv) this.wv.show(false)
    else await vscode.commands.executeCommand(HiddenCmd.checkFocus)
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

  /** The view to the page (once ready); the same view again is not sent. */
  private post(): void {
    const msg: ToCheck = { type: 'check', view: this.last ?? null }
    this.channel.sendChanged(msg, JSON.stringify(msg, (_k, v) => (v instanceof Set ? [...v] : v)))
  }
  send(m: ToCheck): void { this.channel.send(m) }
  state() { return { open: !!this.wv, visible: !!this.wv?.visible, ...this.reported } }
}

/** Where the caret is ("file|line:column"; '' without an editor): to tell whether the person moved it. */
function caretSig(e: vscode.TextEditor | undefined): string {
  return e ? `${e.document.uri}|${e.selection.active.line}:${e.selection.active.character}` : ''
}
