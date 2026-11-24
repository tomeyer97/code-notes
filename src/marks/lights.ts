// How marks (core/format/marks.ts) look on the code, for every owner: a podcast's segment (podcast/marks.ts) and a walked
// journey step (tour/stepMarks.ts). One family, fills only (no borders, no bars, nothing in the scrollbar): a mark
// within a line tints its characters; a mark of whole lines tints the full lines as one block. The focus (the newest)
// is the one coloured thing on the code (codeNotes.markBackground); the marks before it a lighter, grey tint.

import * as vscode from 'vscode'
import { setDecorations } from '../platform/editorDecorations'
import { docLines } from '../platform/documents'
import { CodeMark, findMark, MARK_REFIND_LINES, MarkSpot } from '../core/format/marks'

/** What is lit in one document: ranges within lines, and whole lines, in each style. */
export interface Shown { focus: vscode.Range[]; dim: vscode.Range[]; focusLines: vscode.Range[]; dimLines: vscode.Range[] }

/** What the editor shows of the marks now (tests): the range, its text, its style. */
export interface LitMark { file: string; line: number; col: number; endLine: number; endCol: number; text: string; style: 'focus' | 'dim' }

export const noneShown = (): Shown => ({ focus: [], dim: [], focusLines: [], dimLines: [] })

export class MarkPainter implements vscode.Disposable {
  private readonly focus = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor('codeNotes.markBackground'), borderRadius: '2px',
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  })
  private readonly focusLines = vscode.window.createTextEditorDecorationType({
    isWholeLine: true, backgroundColor: new vscode.ThemeColor('codeNotes.markBackground'),
  })
  private readonly dim = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor('editor.wordHighlightBackground'), borderRadius: '2px',
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  })
  private readonly dimLines = vscode.window.createTextEditorDecorationType({
    isWholeLine: true, backgroundColor: new vscode.ThemeColor('editor.wordHighlightBackground'),
  })
  private readonly subs: vscode.Disposable[]
  /** What is lit, by document. */
  private shown = new Map<string, Shown>()
  /** Where each mark was found, by document version and mark. */
  private spots = new Map<string, (MarkSpot & { whole: boolean }) | null>()
  /** Lines already said in the log. */
  private said = new Set<string>()

  /**
   * `missing`: a mark whose `match` isn't on its lines nor within 20 lines lights its whole lines (a podcast: the
   * voice still names that code) or nothing (a journey: a wrong highlight is worse than none).
   */
  constructor(private readonly log: vscode.LogOutputChannel, private readonly missing: 'lines' | 'drop') {
    this.subs = [this.focus, this.dim, this.focusLines, this.dimLines, vscode.window.onDidChangeVisibleTextEditors(() => this.paint())]
  }

  get empty(): boolean { return !this.shown.size }

  /** Lights exactly `next` (by document URI), every visible editor repainted. */
  show(next: Map<string, Shown>): void {
    this.shown = next
    this.paint()
  }

  /**
   * Adds mark `m` in `doc` to `at` in `style` (its match, re-found if the code moved, else per `missing`); `who` names
   * it in the log ("podcast: mark …", said once per `key`). The ranges added (none: nothing lit).
   */
  add(at: Shown, doc: vscode.TextDocument, m: CodeMark, style: 'focus' | 'dim', who: string, key: string): vscode.Range[] {
    const spot = this.spotOf(doc, m, who, key)
    if (!spot) return []
    if (!spot.whole) {
      const r = [new vscode.Range(spot.line, spot.col, spot.endLine, spot.endCol)]
      at[style].push(...r)
      return r
    }
    // Whole lines: each from its text (no box around indentation).
    const out: vscode.Range[] = []
    for (let l = spot.line; l <= spot.endLine; l++) {
      const text = doc.lineAt(l).text
      if (!text.trim()) continue
      out.push(new vscode.Range(l, text.length - text.trimStart().length, l, text.length))
    }
    at[`${style}Lines`].push(...out)
    return out
  }

  private spotOf(doc: vscode.TextDocument, m: CodeMark, who: string, key: string): (MarkSpot & { whole: boolean }) | undefined {
    const id = `${doc.uri.toString()}@${doc.version}|${m.lines.join('-')}|${m.match ?? ''}|${m.nth ?? 1}`
    let spot = this.spots.get(id)
    if (spot === undefined) {
      const f = findMark(docLines(doc), m)
      const lost = !!f && !!m.match && !f.found
      spot = f && !(lost && this.missing === 'drop') ? { ...f.spot, whole: !m.match || !f.found } : null
      const where = `${vscode.workspace.asRelativePath(doc.uri, false)}:${m.lines[0]}${m.lines[1] !== m.lines[0] ? `-${m.lines[1]}` : ''}`
      if (!f) this.once(key, `${who}: ${where} is past the end of the file; nothing lit`)
      else if (lost) this.once(key, `${who}: ${JSON.stringify(m.match)} isn't at ${where} nor within ${MARK_REFIND_LINES} lines; ${this.missing === 'lines' ? 'its lines are lit' : 'nothing lit'}`)
      else if (f.moved) this.once(key, `${who}: ${JSON.stringify(m.match)} moved ${Math.abs(f.moved)} lines ${f.moved < 0 ? 'up' : 'down'} from ${where}; lit there`)
      if (this.spots.size > 500) this.spots.clear()
      this.spots.set(id, spot)
    }
    return spot ?? undefined
  }

  /** `line` in the log, once per `key`. */
  once(key: string, line: string, level: 'info' | 'debug' = 'info'): void {
    if (this.said.has(key)) return
    this.said.add(key)
    if (this.said.size > 2000) this.said.clear()
    this.log[level](line)
  }

  paint(): void {
    for (const e of vscode.window.visibleTextEditors) {
      const s = this.shown.get(e.document.uri.toString())
      setDecorations(e, this.focus, s?.focus ?? [])
      setDecorations(e, this.dim, s?.dim ?? [])
      setDecorations(e, this.focusLines, s?.focusLines ?? [])
      setDecorations(e, this.dimLines, s?.dimLines ?? [])
    }
  }

  /** For tests: what is lit, with its text. */
  lit(): LitMark[] {
    const out: LitMark[] = []
    for (const [uri, s] of this.shown) {
      const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri)
      const file = vscode.workspace.asRelativePath(vscode.Uri.parse(uri), false)
      for (const [style, rs] of [['focus', [...s.focus, ...s.focusLines]], ['dim', [...s.dim, ...s.dimLines]]] as const) {
        for (const r of rs) out.push({ file, line: r.start.line, col: r.start.character, endLine: r.end.line, endCol: r.end.character, text: doc?.getText(r) ?? '', style })
      }
    }
    return out
  }

  dispose(): void { for (const s of this.subs) s.dispose() }
}
