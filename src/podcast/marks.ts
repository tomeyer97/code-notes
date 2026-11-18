// Marks (docs/podcast-format.md, "Marks"): word-timed highlights within a segment. While the voice says a phrase, the
// code it names lights: whole lines, or only a `match` within them. The newest mark (with any said with the same
// phrase) is the focus, the one coloured tint on the code; the segment's earlier marks stay, lighter (while it plays
// the beat's own line box is not drawn: beats.ts `quiet`). The next segment clears them. At any time T exactly the marks lit by T in the segment playing at T show (also
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
/** What is lit in one document: ranges within lines, and whole lines, in each style. */
interface Shown { focus: vscode.Range[]; dim: vscode.Range[]; focusLines: vscode.Range[]; dimLines: vscode.Range[] }

export interface LitMark { file: string; line: number; col: number; endLine: number; endCol: number; text: string; style: 'focus' | 'dim' }

export class MarkLights implements vscode.Disposable {
  /**
   * One family, fills only (no borders, no bars, nothing in the scrollbar): a mark within a line is a tint over its
   * characters; a mark of whole lines tints the full lines as one block. The newest mark (the focus) is the one
   * coloured thing on the code (codeNotes.markBackground); the segment's earlier ones a lighter, grey tint.
   */
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
  /** What is lit, by document: its ranges in each style (with the marks' text, for tests). */
  private shown = new Map<string, Shown>()
  /** What `show` was asked for last (the same again: nothing to do). */
  private sig = ''
  private seq = 0
  /** Where each mark was found, by document version and mark. */
  private spots = new Map<string, (MarkSpot & { whole: boolean }) | null>()
  /** Marks already said in the log (moved, not found, skipped). */
  private said = new Set<string>()

  constructor(private readonly log: vscode.LogOutputChannel) {
    this.subs = [this.focus, this.dim, this.focusLines, this.dimLines, vscode.window.onDidChangeVisibleTextEditors(() => this.paint())]
  }

  /** Nothing lit. */
  clear(): void {
    this.seq++
    this.sig = ''
    if (!this.shown.size) return
    this.shown.clear()
    this.paint()
  }

  /** The next `show` lights its marks afresh: its newest is brought on screen again (the walk put back where the audio
   *  is). Nothing is cleared meanwhile. */
  again(): void {
    this.sig = ''
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
    const next = new Map<string, Shown>()
    const placed: { p: PlannedMark; r: vscode.Range; doc: vscode.TextDocument; k: number }[] = []
    for (let k = 0; k < lit; k++) {
      const p = live[k]
      let doc: vscode.TextDocument
      try { doc = await vscode.workspace.openTextDocument(p.uri) } catch {
        this.once(`${sig}|open|${p.file}`, `podcast: a mark's file ${p.file} can't be opened`)
        continue
      }
      if (mine !== this.seq) return
      const { ranges: rs, whole } = this.rangesOf(doc, p, `${sig}|${k}`)
      if (!rs.length) continue
      const at = next.get(doc.uri.toString()) ?? { focus: [], dim: [], focusLines: [], dimLines: [] }
      const style = k >= focusFrom ? 'focus' : 'dim'
      at[whole ? `${style}Lines` as const : style].push(...rs)
      next.set(doc.uri.toString(), at)
      placed.push({ p, r: rs[0].union(rs[rs.length - 1]), doc, k })
    }
    this.shown = next
    this.paint()
    // Marks lit just now, playing on (not a seek elsewhere in the segment): the newest is brought on screen.
    const newest = placed.filter((x) => x.k >= focusFrom && x.k >= before)
    if (newest.length && lit > before) await fresh(newest[0].p, newest[0].r, newest[0].doc)
  }

  /** Where a mark is in `doc` now: its match (re-found if the code moved), else its whole lines, each from its text
   *  (no box around indentation); none past the end. */
  private rangesOf(doc: vscode.TextDocument, p: PlannedMark, key: string): { ranges: vscode.Range[]; whole: boolean } {
    const spot = this.spotOf(doc, p, key)
    if (!spot) return { ranges: [], whole: false }
    const whole = spot.whole
    if (!whole) return { ranges: [new vscode.Range(spot.line, spot.col, spot.endLine, spot.endCol)], whole }
    const out: vscode.Range[] = []
    for (let l = spot.line; l <= spot.endLine; l++) {
      const text = doc.lineAt(l).text
      if (!text.trim()) continue
      out.push(new vscode.Range(l, text.length - text.trimStart().length, l, text.length))
    }
    return { ranges: out, whole }
  }

  private spotOf(doc: vscode.TextDocument, p: PlannedMark, key: string): (MarkSpot & { whole: boolean }) | undefined {
    const id = `${doc.uri.toString()}@${doc.version}|${p.mark.lines.join('-')}|${p.mark.match ?? ''}|${p.mark.nth ?? 1}`
    let spot = this.spots.get(id)
    if (spot === undefined) {
      const f = findMark(docLines(doc), p.mark)
      spot = f ? { ...f.spot, whole: !p.mark.match || !f.found } : null
      const where = `${p.file}:${p.mark.lines[0]}${p.mark.lines[1] !== p.mark.lines[0] ? `-${p.mark.lines[1]}` : ''}`
      if (!f) this.once(key, `podcast: mark "${p.mark.phrase}": ${where} is past the end of the file; nothing lit`)
      else if (!f.found) this.once(key, `podcast: mark "${p.mark.phrase}": ${JSON.stringify(p.mark.match)} isn't at ${where} nor within 20 lines; its lines are lit`)
      else if (f.moved) this.once(key, `podcast: mark "${p.mark.phrase}": ${JSON.stringify(p.mark.match)} moved ${Math.abs(f.moved)} lines ${f.moved < 0 ? 'up' : 'down'} from ${where}; lit there`)
      if (this.spots.size > 500) this.spots.clear()
      this.spots.set(id, spot)
    }
    return spot ?? undefined
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
