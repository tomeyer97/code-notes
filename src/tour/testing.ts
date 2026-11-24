// What the integration tests read of the tour (only outside Production: src/testApi.ts). Each tour object gives its
// own snapshot; this adds what lights the code around the walk.
import type { Beats } from '../codeLinks/beats'
import type { CodeLinks } from '../codeLinks/codeLinks'
import type { ValueHints } from '../codeLinks/valueHints'
import type { MapPanel } from '../journeys/mapPanel'
import { chordKey } from '../platform/chordKey'
import { stored } from '../platform/host'
import { STATE } from '../platform/state'
import type { TourFeature } from './index'

/** A map panel as VS Code hands one over after a reload; the tutorial as never seen. */
export { restorePanel } from './commands'
export { resetTutorial } from './tutorial'

export interface Around { mapPanel: MapPanel; beats: Beats; codeLinks: CodeLinks; valueHints: ValueHints }

/** The tour, the map, the card and what lights the code, as the tests read them. */
export function tourSnapshot({ parts }: TourFeature, { mapPanel, beats, codeLinks, valueHints }: Around) {
  const { state, probe, card, walk, items, spot, tutorial } = parts
  const lj = walk.tourJourney()
  const walking = walk.touring()
  const cardShot = card.snapshot()
  return {
    journey: lj?.j.id,
    touring: walking,
    ...state.snapshot(),
    ...mapPanel.snapshot(),
    beat: beats.lit,
    beatCode: beats.preview,
    /** The step's marks and its beat's as lit (tour/stepMarks.ts). */
    marks: cardShot.marks,
    stepLook: cardShot.stepLook,
    beatBoxed: beats.boxed,
    codeLinks: codeLinks.state,
    values: valueHints.state,
    status: items.pos.text,
    // None while its journey is listened to (the podcast's item then).
    statusShown: !!items.pos.text && walking && !(lj && walk.listening(lj)),
    tutorial: { ...tutorial.seen, seen: !!stored().get(STATE.tutorialSeen), spot: spot.shown, mark: tutorial.mark },
    key: chordKey(),
    lastLeft: probe.lastLeft,
    panelCard: walking && lj && card.inMap(lj, state.step) ? card.panelCard(lj, state.step) : undefined,
    peek: probe.lastPeek,
    marked: probe.marked,
    card: cardShot.card,
  }
}
