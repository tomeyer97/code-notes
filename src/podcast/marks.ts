// Marks (docs/podcast-format.md, "Marks"): word-timed highlights within a segment. While the voice says a phrase, the
// code it names lights: whole lines, or only a `match` within them (the shape, and how marks look, are shared with a
// journey's own marks: marks/model.ts, marks/lights.ts). The newest mark (with any said with the same phrase) is the
// focus, the one coloured tint on the code; the segment's earlier marks stay, lighter (while it plays the beat's own
// line box is not drawn: beats.ts `quiet`). The next segment clears them. At any time T exactly the marks lit by T in
// the segment playing at T show (also paused, after a seek); the timing is precomputed per segment (model.ts
// markTimes, planMarks), so a time report costs a few comparisons. A mark in another file than the one on screen is a
// view change: the view hold applies (model.ts planMarks). Marks never scroll a reader who looks around on their own
// (the follow lock); otherwise a new mark is brought on screen only when it is off it.

import * as vscode from 'vscode'
import { LitMark, MarkPainter, noneShown, Shown } from '../marks/lights'
import { Mark, marksAt } from './model'

/** A segment's marks as the player plays them: each one's file, when it lights, and whether it is skipped (it would
 *  switch files within the view hold) or opens its file. */
export interface PlannedMark { mark: Mark; uri: vscode.Uri; file: string; time: number; skip: boolean; opens: boolean }

/** A segment's marks, lit as the audio plays (how they look: marks/lights.ts; a match not found lights its lines). */
export class MarkLights implements vscode.Disposable {
  private readonly painter: MarkPainter
  /** What `show` was asked for last (the same again: nothing to do). */
  private sig = ''
  private seq = 0

  constructor(log: vscode.LogOutputChannel) {
    this.painter = new MarkPainter(log, 'lines')
  }

  /** Nothing lit. */
  clear(): void {
    this.seq++
    this.sig = ''
    if (this.painter.empty) return
    this.painter.show(new Map())
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
    for (const p of plan) if (p.skip && p.time <= t) this.painter.once(`${sig}|skip|${p.time}|${p.file}`, `podcast: a mark in ${p.file} at ${p.time.toFixed(2)} s is skipped: it would switch files within the view hold`, 'debug')
    const next = new Map<string, Shown>()
    const placed: { p: PlannedMark; r: vscode.Range; doc: vscode.TextDocument; k: number }[] = []
    for (let k = 0; k < lit; k++) {
      const p = live[k]
      let doc: vscode.TextDocument
      try { doc = await vscode.workspace.openTextDocument(p.uri) } catch {
        this.painter.once(`${sig}|open|${p.file}`, `podcast: a mark's file ${p.file} can't be opened`)
        continue
      }
      if (mine !== this.seq) return
      const at = next.get(doc.uri.toString()) ?? noneShown()
      const rs = this.painter.add(at, doc, p.mark, k >= focusFrom ? 'focus' : 'dim', `podcast: mark ${JSON.stringify(p.mark.phrase)}`, `${sig}|${k}`)
      if (!rs.length) continue
      next.set(doc.uri.toString(), at)
      placed.push({ p, r: rs[0].union(rs[rs.length - 1]), doc, k })
    }
    this.painter.show(next)
    // Marks lit just now, playing on (not a seek elsewhere in the segment): the newest is brought on screen.
    const newest = placed.filter((x) => x.k >= focusFrom && x.k >= before)
    if (newest.length && lit > before) await fresh(newest[0].p, newest[0].r, newest[0].doc)
  }

  /** For tests: what is lit, with its text. */
  lit(): LitMark[] { return this.painter.lit() }

  dispose(): void { this.painter.dispose() }
}
