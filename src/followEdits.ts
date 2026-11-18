import * as vscode from 'vscode'
import { LineEdit } from './lineFollow'
import { docLines } from './wfs'

// Lines remembered by text (a beat's line, a code link's lines, value hints) follow edits to their file in two moves:
// at once by the lines added or removed above them (`onShift`), and once the typing pauses by their text (`onRefind`).

/** VS Code's changes as LineEdits (lineFollow.ts), in the order given. */
export function lineEdits(changes: readonly vscode.TextDocumentContentChangeEvent[]): LineEdit[] {
  return changes.map((c) => ({
    startLine: c.range.start.line,
    startChar: c.range.start.character,
    endLine: c.range.end.line,
    endChar: c.range.end.character,
    newLines: (c.text.match(/\n/g) ?? []).length,
  }))
}

/** How long the typing must pause before the remembered lines are looked for by their text. (A journey's steps wait
 *  longer: tracker.ts EDIT_SETTLE_MS.) */
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
      onShift(lineEdits(e.contentChanges), uri)
      this.cancel()
      this.timer = setTimeout(() => onRefind(e.document, docLines(e.document)), REFIND_MS)
    })
  }

  /** A refind still waiting for the typing to pause is dropped. */
  cancel(): void { clearTimeout(this.timer) }

  dispose(): void { this.cancel(); this.sub.dispose() }
}
