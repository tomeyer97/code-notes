// What the tour follows: the notes (a question asked or answered on the step being walked), the journeys (their files
// and where their steps are), the editors on screen and the tabs opened next to the map.

import * as vscode from 'vscode'
import type { Journeys } from '../journeys/journeys'
import type { MapPanel } from '../journeys/mapPanel'
import { LoadedJourney } from '../journeys/steps'
import { NotesApi, whileTyping } from '../notes/model'
import { WorkspaceEvents } from '../platform/events'
import { fireAndForget } from '../platform/run'
import { card, tourState, walk } from './instances'
import { keepOffMap } from './panelLayout'

/** The journeys and their map panel. */
export interface TourPorts { journeys: Journeys; mapPanel: MapPanel }

export function tourFollows(model: NotesApi, events: WorkspaceEvents, { journeys, mapPanel }: TourPorts): vscode.Disposable {
  return vscode.Disposable.from(
    model.onDidChange((c) => {
      if (whileTyping(c)) return
      walk.updateTour()
      // A question on the current step was asked or answered on disk: the card says so.
      if (c.kind !== 'disk' && c.kind !== 'loaded') return
      const tj = walk.touring() ? walk.tourJourney() : undefined
      if (tj && !card.inMap(tj, tourState.step)) card.show(tj, tourState.step)
    }),
    journeys.onDidChange(() => {
      card.lensChanged.fire()
      for (const lj of journeys.list.values()) mapPanel.update(lj)
      // The journey file was rewritten: the same step (by id), with its new text.
      walk.followStep()
    }),
    journeys.onDidMoveSteps((lj) => {
      card.lensChanged.fire()
      mapPanel.update()
      if (lj.key === tourState.key && tourState.step) card.show(lj, tourState.step)
      card.refreshDecorations()
    }),
    events.onDidChangeVisibleEditors(() => card.restore()),
    events.onDidOpenTabs((tabs) => { for (const t of tabs) fireAndForget(keepOffMap(t), 'tour: keep tabs off the map') }),
  )
}

/** Steps followed their code into other files (or went stale) after a change on disk: the map, and the card of the
 *  step being walked, follow. */
export const stepsFollowed = (mapPanel: MapPanel) => async (changed: LoadedJourney[]): Promise<void> => {
  for (const lj of changed) {
    mapPanel.update()
    if (lj.key === tourState.key && tourState.step) { await card.checkRefs(lj, tourState.step); card.show(lj, tourState.step) }
  }
  card.refreshDecorations()
}
