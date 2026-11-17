import * as vscode from 'vscode'
import { LineEdit } from './beatLine'
import { docLines } from './wfs'

// Lines remembered by text (a beat's line, a code link's lines, value hints) follow edits to their file in two moves:
// at once by the lines added or removed above them (`onShift`), and once the typing pauses by their text (`onRefind`).

/** How long the typing must pause before the remembered lines are looked for by their text. */
export const REFIND_MS = 150

export class EditFollower implements vscode.Disposable {
  private timer: ReturnType<typeof setTimeout> | undefined
  private readonly sub: vscode.Disposable

  /** `watches`: whether lines are remembered in this document (by URI string). */
  constructor(
    watches: (uri: string) => boolean,
    onShift: (edits: LineEdit[], uri: string) => void,
    onRefind: (doc: vscode.TextDocument, lines: string[]) => void,
  ) {
    this.sub = vscode.workspace.onDidChangeTextDocument((e) => {
      const uri = e.document.uri.toString()
      if (!e.contentChanges.length || !watches(uri)) return
      onShift(e.contentChanges.map((c) => ({ start: c.range.start.line, end: c.range.end.line, text: c.text })), uri)
      this.cancel()
      this.timer = setTimeout(() => onRefind(e.document, docLines(e.document)), REFIND_MS)
    })
  }

  /** A refind still waiting for the typing to pause is dropped. */
  cancel(): void { clearTimeout(this.timer) }

  dispose(): void { this.cancel(); this.sub.dispose() }
}
