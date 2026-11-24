// The Check view in the Code Notes sidebar (media/check.js, media/checkAnswer.js): where the check stands, the
// questions as rows, one button. This side only carries messages (src/protocol/check.ts): the page's reports about
// itself are handled here, its requests go to the controller (controller.ts), which decides what they do.
import * as vscode from 'vscode'
import type { FromCheck, ToCheck } from '../protocol/check'
import type { CheckView } from './checkViewTypes'
import { isCheckViewReport } from './viewMessages'
import { PAGES_DIR, pageScript, webviewPage } from '../webview/page'
import { WebviewChannel } from '../webview/channel'
import { fireAndForget } from '../platform/run'
import { HiddenCmd } from '../platform/commands'

/** VS Code's command that puts the keyboard back in the editor. */
const FOCUS_EDITOR = 'workbench.action.focusActiveEditorGroup'

/** What the page last reported about itself: rows drawn, what sticks out, its height, its errors (state()). */
export interface PageReport { rows?: number; overflow?: string[]; errors: string[]; height?: number }

/**
 * Opening a question puts the keyboard in its answer box. VS Code focuses a webview late (or not at all), so:
 *
 *   focus(id) ── shows the view ──> page: 'focus' id ── tries its box for about a second (it may still be drawn)
 *   page ── about a second later ──> 'focused' { id, ok }
 *     ok ─────────────────────────> done
 *     not ok, the caret where it was, a try left ──> shows the view again, 'focus' id once more
 *     not ok, the caret moved (the person went on) or Esc (cancelFocus) ──> left where it is
 *
 * The controller keeps the question's lines in view meanwhile (controller.ts open, REVEAL_RETRY_MS).
 */
interface FocusTry { id: string; left: number; caret: string }

export class CheckViewProvider implements vscode.WebviewViewProvider {
  private wv: vscode.WebviewView | undefined
  private last: CheckView | undefined
  /** The page's messages: a focus asked for before the view is made waits for it. */
  private channel: WebviewChannel<FromCheck, ToCheck>
  /** A focus request that may be tried once more (the sequence above). */
  private focusTry: FocusTry | undefined
  private reported: PageReport = { errors: [] }

  /** `onRequest`: the page's requests (everything but its reports). */
  constructor(private extUri: vscode.Uri, private log: vscode.LogOutputChannel, private onRequest: (m: FromCheck) => void) {
    this.channel = new WebviewChannel('check view', log, { queueWithoutPage: true, onReady: () => this.post() })
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.wv = view
    const roots = [vscode.Uri.joinPath(this.extUri, 'media'), vscode.Uri.joinPath(this.extUri, ...PAGES_DIR)]
    view.webview.options = { enableScripts: true, localResourceRoots: roots }
    const media = (f: string) => vscode.Uri.joinPath(this.extUri, 'media', f)
    view.webview.html = webviewPage(view.webview, {
      css: [media('common.css'), media('check.css'), media('checkAnswer.css')],
      body: '<div id="app" class="check"></div>',
      scripts: [pageScript(this.extUri, 'check')],
    })
    this.channel.attach(view.webview, (m) => (isCheckViewReport(m) ? this.onReport(m) : this.onRequest(m)))
    view.onDidDispose(() => { this.wv = undefined; this.channel.detach() })
  }

  /** The page's reports about itself (viewMessages.ts CHECK_VIEW_REPORTS). */
  private onReport(m: FromCheck): void {
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
  }

  /** Shows the view (opening the sidebar on it), keeping the keyboard where it is. */
  reveal(): void {
    if (this.wv) { this.wv.show(true); return }
    const opened = vscode.commands.executeCommand(HiddenCmd.checkFocus)
      .then(() => vscode.commands.executeCommand(FOCUS_EDITOR))
    fireAndForget(opened, `view: command ${HiddenCmd.checkFocus}`)
  }
  update(v: CheckView | undefined): void { this.last = v; this.post() }

  /** The keyboard into question `id`'s answer box (the view shown and focused first; once more if it didn't arrive). */
  async focus(id: string): Promise<void> {
    this.focusTry = { id, left: 1, caret: caretAt(vscode.window.activeTextEditor) }
    if (this.wv) this.wv.show(false)
    else await vscode.commands.executeCommand(HiddenCmd.checkFocus)
    this.send({ type: 'focus', id })
  }
  /** Esc, or anything else that moves on: no second try. */
  cancelFocus(): void { this.focusTry = undefined }
  /** The page said whether the keyboard reached question `id`'s box. */
  private focused(id: string, ok: boolean): void {
    const t = this.focusTry, wv = this.wv
    if (ok) { this.focusTry = undefined; return }
    // Not this question's request, no try left, or the view is gone: nothing more to do.
    if (!t || t.id !== id || t.left <= 0 || !wv) return
    // The person moved on meanwhile (the caret moved): leave the keyboard where they put it.
    if (caretAt(vscode.window.activeTextEditor) !== t.caret) { this.focusTry = undefined; return }
    t.left--
    this.log.info(`check view: the answer box didn't get the keyboard; again`)
    wv.show(false)
    this.send({ type: 'focus', id })
  }

  /** The view to the page (once ready); the same view again is not sent. */
  private post(): void {
    const msg: ToCheck = { type: 'check', view: this.last ?? null }
    this.channel.sendChanged(msg)
  }
  send(m: ToCheck): void { this.channel.send(m) }
  /** Whether the view is open and shown, and what its page last reported (read by the integration tests). */
  state() { return { open: !!this.wv, visible: !!this.wv?.visible, ...this.reported } }
}

/** Where the caret is ("file|line:column"; '' without an editor): to tell whether the person moved it. */
function caretAt(e: vscode.TextEditor | undefined): string {
  return e ? `${e.document.uri}|${e.selection.active.line}:${e.selection.active.character}` : ''
}
