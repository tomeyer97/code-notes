// Lines lit because a link named them (a step's code link, a chat's link), with the way back above them. One look,
// one Back row and one "our own move" window for both; each owner decides what to light and when it goes out.
import * as vscode from 'vscode'
import { setDecorations } from '../platform/editorDecorations'

/** Lit lines: 0-based, inclusive. */
export interface LitRange { uri: string; start: number; end: number }

/** The row above the lit lines: its words, its command, its tooltip. */
export interface BackRow { title: string; command: string; tooltip?: string }

/** A stretch of time in which selections and editor changes are the extension's own doing. */
export class OwnTime {
  private until = 0
  /** Ours for `ms` from now. */
  set(ms: number): void { this.until = Date.now() + ms }
  /** Ours for at least `ms` from now (a longer stretch already set stands). */
  extend(ms: number): void { this.until = Math.max(this.until, Date.now() + ms) }
  /** Still ours. */
  ours(): boolean { return Date.now() < this.until }
  /** Over (past its end). */
  over(): boolean { return Date.now() > this.until }
}

/** `uri`'s 0-based `line` is outside the lit lines (another file, or above or below them). */
export const outside = (l: LitRange, uri: string, line: number) => uri !== l.uri || line < l.start || line > l.end

/** Shows lines `start`..`end` of `ed` with `margin` lines around them. */
export function revealAround(ed: vscode.TextEditor, start: number, end: number, margin: number, how = vscode.TextEditorRevealType.InCenterIfOutsideViewport): void {
  ed.revealRange(new vscode.Range(Math.max(0, start - margin), 0, Math.min(ed.document.lineCount - 1, end + margin), 0), how)
}

export class LitLines implements vscode.Disposable {
  /**
   * One look per meaning: a link's lines carry a fill; the beat's line a box (beats.ts), the step a tint. Theme
   * colours only.
   */
  private readonly fill = vscode.window.createTextEditorDecorationType({
    isWholeLine: true, backgroundColor: new vscode.ThemeColor('editor.findMatchHighlightBackground'),
    overviewRulerColor: new vscode.ThemeColor('symbolIcon.functionForeground'), overviewRulerLane: vscode.OverviewRulerLane.Center,
  })
  private readonly changed = new vscode.EventEmitter<void>()
  /** The Back row changed (its lenses are asked for again). */
  readonly onDidChange = this.changed.event
  /** What the Back row showed last: it is announced only when that changes. */
  private shown = ''
  /** Selections and editor changes the owner makes itself, until this ends, are not the reader moving away. */
  readonly own = new OwnTime()
  private readonly subs: vscode.Disposable[]

  /** `lit`: the lines lit now; `row`: the Back row above them (none: no row). */
  constructor(private readonly lit: () => LitRange | undefined, private readonly row: () => BackRow | undefined) {
    this.subs = [this.fill, this.changed, vscode.window.onDidChangeVisibleTextEditors(() => this.paint())]
  }

  /** The Back row's place, while it is shown: the lit lines' first line. */
  get backAt(): { uri: string; line: number } | undefined {
    const l = this.lit()
    return l && this.row() ? { uri: l.uri, line: l.start } : undefined
  }

  /** The Back row in `doc`, above the lit lines. */
  lenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    const b = this.backAt, r = this.row()
    if (!b || !r || b.uri !== doc.uri.toString() || b.line >= doc.lineCount) return []
    const command = { title: r.title, command: r.command, ...(r.tooltip ? { tooltip: r.tooltip } : {}) }
    return [new vscode.CodeLens(new vscode.Range(b.line, 0, b.line, 0), command)]
  }

  /** The lit lines drawn in every visible editor; the Back row announced when it changed (each change makes the window
   *  ask every visible editor for its lenses again). */
  paint(): void {
    const l = this.lit()
    for (const e of vscode.window.visibleTextEditors) {
      setDecorations(e, this.fill, l && l.uri === e.document.uri.toString() ? [new vscode.Range(l.start, 0, l.end, 0)] : [])
    }
    const b = this.backAt, r = this.row()
    const now = b && r ? [b.uri, b.line, r.title, r.tooltip ?? ''].join('\n') : ''
    if (now !== this.shown) {
      this.shown = now
      this.changed.fire()
    }
  }

  dispose(): void { for (const s of this.subs) s.dispose() }
}
