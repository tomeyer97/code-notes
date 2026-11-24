// The map's tutorial: which card it shows, and the step card it points at in the editor.

import * as vscode from 'vscode'
import { journeys, mapPanel } from './ports'
import { card, tourState, tutorialSpot, walk } from './instances'
import { stored } from '../platform/host'
import { MapMessage } from '../journeys/mapPanel'
import { fileOf, LoadedJourney } from '../journeys/steps'
import { openMap } from './commands'
import { pickJourney } from './pick'
import { fireAndForget } from '../platform/run'
import { STATE } from '../platform/state'

/** What the map's tutorial shows (for the integration test). */
const NOT_SEEN = { bar: 0, card: 0, done: 0, skip: 0, inside: 0 }
export const tutorialSeen = { ...NOT_SEEN }

/** What the tutorial is pointing at in the step card now. */
export let tutorialMark: '' | 'card' | 'links' = ''

/** The tutorial's card about the step card: a step open in the editor (where the walk is, else where it would start),
 *  its lines boxed, so the card above them is found at a glance. */
async function tutorialInEditor(lj: LoadedJourney, what: 'card' | 'links'): Promise<void> {
  // The card itself shows it: its buttons, or its linked phrases, on the search-match colour while the tutorial says so.
  tutorialMark = what
  const n = walk().startStep(lj)
  await walk().goToStep(lj, n, { focus: false })
  const at = lj.at[n - 1]
  // The card moved on while the file opened: nothing.
  if (!at || !tutorialSeen.card) return
  card().show(lj, n)
  tutorialSpot().show(vscode.Uri.joinPath(lj.folder.uri, fileOf(lj, n)), at.start - 1, at.end - 1)
}

/** The tutorial left the editor: no box, and the card as it normally looks. */
function tutorialOutOfEditor(): void {
  tutorialSpot().clear()
  if (!tutorialMark) return
  tutorialMark = ''
  const lj = walk().tourJourney()
  if (lj && tourState().step) card().show(lj, tourState().step)
}

/** Code Notes: Journey Tutorial: the map (the tour's, the last one, or picked) with the tutorial from card 1. */
export async function tutorial(): Promise<void> {
  const lj = walk().tourJourney() ?? journeys().byPos(stored().get(STATE.mapJourney)) ?? (await pickJourney())
  if (!lj) return
  await openMap(lj)
  mapPanel().send({ type: 'tutorial' })
}

/** A message from the map's tutorial: a card shown (and what it points at in the editor), skipped or done. */
export function onTutorial(lj: LoadedJourney, m: Extract<MapMessage, { type: 'tutorial' }>): void {
  if (m.action === 'bar') tutorialSeen.bar++
  if (m.action === 'card') {
    tutorialSeen.card = m.card ?? 0
    tutorialSeen.inside = m.inside ? 1 : 0
    if (m.editor) fireAndForget(tutorialInEditor(lj, m.editor === 'links' ? 'links' : 'card'), 'tutorial: tutorialInEditor')
    else tutorialOutOfEditor()
  }
  if (m.action === 'skip' || m.action === 'done') {
    tutorialSeen.card = 0
    tutorialSeen[m.action]++
    tutorialOutOfEditor()
    fireAndForget(stored().set(STATE.tutorialSeen, true).then(() => mapPanel().update()), 'tutorial: store tutorialSeen')
  }
  // Finish walks the steps: from where the tour is, else where the map's button would start.
  if (m.action === 'done') fireAndForget(walk().goToStep(lj, walk().startStep(lj), { focus: false }), 'tutorial: walk.goToStep')
}

/** The tutorial as never seen (for the integration test). */
export async function resetTutorial(): Promise<void> {
  await stored().set(STATE.tutorialSeen, undefined)
  Object.assign(tutorialSeen, NOT_SEEN)
}
