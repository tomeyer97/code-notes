// A controller's explanation beside the lines it revealed: a comment thread of its own (not a note: nothing is saved),
// open under the lines until the reader dismisses it (its ✕) or the next reveal replaces it. VS Code draws it, so it
// follows the theme and the editor's width.
import * as vscode from 'vscode'

/** The controller's id: the manifest's Dismiss button is on its threads only (`commentController == …`). */
export const CALLOUT_CONTROLLER = 'codeNotes.bridge'

export interface CalloutState { uri: string; start: number; end: number; text: string; author: string }

export class Callout implements vscode.Disposable {
  private readonly controller = vscode.comments.createCommentController(CALLOUT_CONTROLLER, 'Code Notes: explanations')
  private thread: vscode.CommentThread | undefined
  private shown: CalloutState | undefined

  /** Shows `text` (Markdown, its links and HTML not run) under lines start..end (0-based) of `uri`. */
  show(uri: vscode.Uri, start: number, end: number, text: string, author: string): void {
    this.dismiss()
    const body = new vscode.MarkdownString(text)
    body.isTrusted = false
    body.supportHtml = false
    const comment: vscode.Comment = { body, mode: vscode.CommentMode.Preview, author: { name: author } }
    const thread = this.controller.createCommentThread(uri, new vscode.Range(start, 0, end, 0), [comment])
    thread.canReply = false
    thread.label = 'Explanation'
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded
    this.thread = thread
    this.shown = { uri: uri.toString(), start, end, text, author }
  }

  dismiss(): void {
    this.thread?.dispose()
    this.thread = undefined
    this.shown = undefined
  }

  /** For tests: what is shown (none: dismissed). */
  get state(): CalloutState | undefined { return this.shown && { ...this.shown } }

  dispose(): void {
    this.dismiss()
    this.controller.dispose()
  }
}
