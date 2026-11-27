// What shows the walk, following it: the walk (walk.ts) says where the reader is and what happened; these listeners
// keep the notes asked from steps, the context keys, the step lenses, the map, the status item, the views and the
// code's lights in step. A new thing a step paints subscribes here instead of being cleared by hand where the walk ends.
import type * as vscode from 'vscode'
import type { Beats } from '../codeLinks/beats'
import type { CodeLinks } from '../codeLinks/codeLinks'
import type { ValueHints } from '../codeLinks/valueHints'
import type { Journeys } from '../journeys/journeys'
import type { MapPanel } from '../journeys/mapPanel'
import { setCtx } from '../platform/context'
import { fireAndForget } from '../platform/run'
import { tree } from '../sidebar/notesTree'
import type { StepCard } from './card'
import type { TourState } from './state'
import type { TourStatusItem } from './status'
import { syncStepNotes } from './stepNotes'
import type { Walk } from './walk'

export interface WalkSurfaces {
  state: TourState
  card: StepCard
  status: TourStatusItem
  lenses: { changed(): void }
  journeys: Journeys
  mapPanel: MapPanel
  beats: Beats
  codeLinks: CodeLinks
  valueHints: ValueHints
}

/** Subscribes what shows the walk to it. In order: the podcast (TourApi.onDidMove) subscribes later, so it runs last. */
export function followTheWalk(walk: Walk, s: WalkSurfaces): vscode.Disposable[] {
  return [
    walk.onDidChange(() => {
      // A step question's back-link says less while you walk its journey.
      syncStepNotes()
      fireAndForget(setCtx('codeNotes.journeyActive', walk.touring()), 'walk: setCtx codeNotes.journeyActive')
      s.lenses.changed() // the step lenses show only outside a walk
      fireAndForget(setCtx('codeNotes.hasJourneys', s.journeys.all().length > 0), 'walk: setCtx codeNotes.hasJourneys')
      s.mapPanel.update()
      renderStatus(walk, s)
      // The Notes and Journeys views: the running journey's row, where it was left (debounced by the view).
      tree?.refresh()
    }),
    walk.onDidEnd((reason) => {
      // The reader's End: the step's code links, value hints and lit beat go (the code you were reading stays open).
      if (reason === 'ended') {
        s.codeLinks.clear()
        s.valueHints.clear()
        s.beats.clear()
      }
      s.card.clear()
    }),
  ]
}

/** The status item for where the walk is (also when a journey starts or stops being listened to). */
export function renderStatus(walk: Walk, s: Pick<WalkSurfaces, 'state' | 'status'>): void {
  const lj = walk.tourJourney()
  s.status.render(lj, s.state.step, !!lj && walk.listening(lj))
}
