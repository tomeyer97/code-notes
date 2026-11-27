// A check's tour (src/check/): a journey of the change; its questions are stops between the steps.

import * as vscode from 'vscode'
import { check, journeys, mapPanel } from './ports'
import { card, tourState, walk } from './instances'
import { Check, isDone } from '../check/types'
import { Block, blockAt } from '../core/codeBlocks'
import { seeAlso } from '../core/list/journeyList'
import { mdLabel } from '../core/mdLabel'
import { LoadedJourney } from '../journeys/steps'
import { notesFor } from '../notes/location'
import { Note } from '../notes/store'
import { listItems } from '../sidebar/listModel'
import { endJourney } from './commands'
import type { QuietLines } from './lenses'
import { stepLink } from './stepLink'


/** A stop of a check's tour: a step, or a question `q` placed after it. */
export interface Stop { step: number; q?: string }

/** The stops of a check's tour in order: each step, then the questions placed after it that are still open (and the
 *  one the walk is at, even once it is done). */
export function stopsOf(lj: LoadedJourney): Stop[] {
  const qs = lj.check ? check()?.tourStops() ?? [] : []
  const out: Stop[] = []
  // The question the walk is at stays a stop once answered (the walk goes on from it).
  const walkIsAt = (q: { id: string; step: number }) => q.id === tourState().checkpointId && tourState().isAt(lj, q.step)
  for (const s of lj.j.steps) {
    out.push({ step: s.n })
    for (const q of qs) if (q.step === s.n && (!isDone(q.state) || walkIsAt(q))) out.push({ step: s.n, q: q.id })
  }
  return out
}

/** Where the walk is among the stops: at its question, else on its step (-1: neither). */
function stopIndex(stops: Stop[]): number {
  const atQuestion = stops.findIndex((x) => x.step === tourState().step && x.q === tourState().checkpointId)
  return atQuestion >= 0 ? atQuestion : stops.findIndex((x) => x.step === tourState().step && !x.q)
}

/** The stop after where the walk is (for the card's Next). */
export function nextStop(lj: LoadedJourney): Stop | undefined {
  const stops = stopsOf(lj)
  const i = stopIndex(stops)
  return i < 0 ? undefined : stops[i + 1]
}

/** The stop `dir` away from where the walk is (Next and Previous); from neither, Next is the first stop. */
export function stopBy(lj: LoadedJourney, dir: 1 | -1): Stop | undefined {
  const stops = stopsOf(lj)
  return stops[stopIndex(stops) + dir]
}

/** A question of the tour: its step (code and card), the map on it, then the question's thread with the keyboard in it.
 *  The walk has no "go to a question" of its own yet, so this moves it and then shows the question on each surface. */
export async function openCheckpoint(lj: LoadedJourney, id: string): Promise<boolean> {
  const q = check()?.tourStops().find((x) => x.id === id)
  if (!q || q.step > lj.j.steps.length) return false
  // The panel follows only when it is open: a question never opens it (the code keeps its room).
  const shown = mapPanel().journey
  if (shown && shown.key !== lj.key) walk().showMap(lj, true)
  if (!(tourState().key === lj.key && tourState().step === q.step)) await walk().goToStep(lj, q.step, { focus: false })
  tourState().checkpointId = id
  card().show(lj, tourState().step)
  mapPanel().update()
  await check()!.open(id)
  return true
}

/** "See also" for a check's question or its tour's last step: a journey of the repo walking that code (no model call). */
export function seeAlsoLink(files: string[], span?: { start: number; end: number }): string | undefined {
  const hit = seeAlso(listItems(), files, span)
  if (!hit) return undefined
  const lj = journeys().list.get(hit.key)
  const s = lj?.j.steps[hit.step - 1]
  if (!lj || !s) return undefined
  const target = { journey: lj.j.id, step: s.id, n: hit.step, folder: lj.folder.uri.toString() }
  return stepLink(`${mdLabel(lj.j.title)}, step ${hit.step}`, target)
}

/** The check's tour on this branch (one at a time): the check file it is read from, and its journey's key as the
 *  journeys gave it (setTour). */
export class CheckTours {
  private shown: { uri: vscode.Uri; branch: string; key: string } | undefined

  /** The check's tour now, if any. */
  current(): LoadedJourney | undefined {
    return this.shown ? journeys().list.get(this.shown.key) : undefined
  }

  /** The check's tour follows the check: another branch's (or none) goes; this branch's is read, and the map and the
   *  card follow its questions' states (the storyline's rows, the card's Next). */
  async changed(check: Check | undefined, file: string | undefined, branch: string | undefined): Promise<void> {
    const f = vscode.workspace.workspaceFolders?.[0]
    if (!f) return
    const uri = file ? vscode.Uri.file(file) : undefined
    // Another branch (or no check): the last one's tour goes.
    if (this.shown && (!uri || this.shown.uri.toString() !== uri.toString())) {
      const old = this.current()
      if (old && mapPanel().journey?.key === old.key) {
        if (old.key === tourState().key && tourState().step) await endJourney()
        mapPanel().close()
      }
      await journeys().setTour(f, this.shown.uri, undefined, this.shown.branch)
      this.shown = undefined
    }
    if (!uri || !branch) return
    const lj = await journeys().setTour(f, uri, check?.journey, branch)
    this.shown = lj ? { uri, branch, key: lj.key } : undefined
    // Its questions' states (the storyline's rows, the card's Next) follow the check.
    if (!lj) return
    mapPanel().update()
    if (lj.key === tourState().key && tourState().step) card().show(lj, tourState().step)
  }
}

/** Lines within this many of an open question's (outside any function) are the question's. */
const NEAR_QUESTION_LINES = 2

/**
 * An open check question: the code it asks about is the only thing in view there, so the journey lenses step aside.
 * True for a lens line in the function of such a question (or near it, outside any function); the rest of the file
 * keeps its lenses.
 */
export const checkQuietLines: QuietLines = (doc: vscode.TextDocument, blocks: Block[]) => {
  const c = check()
  const open = new Set(c?.openIn(doc.uri) ?? [])
  const isOpenQuestion = (n: Note) => open.has(c?.questionOf(n)?.id ?? '')
  const asked = open.size ? notesFor(doc.uri).filter(isOpenQuestion).map((n) => n.data.range) : []
  return (line) => asked.some((r) => {
    const b = blockAt(r.start - 1, blocks)
    return b ? b.start === line : Math.abs(r.start - 1 - line) <= NEAR_QUESTION_LINES
  })
}
