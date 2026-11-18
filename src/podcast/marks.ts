// Marks (docs/podcast-format.md, "Marks"): word-timed highlights within a segment. While the voice says a phrase, the
// code it names lights: whole lines, or only a `match` within them. The newest mark (with any said with the same
// phrase) is the focus, a strong box; the segment's earlier marks stay, dimmed; the beat's own line box stays under
// them. The next segment clears them. At any time T exactly the marks lit by T in the segment playing at T show (also
// paused, after a seek); the timing is precomputed per segment (model.ts markTimes, planMarks), so a time report costs
// a few comparisons. A mark in another file than the one on screen is a view change: the view hold applies
// (model.ts planMarks). Marks never scroll a reader who looks around on their own (the follow lock); otherwise a new
// mark is brought on screen only when it is off it.

import * as vscode from 'vscode'
import { setDecorations } from '../decorations'
import { docLines } from '../documents'
import { findMark, Mark, MarkSpot, marksAt } from './model'

/** A segment's marks as the player plays them: each one's file, when it lights, and whether it is skipped (it would
 *  switch files within the view hold) or opens its file. */
export interface PlannedMark { mark: Mark; uri: vscode.Uri; file: string; time: number; skip: boolean; opens: boolean }

/** What the editor shows of the marks now (tests): the range, its text, its style. */
export interface LitMark { file: string; line: number; col: number; endLine: number; endCol: number; text: string; style: 'focus' | 'dim' }

export class MarkLights implements vscode.Disposable {
  /**
   * The newest mark: a filled box with an edge in the cursor's colour (as the beat's line box: "here, now"); the
   * earlier ones in the segment: the fill alone, fainter. Theme colours only: both read in light and dark themes.
   */
  private readonly focus = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor('editor.wordHighlightStrongBackground'),
    borderWidth: '1px', borderStyle: 'solid', borderColor: new vscode.ThemeColor('editorCursor.foreground'), borderRadius: '3px',
    overviewRulerColor: new vscode.ThemeColor('editorCursor.foreground'), overviewRulerLane: vscode.OverviewRulerLane.Right,
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  })
  private readonly dim = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor('editor.wordHighlightBackground'), borderRadius: '3px',
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  })
  private readonly subs: vscode.Disposable[]
  /** What is lit, by document: its ranges in each style (with the marks' text, for tests). */
  private shown = new Map<string, { focus: vscode.Range[]; dim: vscode.Range[] }>()
  /** What `show` was asked for last (the same again: nothing to do). */
  private sig = ''
  private seq = 0
  /** Where each mark was found, by document version and mark. */
  private spots = new Map<string, MarkSpot | null>()
  /** Marks already said in the log (moved, not found, skipped). */
  private said = new Set<string>()

  constructor(private readonly log: vscode.LogOutputChannel) {
    this.subs = [this.focus, this.dim, vscode.window.onDidChangeVisibleTextEditors(() => this.paint())]
  }

  /** Nothing lit. */
  clear(): void {
    this.seq++
    this.sig = ''
    if (!this.shown.size) return
    this.shown.clear()
    this.paint()
  }

  /**
   * Lights `plan`'s marks that are lit at `t` (the rest of the segment's are not): the newest as the focus. `sig`
   * names the segment (a new one clears the marks before). `bring(m, range)`: called for a mark that just lit
   * (`fresh`), to bring it on screen when the reader is following.
   */
  async show(sig: string, plan: PlannedMark[], t: number, fresh: (m: PlannedMark, r: vscode.Range, doc: vscode.TextDocument) => Promise<void>): Promise<void> {
    const live = plan.filter((p) => !p.skip)
    const { lit, focusFrom } = marksAt(live.map((p) => p.time), t)
    const key = `${sig}|${lit}`
    if (key === this.sig) return
    const before = this.sig.startsWith(`${sig}|`) ? Number(this.sig.slice(sig.length + 1)) : 0
    this.sig = key
    const mine = ++this.seq
    for (const p of plan) if (p.skip && p.time <= t) this.once(`${sig}|skip|${p.time}|${p.file}`, `podcast: a mark in ${p.file} at ${p.time.toFixed(2)} s is skipped: it would switch files within the view hold`, 'debug')
    const next = new Map<string, { focus: vscode.Range[]; dim: vscode.Range[] }>()
    const placed: { p: PlannedMark; r: vscode.Range; doc: vscode.TextDocument; k: number }[] = []
    for (let k = 0; k < lit; k++) {
      const p = live[k]
      let doc: vscode.TextDocument
      try { doc = await vscode.workspace.openTextDocument(p.uri) } catch {
        this.once(`${sig}|open|${p.file}`, `podcast: a mark's file ${p.file} can't be opened`)
        continue
      }
      if (mine !== this.seq) return
      const r = this.rangeOf(doc, p, `${sig}|${k}`)
      if (!r) continue
      const at = next.get(doc.uri.toString()) ?? { focus: [], dim: [] }
      ;(k >= focusFrom ? at.focus : at.dim).push(r)
      next.set(doc.uri.toString(), at)
      placed.push({ p, r, doc, k })
    }
    this.shown = next
    this.paint()
    // Marks lit just now, playing on (not a seek elsewhere in the segment): the newest is brought on screen.
    const newest = placed.filter((x) => x.k >= focusFrom && x.k >= before)
    if (newest.length && lit > before) await fresh(newest[0].p, newest[0].r, newest[0].doc)
  }

  /** Where a mark is in `doc` now: its match (re-found if the code moved), else its whole lines; none past the end. */
  private rangeOf(doc: vscode.TextDocument, p: PlannedMark, key: string): vscode.Range | undefined {
    const id = `${doc.uri.toString()}@${doc.version}|${p.mark.lines.join('-')}|${p.mark.match ?? ''}|${p.mark.nth ?? 1}`
    let spot = this.spots.get(id)
    if (spot === undefined) {
      const f = findMark(docLines(doc), p.mark)
      spot = f?.spot ?? null
      const where = `${p.file}:${p.mark.lines[0]}${p.mark.lines[1] !== p.mark.lines[0] ? `-${p.mark.lines[1]}` : ''}`
      if (!f) this.once(key, `podcast: mark "${p.mark.phrase}": ${where} is past the end of the file; nothing lit`)
      else if (!f.found) this.once(key, `podcast: mark "${p.mark.phrase}": ${JSON.stringify(p.mark.match)} isn't at ${where} nor within 20 lines; its lines are lit`)
      else if (f.moved) this.once(key, `podcast: mark "${p.mark.phrase}": ${JSON.stringify(p.mark.match)} moved ${Math.abs(f.moved)} lines ${f.moved < 0 ? 'up' : 'down'} from ${where}; lit there`)
      if (this.spots.size > 500) this.spots.clear()
      this.spots.set(id, spot)
    }
    return spot ? new vscode.Range(spot.line, spot.col, spot.endLine, spot.endCol) : undefined
  }

  private once(key: string, line: string, level: 'info' | 'debug' = 'info'): void {
    if (this.said.has(key)) return
    this.said.add(key)
    if (this.said.size > 2000) this.said.clear()
    this.log[level](line)
  }

  private paint(): void {
    for (const e of vscode.window.visibleTextEditors) {
      const s = this.shown.get(e.document.uri.toString())
      setDecorations(e, this.focus, s?.focus ?? [])
      setDecorations(e, this.dim, s?.dim ?? [])
    }
  }

  /** For tests: what is lit, with its text. */
  lit(): LitMark[] {
    const out: LitMark[] = []
    for (const [uri, s] of this.shown) {
      const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri)
      const file = vscode.workspace.asRelativePath(vscode.Uri.parse(uri), false)
      for (const [style, rs] of [['focus', s.focus], ['dim', s.dim]] as const) {
        for (const r of rs) out.push({ file, line: r.start.line, col: r.start.character, endLine: r.end.line, endCol: r.end.character, text: doc?.getText(r) ?? '', style })
      }
    }
    return out
  }

  dispose(): void { for (const s of this.subs) s.dispose() }
}
