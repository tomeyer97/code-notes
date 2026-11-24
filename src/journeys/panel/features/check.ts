// A check's tour in the journey panel: its questions on the storyline.

import type { CheckInfo } from '../../../protocol/map'
import type { LoadedJourney } from '../../steps'
import type { PanelFeature } from '../controller'
import { check } from '../../../tour/ports'
import { tourState, walk } from '../../../tour/instances'
import { openCheckpoint } from '../../../tour/checkTour'
import { byId } from '../../../notes/visible'
import { reveal } from '../../../notes/reveal'
import { fireAndForget } from '../../../platform/run'

export function checkFeature(): PanelFeature {
  return {
    name: 'the check\'s tour',
    handlers: {
      question: (_lj, m) => revealNoteById(m.id),
      checkpoint: (lj, m) => fireAndForget(openCheckpoint(lj, m.id), 'panel: openCheckpoint'),
      nextStop: () => fireAndForget(walk().stepBy(1), 'panel: walk.stepBy'),
    },
    slice: (lj): CheckInfo => (lj.check ? { stops: checkStops(lj) } : {}),
  }
}

/** A question row of the map: its note. */
function revealNoteById(id: string): void {
  const note = byId(id)
  if (note) fireAndForget(reveal(note), 'panel: reveal')
}

/** A check's tour: its questions, the one the walk is at marked `cur`. */
function checkStops(lj: LoadedJourney): NonNullable<CheckInfo['stops']> {
  const st = tourState()
  const atQuestion = (q: { id: string; step: number }) => lj.key === st.key && st.checkpointId === q.id && st.step === q.step
  return (check()?.tourStops() ?? []).map((q) => (atQuestion(q) ? { ...q, cur: true } : { ...q }))
}
