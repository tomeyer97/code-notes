// A question asked from a journey step: its "About the step …" line becomes a link back to that step ("↩ Step 3 ·
// <journey>"); none on that very step while it is walked, where the card is right there.
import type { Journeys } from '../../journeys/journeys'
import { HiddenCmd } from '../../platform/commands'
import { journeyOfNote, stepLinkOf } from '../../notes/model/journeyLink'
import type { Note } from '../../notes/store'
import type { TourApi } from '../../tour/api'
import type { Links } from '../links'
import type { ThreadContribution } from '../rows'
import { aboutStepLine } from '../text'

/** The journey's title the note keeps with its step (`extra.journey.title`), when it does. */
function keptTitle(n: Note): string | undefined {
  const t = (n.data.extra?.journey as { title?: unknown } | undefined)?.title
  return typeof t === 'string' ? t : undefined
}

function backToStep(n: Note, body: string, links: Links, journeys: Journeys, tour: Pick<TourApi, 'state' | 'touring'>) {
  const sl = stepLinkOf(n)
  const line = sl && aboutStepLine(body)
  if (!sl || !line) return undefined
  const lj = journeyOfNote(n, journeys.list.values())
  const walking = !!lj && tour.touring() && tour.state.key === lj.key
  if (walking && (sl.step ? tour.state.stepId === sl.step : tour.state.step === sl.n)) return { body: line.beforeBlank, suffix: '' }
  // The step's number now (found by id), else the one it had.
  const i = lj && sl.step ? lj.j.steps.findIndex((x) => x.id === sl.step) : -1
  const title = keptTitle(n) ?? line.journeyTitle
  const label = `↩ Step ${i >= 0 ? i + 1 : sl.n}${walking ? '' : ` · ${title}`}`
  const link = links.titled(label, "Open this step on the journey's map", HiddenCmd.openStepLink, sl.id, sl.step ?? '', sl.n, n.folder.uri.toString())
  return { body: line.before, suffix: link }
}

export function stepLinkRows(journeys: () => Journeys, tour: () => Pick<TourApi, 'state' | 'touring'>): ThreadContribution {
  return {
    message: (n, index) => (index === 0 && stepLinkOf(n)
      ? { lastLine: (body, links) => backToStep(n, body, links, journeys(), tour()) }
      : undefined),
  }
}
