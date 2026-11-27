// A podcast segment's marks on the code, lit as the audio plays (how they look: marks/lights.ts; when they light:
// markScheduler.ts). The newest mark is the focus, the earlier ones of the segment stay, lighter.

import * as vscode from 'vscode'
import { LitMark, MarkPainter, noneShown, Shown } from '../marks/lights'
import { Mark, marksAt } from '../core/format/podcast/model'

/** A segment's marks as the player plays them: each one's file, when it lights, and whether it is skipped (it would
 *  switch files within the view hold) or opens its file. */
export interface PlannedMark { mark: Mark; uri: vscode.Uri; file: string; time: number; skip: boolean; opens: boolean }

/** A segment's marks, lit as the audio plays (how they look: marks/lights.ts; a match not found lights its lines). */
export class MarkLights implements vscode.Disposable {
  private readonly painter: MarkPainter
  /** What `show` lit last: the segment, and how many of its marks (the same again: nothing to do). */
  private shown: { segment: string; lit: number } | undefined
  private seq = 0

  constructor(log: vscode.LogOutputChannel) {
    this.painter = new MarkPainter(log, 'lines')
  }

  /** Nothing lit. */
  clear(): void {
    this.seq++
    this.shown = undefined
    if (this.painter.empty) return
    this.painter.show(new Map())
  }

  /** The next `show` lights its marks afresh: its newest is brought on screen again (the walk put back where the audio
   *  is). Nothing is cleared meanwhile. */
  again(): void {
    this.shown = undefined
  }

  /**
   * Lights `plan`'s marks that are lit at `t` (the rest of the segment's are not): the newest as the focus. `segment`
   * names the segment (a new one clears the marks before). `fresh(m, range)`: called for a mark that just lit, to
   * bring it on screen when the reader is following.
   */
  async show(segment: string, plan: PlannedMark[], t: number, fresh: (m: PlannedMark, r: vscode.Range, doc: vscode.TextDocument) => Promise<void>): Promise<void> {
    const live = plan.filter((p) => !p.skip)
    const { lit, focusFrom } = marksAt(live.map((p) => p.time), t)
    const last = this.shown
    if (last?.segment === segment && last.lit === lit) return
    // How many of this segment's marks were lit before (0: a new segment).
    const before = last?.segment === segment ? last.lit : 0
    this.shown = { segment, lit }
    const mine = ++this.seq
    for (const p of plan) if (p.skip && p.time <= t) this.painter.once(`${segment}|skip|${p.time}|${p.file}`, `podcast: a mark in ${p.file} at ${p.time.toFixed(2)} s is skipped: it would switch files within the view hold`, 'debug')
    const next = new Map<string, Shown>()
    const placed: { p: PlannedMark; r: vscode.Range; doc: vscode.TextDocument; k: number }[] = []
    for (let k = 0; k < lit; k++) {
      const p = live[k]
      let doc: vscode.TextDocument
      try { doc = await vscode.workspace.openTextDocument(p.uri) } catch {
        this.painter.once(`${segment}|open|${p.file}`, `podcast: a mark's file ${p.file} can't be opened`)
        continue
      }
      if (mine !== this.seq) return
      const at = next.get(doc.uri.toString()) ?? noneShown()
      const rs = this.painter.add(at, doc, p.mark, k >= focusFrom ? 'focus' : 'dim', `podcast: mark ${JSON.stringify(p.mark.phrase)}`, `${segment}|${k}`)
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
