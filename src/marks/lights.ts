// How marks (core/format/marks.ts) look on the code, for every owner: a podcast's segment (podcast/marks.ts) and a walked
// journey step (tour/stepMarks.ts). One family, fills only (no borders, no bars, nothing in the scrollbar): a mark
// within a line tints its characters; a mark of whole lines tints the full lines as one block. The focus (the newest)
// is the one coloured thing on the code (codeNotes.markBackground); the marks before it a lighter, grey tint. The
// looks themselves are in styles.ts.

import * as vscode from 'vscode'
import { setDecorations } from '../platform/editorDecorations'
import { docLines } from '../platform/documents'
import { CodeMark, findMark, MarkCodeProblem, markProblemText, MarkSpot } from '../core/format/marks'
import { LruMap } from '../core/lruMap'
import { MARK_STYLES } from './styles'

/** What is lit in one document: ranges within lines, and whole lines, in each style. */
export interface Shown { focus: vscode.Range[]; dim: vscode.Range[]; focusLines: vscode.Range[]; dimLines: vscode.Range[] }

/** What the editor shows of the marks now (tests): the range, its text, its style. */
export interface LitMark { file: string; line: number; col: number; endLine: number; endCol: number; text: string; style: 'focus' | 'dim' }

export const noneShown = (): Shown => ({ focus: [], dim: [], focusLines: [], dimLines: [] })

/** Where a mark was found; `whole`: its whole lines (no match, or a match not found that lights its lines). */
type Spot = MarkSpot & { whole: boolean }

/** Spots kept (a few documents' marks across their versions) and log lines remembered as said. */
const SPOTS_KEPT = 500
const SAID_KEPT = 2000

/** A mark in one version of a document: where it is can't change until the text does. */
const spotKey = (doc: vscode.TextDocument, m: CodeMark) =>
  JSON.stringify([doc.uri.toString(), doc.version, m.lines, m.match ?? '', m.nth ?? 1])

export class MarkPainter implements vscode.Disposable {
  private readonly focus = vscode.window.createTextEditorDecorationType(MARK_STYLES.focus)
  private readonly focusLines = vscode.window.createTextEditorDecorationType(MARK_STYLES.focusLines)
  private readonly dim = vscode.window.createTextEditorDecorationType(MARK_STYLES.dim)
  private readonly dimLines = vscode.window.createTextEditorDecorationType(MARK_STYLES.dimLines)
  private readonly subs: vscode.Disposable[]
  /** What is lit, by document. */
  private shown = new Map<string, Shown>()
  /** Where each mark was found, by document version and mark (null: nowhere). */
  private spots = new LruMap<string, Spot | null>(SPOTS_KEPT)
  /** Keys of the lines already said in the log. */
  private said = new LruMap<string, true>(SAID_KEPT)

  /**
   * `missing`: a mark whose `match` isn't on its lines nor within MARK_REFIND_LINES lines lights its whole lines (a podcast: the
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

  private spotOf(doc: vscode.TextDocument, m: CodeMark, who: string, key: string): Spot | undefined {
    const id = spotKey(doc, m)
    const known = this.spots.get(id)
    if (known !== undefined) return known ?? undefined
    const lines = docLines(doc)
    const f = findMark(lines, m)
    const lost = !!f && !!m.match && !f.found
    const spot = f && !(lost && this.missing === 'drop') ? { ...f.spot, whole: !m.match || !f.found } : null
    // Said as the journey check says it (core/format/marks.ts).
    const problem: MarkCodeProblem | undefined = !f ? { kind: 'past-end', fileLines: lines.length, sub: 'lines' }
      : lost ? { kind: 'not-found', sub: 'match' }
        : f.moved ? { kind: 'moved', moved: f.moved, sub: 'match' } : undefined
    if (problem) {
      const file = vscode.workspace.asRelativePath(doc.uri, false)
      this.once(key, `${who}: ${markProblemText(problem, { doc: lines, file, mark: m, onMissing: this.missing })}`)
    }
    this.spots.set(id, spot)
    return spot ?? undefined
  }

  /** `line` in the log, once per `key`. */
  once(key: string, line: string, level: 'info' | 'debug' = 'info'): void {
    if (this.said.has(key)) return
    this.said.set(key, true)
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
