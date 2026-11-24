// A walked step's marks (docs/journey-format.md, "Marks"): the parts of its code the step's text names, down to a few
// characters. Opening the step lights its own; each beat of its animation lights its own as the focus, the marks
// before it (the step's, earlier beats') dimmer: the same look as a podcast's marks (marks/lights.ts). While a step
// has marks to light, its lines get the thin grey bar and the beat its line without the box (card.ts, beats.ts).
// A mark whose match can't be found near its lines lights nothing, said once in the output.

import * as vscode from 'vscode'
import { journeys } from './ports'
import { stepFileUri } from '../journeys/codeGroup'
import { fileOf, LoadedJourney } from '../journeys/steps'
import { MarkPainter, noneShown, Shown } from '../marks/lights'
import { CodeMark, readMarks, walkMarks } from '../core/format/marks'

/** A mark to light: in which document, in which style; `who`/`key` name it in the output. */
export interface StepMark { mark: CodeMark; uri: string; style: 'focus' | 'dim'; who: string; key: string }

/**
 * What step n lights at beat `beat` (0-based; undefined: no beat lit). A mark's file: its own, else its beat's code
 * file, else the step's. Marks in the step's file move with the step (its lines found again, anchor.ts), then their
 * match is looked for within 20 lines. `say`: a mark that can't be read, said once.
 */
export function stepMarks(lj: LoadedJourney, n: number, beat: number | undefined, say: (key: string, line: string) => void): StepMark[] {
  const s = lj.j.steps[n - 1]
  if (!s) return []
  const read = (v: unknown, where: string) => {
    const r = readMarks(v)
    for (const p of r.problems) say(`${lj.key}|${s.id}|${where}|${p.k}`, `journey ${lj.j.id}: step ${n}${where}: ${p.what}`)
    return r.marks
  }
  const sceneBeats = s.scene?.beats ?? []
  const list = walkMarks(read(s.marks, ''), sceneBeats.map((b, i) => read(b.marks, `, beat ${i + 1}`)), beat)
  if (!list.length) return []
  const renames = journeys().renames(lj)
  const stepUri = vscode.Uri.joinPath(lj.folder.uri, fileOf(lj, n)).toString()
  const at = lj.at[n - 1]
  const shift = at && !at.stale && !at.removed ? at.start - s.range.start : 0
  const counts = new Map<number, number>()
  return list.map(({ mark, group, focus }) => {
    const k = counts.get(group) ?? 0
    counts.set(group, k + 1)
    const code = group >= 0 ? sceneBeats[group]?.code : undefined
    const file = mark.file ?? (typeof code?.file === 'string' ? code.file : undefined)
    const uri = file === undefined || file === s.file ? stepUri : stepFileUri(lj.folder.uri, renames, file).toString()
    const by = uri === stepUri ? shift : 0
    const moved: CodeMark = by ? { ...mark, lines: [mark.lines[0] + by, mark.lines[1] + by] } : mark
    const where = `step ${n}${group >= 0 ? `, beat ${group + 1}` : ''}, mark ${k + 1}`
    return { mark: moved, uri, style: focus ? 'focus' : 'dim', who: `journey ${lj.j.id}: ${where}`, key: `${lj.key}|${s.id}|${where}` }
  })
}

/** Lights `marks` in the visible editors showing their documents (marks elsewhere light when theirs is shown). */
export function paintStepMarks(painter: MarkPainter, marks: StepMark[]): void {
  const next = new Map<string, Shown>()
  for (const e of vscode.window.visibleTextEditors) {
    const uri = e.document.uri.toString()
    if (next.has(uri)) continue
    const mine = marks.filter((m) => m.uri === uri)
    if (!mine.length) continue
    const at = noneShown()
    for (const m of mine) painter.add(at, e.document, m.mark, m.style, m.who, m.key)
    next.set(uri, at)
  }
  if (!next.size && painter.empty) return
  painter.show(next)
}
