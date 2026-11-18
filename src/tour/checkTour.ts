// A check's tour (src/check/): a journey of the change; its questions are stops between the steps.

import * as vscode from 'vscode'
import { cmdLink, journeys, mapPanel, understanding } from '../app'
import { Check, QState } from '../checkModel'
import { seeAlso } from '../journeyList'
import { LoadedJourney } from '../journeys/steps'
import { listItems } from '../sidebar/listModel'
import { endTour } from './commands'
import { card, tour, walk } from './tour'

/**
 * A question of the check that needs no more answers: passed, explained, or said back in your own words. For every
 * QState it is the opposite of checkModel's notDone ('' and other strings: neither); checkModel's answerBox counts
 * only pass and restated as passed.
 */
export const questionDone = (state: QState | string) => state === 'pass' || state === 'explained' || state === 'restated'

/** A stop of a check's tour: a step, or a question `q` placed after it. */
export interface Stop { step: number; q?: string }

/** The stops of a check's tour in order: each step, then the questions placed after it that are still open (and the
 *  one the walk is at, even once it is done). */
export function stopsOf(lj: LoadedJourney): Stop[] {
  const qs = lj.check ? understanding?.tourStops() ?? [] : []
  const out: Stop[] = []
  // The question the walk is at stays a stop once answered (the walk goes on from it).
  const walkIsAt = (q: { id: string; step: number }) => q.id === tour.checkpointId && tour.isAt(lj, q.step)
  for (const s of lj.j.steps) {
    out.push({ step: s.n })
    for (const q of qs) if (q.step === s.n && (!questionDone(q.state) || walkIsAt(q))) out.push({ step: s.n, q: q.id })
  }
  return out
}

/** Where the walk is among the stops: at its question, else on its step (-1: neither). */
function stopIndex(stops: Stop[]): number {
  const atQuestion = stops.findIndex((x) => x.step === tour.step && x.q === tour.checkpointId)
  return atQuestion >= 0 ? atQuestion : stops.findIndex((x) => x.step === tour.step && !x.q)
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

/** A question of the tour: its step (code and card), the map on it, then the question's thread with the keyboard in it. */
export async function openCheckpoint(lj: LoadedJourney, id: string): Promise<boolean> {
  const q = understanding?.tourStops().find((x) => x.id === id)
  if (!q || q.step > lj.j.steps.length) return false
  // The panel follows only when it is open: a question never opens it (the code keeps its room).
  if (mapPanel.journey && mapPanel.journey.key !== lj.key) walk.showMap(lj, true)
  if (!(tour.key === lj.key && tour.step === q.step)) await walk.goToStep(lj, q.step, { focus: false })
  tour.checkpointId = id
  card.show(lj, tour.step)
  mapPanel.update()
  await understanding!.open(id)
  return true
}

/** The check's tour on this branch (one at a time), by its check file. */
let checkTour: { uri: vscode.Uri; branch: string } | undefined

export const currentTour = () => (checkTour ? journeys.list.get(`${checkTour.uri.toString()}#tour`) : undefined)

/** "See also" for a check's question or its tour's last step: a journey of the repo walking that code (no model call). */
export function seeAlsoLink(files: string[], span?: { start: number; end: number }): string | undefined {
  const hit = seeAlso(listItems(), files, span)
  const lj = hit && journeys.list.get(hit.key)
  const s = lj?.j.steps[hit!.step - 1]
  if (!lj || !s) return undefined
  const label = `${lj.j.title.replace(/[[\]]/g, '')}, step ${hit!.step}`
  return cmdLink(label, 'codeNotes.openStepLink', lj.j.id, s.id, hit!.step)
}

/** The check's tour follows the check: another branch's (or none) goes; this branch's is read, and the map and the
 *  card follow its questions' states (the storyline's rows, the card's Next). */
export async function tourChanged(check: Check | undefined, file: string | undefined, branch: string | undefined): Promise<void> {
  const f = vscode.workspace.workspaceFolders?.[0]
  if (!f) return
  const uri = file ? vscode.Uri.file(file) : undefined
  // Another branch (or no check): the last one's tour goes.
  if (checkTour && (!uri || checkTour.uri.toString() !== uri.toString())) {
    const old = currentTour()
    if (old && mapPanel.journey?.key === old.key) {
      if (old.key === tour.key && tour.step) await endTour()
      mapPanel.close()
    }
    await journeys.setTour(f, checkTour.uri, undefined, checkTour.branch)
    checkTour = undefined
  }
  if (!uri || !branch) return
  const lj = await journeys.setTour(f, uri, check?.journey, branch)
  checkTour = lj ? { uri, branch } : undefined
  // Its questions' states (the storyline's rows, the card's Next) follow the check.
  if (!lj) return
  mapPanel.update()
  if (lj.key === tour.key && tour.step) card.show(lj, tour.step)
}
