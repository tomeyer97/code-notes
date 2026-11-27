// A question answered with a journey: the one that answers it, a pick of a few that do, else (after a confirm) one
// written for it by Claude; or the panel's Journeys list. What happened is an Outcome (requests.ts tells the script).

import * as vscode from 'vscode'
import { journeys, mapPanel, tour } from './ports'
import { log, stored } from '../platform/host'
import { fireAndForget, showError } from '../platform/run'
import { agentRunner } from '../platform/agent/runner'
import { modelProblem } from '../platform/agent/claude'
import type { Via } from '../platform/agent/protocol'
import { LoadedJourney, posKey } from '../journeys/steps'
import { STATE } from '../platform/state'
import { chooseJourney, confirmWrite, matchJourneys } from './rank'
import { writeJourney } from './writeJourney'
import { journeyModel, modelLabel } from './claudeRun'

/** What answering a request did. */
export type Outcome =
  /** The panel's Journeys list. */
  | { kind: 'overview' }
  /** The journey that answers it opened. */
  | { kind: 'opened'; journey: LoadedJourney }
  /** Several answer it: a pick is showing. */
  | { kind: 'choose'; journeys: LoadedJourney[] }
  /** The journey picked from those opened (the script was told "choose"). */
  | { kind: 'picked'; journey: LoadedJourney }
  /** None answers it: "Write one with Claude?" is showing (`model`: its label). */
  | { kind: 'confirm'; model: string }
  /** Claude is writing one. */
  | { kind: 'writing'; model: string }
  /** The pick or the confirm was closed. */
  | { kind: 'cancelled' }
  /** Restricted Mode: Claude never runs here. */
  | { kind: 'untrusted' }
  | { kind: 'error'; message: string }
  /** A link asked and no journey answers it: a link never starts Claude. */
  | { kind: 'not-answered' }

/** Told of an outcome before the work behind it (a pick or a confirm showing, a journey opening): the script hears of
 *  it at once. The outcome returned at the end may repeat it. */
export type Report = (o: Outcome) => void

/** `lj` walked from step 1 (a question asks about the whole flow, not where it was left). */
async function openJourney(lj: LoadedJourney): Promise<void> {
  log().info(`explain: opening journey ${lj.j.id}`)
  await tour().walkJourney(lj, { fromStart: true })
}

/** Several journeys answer it about equally: a pick; the one picked opens. */
async function pickOne(q: string, found: LoadedJourney[], report: Report): Promise<Outcome> {
  report({ kind: 'choose', journeys: found })
  log().info(`explain: ${found.length} journeys answer it about equally: ${found.map((x) => x.j.id).join(', ')}: a pick`)
  const c = await chooseJourney(q, found)
  if (!c) return { kind: 'cancelled' }
  report({ kind: 'picked', journey: c })
  await openJourney(c)
  return { kind: 'picked', journey: c }
}

/** No journey answers it: the closest ones, or Write (Claude writes one in the background), or Cancel. */
async function confirmAndWrite(q: string, model: string | undefined, report: Report): Promise<Outcome> {
  const label = modelLabel(journeyModel(model))
  report({ kind: 'confirm', model: label })
  const c = await confirmWrite(q, model)
  if (!c) return { kind: 'cancelled' }
  const o: Outcome = c === 'write' ? { kind: 'writing', model: label } : { kind: 'opened', journey: c }
  report(o)
  if (c === 'write') fireAndForget(writeJourney(q, { model }), 'journey')
  else await openJourney(c)
  return o
}

/** A question: the first of these that applies. */
export async function answerQuestion(q: string, model: string | undefined, via: Via, report: Report): Promise<Outcome> {
  const found = matchJourneys(q)
  if (found.length > 1) return pickOne(q, found, report)
  if (found.length === 1) {
    // Told before the walk opens: the same request arriving meanwhile (a link and a file) gets this answer.
    report({ kind: 'opened', journey: found[0] })
    await openJourney(found[0])
    return { kind: 'opened', journey: found[0] }
  }
  // A link can come from any web page: it never starts Claude.
  if (via === 'uri') {
    log().info('explain: no journey answers it; a link never starts Claude: the overview')
    return { kind: 'not-answered' }
  }
  if (!agentRunner().trusted()) {
    agentRunner().allowed('write journeys')
    return { kind: 'untrusted' }
  }
  const bad = modelProblem(journeyModel(model))
  if (bad) {
    fireAndForget(showError(bad), 'requests: showError')
    return { kind: 'error', message: bad }
  }
  return confirmAndWrite(q, model, report)
}

/** The journey being walked, else the one the panel showed last, else the one marked "Start here", else the first. */
function currentOrLastJourney(): LoadedJourney | undefined {
  const all = journeys().all()
  return tour().tourJourney()
    ?? journeys().byPos(stored().get(STATE.mapJourney))
    ?? all.find((x) => x.j.start)
    ?? all[0]
}

/** The journey panel with its Journeys list in front, over currentOrLastJourney. */
export async function showJourneysHome(): Promise<void> {
  // The walk goes on: ending it right before a new card made VS Code's comment widgets loop ("Maximum call stack size
  // exceeded"). Choosing a journey switches as usual.
  const lj = currentOrLastJourney()
  if (!lj) {
    fireAndForget(vscode.window.showInformationMessage('Code Notes: no journeys in this workspace yet.'), 'requests: window.showInformationMessage')
    return
  }
  mapPanel().showHome(lj)
  fireAndForget(stored().set(STATE.mapJourney, posKey(lj)), 'requests: store mapJourney')
}
