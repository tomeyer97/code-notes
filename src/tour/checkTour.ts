// A check's tour (src/check/): a journey of the change; its questions are stops between the steps.

import * as vscode from 'vscode'
import { cmdLink, journeys, mapPanel, understanding } from '../app'
import { Check } from '../check/types'
import { seeAlso } from '../journeyList'
import { LoadedJourney } from '../journeys/steps'
import { listItems } from '../sidebar/listModel'
import { endTour } from './open'
import { card, tour, walk } from './tour'

export const qDone = (st: string) => st === 'pass' || st === 'explained' || st === 'restated'

/** The stops of a check's tour in order: each step, then the questions placed after it that are still open (and the
 *  one the walk is at, even once it is done). */
export function stopsOf(lj: LoadedJourney): { step: number; q?: string }[] {
  const qs = lj.check ? understanding?.tourStops() ?? [] : []
  const out: { step: number; q?: string }[] = []
  for (const s of lj.j.steps) {
    out.push({ step: s.n })
    for (const q of qs) if (q.step === s.n && (!qDone(q.state) || (q.id === tour.cp && tour.step === s.n && tour.key === lj.key))) out.push({ step: s.n, q: q.id })
  }
  return out
}

/** The stop after where the walk is (for the card's Next). */
export function nextStop(lj: LoadedJourney): { step: number; q?: string } | undefined {
  const stops = stopsOf(lj)
  let i = stops.findIndex((x) => x.step === tour.step && x.q === tour.cp)
  if (i < 0) i = stops.findIndex((x) => x.step === tour.step && !x.q)
  return i < 0 ? undefined : stops[i + 1]
}

/** A question of the tour: its step (code and card), the map on it, then the question's thread with the keyboard in it. */
export async function openCheckpoint(lj: LoadedJourney, id: string): Promise<boolean> {
  const q = understanding?.tourStops().find((x) => x.id === id)
  if (!q || q.step > lj.j.steps.length) return false
  // The panel follows only when it is open: a question never opens it (the code keeps its room).
  if (mapPanel.journey && mapPanel.journey.key !== lj.key) walk.showMap(lj, true)
  if (!(tour.key === lj.key && tour.step === q.step)) await walk.goToStep(lj, q.step, { focus: false })
  tour.cp = id
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
  return lj && s ? cmdLink(`${lj.j.title.replace(/[[\]]/g, '')}, step ${hit!.step}`, 'codeNotes.openStepLink', lj.j.id, s.id, hit!.step) : undefined
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
    if (old && mapPanel.journey?.key === old.key) { if (old.key === tour.key && tour.step) await endTour(); mapPanel.close() }
    await journeys.setTour(f, checkTour.uri, undefined, checkTour.branch)
    checkTour = undefined
  }
  if (!uri || !branch) return
  const lj = await journeys.setTour(f, uri, check?.journey, branch)
  checkTour = lj ? { uri, branch } : undefined
  // Its questions' states (the storyline's rows, the card's Next) follow the check.
  if (lj) { mapPanel.update(); if (lj.key === tour.key && tour.step) card.show(lj, tour.step) }
}
