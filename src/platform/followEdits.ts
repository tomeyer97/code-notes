import * as vscode from 'vscode'
import { LineEdit, followLine, shiftLine } from '../core/anchors/lineFollow'
import { docLines } from './documents'

// Lines remembered by text (a beat's line, a code link's lines, value hints) follow edits to their file in two moves:
// at once by the lines added or removed above them (`onShift`), and once the typing pauses by their text (`onRefind`).
// TrackedLines holds such lines and does both moves; EditFollower is the watching underneath.

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

/** A line remembered in a file: 0-based, and the text it is found again by ('': it is only shifted). */
export interface TrackedLine { uri: string; line: number; text: string }

/**
 * Remembered lines that follow edits to their files: shifted at once, found again by their text once the typing
 * pauses; one not found again is dropped (`onLost`). `onChange` after each move, to repaint.
 */
export class TrackedLines<T extends TrackedLine> implements vscode.Disposable {
  private list: T[] = []
  private readonly follower: EditFollower

  constructor(private onChange: () => void, private hooks: { onFound?: (t: T, doc: vscode.TextDocument) => void; onLost?: (t: T) => void } = {}) {
    this.follower = new EditFollower(
      (uri) => this.list.some((t) => t.uri === uri),
      (edits, uri) => this.shift(uri, edits),
      (doc, lines) => this.refind(doc, lines),
    )
  }

  get items(): readonly T[] { return this.list }

  /** The lines to follow from now on (none: `[]`). */
  set(items: T[]): void { this.list = items }

  /** A refind still waiting for the typing to pause is dropped. */
  cancel(): void { this.follower.cancel() }

  private shift(uri: string, edits: LineEdit[]): void {
    for (const t of this.list) if (t.uri === uri) t.line = shiftLine(t.line, edits)
    this.onChange()
  }

  private refind(doc: vscode.TextDocument, lines: string[]): void {
    const uri = doc.uri.toString()
    if (!this.list.some((t) => t.uri === uri)) return
    const kept: T[] = []
    for (const t of this.list) {
      if (t.uri !== uri) {
        kept.push(t)
        continue
      }
      const at = followLine(lines, t.line, t.text, [])
      if (at < 0) {
        this.hooks.onLost?.(t)
        continue
      }
      t.line = at
      this.hooks.onFound?.(t, doc)
      kept.push(t)
    }
    this.list = kept
    this.onChange()
  }

  dispose(): void { this.follower.dispose() }
}
