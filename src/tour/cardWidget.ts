// The step card's comment thread: one read-only thread of the card's own controller, made, moved and updated around
// VS Code's comment widget (threads/settle.ts: a thread made just now, or in an editor still opening, must settle
// before it is changed). The card says where and what; this says when.
import * as vscode from 'vscode'
import { afterEditorSettles, newThread, setThread, settling, whenSettled } from '../threads/settle'

export class CardWidget implements vscode.Disposable {
  private shown: vscode.CommentThread | undefined

  constructor(private readonly controller: vscode.CommentController) {}

  get thread(): vscode.CommentThread | undefined { return this.shown }

  /**
   * The card under `line` of `uri`, headed `label`, saying `body`. False: not now (the editor is opening, or the
   * thread was made just now); `again` is called once it has settled.
   */
  render(uri: vscode.Uri, line: number, label: string, body: vscode.MarkdownString, again: () => void): boolean {
    // A new thread per step (moving one left the card drawn above the view).
    const fresh = !this.isAt(uri, line, label)
    if (fresh) {
      if (afterEditorSettles(uri, 'card', again)) return false
    } else if (settling(this.shown!)) {
      // Made just now (see SETTLE_MS): this update follows once its first state is in the workbench.
      whenSettled(this.shown!, 'card', again)
      return false
    }
    if (fresh) {
      this.shown?.dispose()
      this.shown = newThread(this.controller, uri, new vscode.Range(line, 0, line, 0), [cardComment(body)])
    }
    const t = this.shown!
    setThread(t, 'canReply', false)
    setThread(t, 'contextValue', 'step')
    setThread(t, 'label', label)
    const shownBody = (t.comments[0]?.body as vscode.MarkdownString | undefined)?.value ?? ''
    if (fresh || shownBody !== body.value) t.comments = [cardComment(body)]
    setThread(t, 'collapsibleState', vscode.CommentThreadCollapsibleState.Expanded)
    return true
  }

  /** No card (made again by the next render). */
  hide(): void {
    this.shown?.dispose()
    this.shown = undefined
  }

  dispose(): void { this.hide() }

  /** The card's thread is the one for this file, line and label. */
  private isAt(uri: vscode.Uri, line: number, label: string): boolean {
    const t = this.shown
    return !!t && t.uri.toString() === uri.toString() && t.label === label && t.range?.start.line === line
  }
}

/** The card's one comment: the text only (no author line). */
function cardComment(body: vscode.MarkdownString): vscode.Comment {
  return { body, mode: vscode.CommentMode.Preview, author: { name: '' }, contextValue: 'step' }
}
