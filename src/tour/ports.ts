// What the tour needs from the features around it, given to its activate (createTour, index.ts) and read by the
// tour's modules through these getters. The check and the podcast come later (or never): those ports may be empty.
import type { Beats } from '../codeLinks/beats'
import type { CodeLinks } from '../codeLinks/codeLinks'
import type { ValueHints } from '../codeLinks/valueHints'
import type { CheckController } from '../check/controller'
import type { Journeys } from '../journeys/journeys'
import type { MapPanel } from '../journeys/mapPanel'
import type { Store } from '../notes/store'
import { portsSlot } from '../platform/ports'

/** What the tour asks of the understanding check (its tour's questions, the lenses on its question lines). */
export type TourCheck = Pick<CheckController, 'tourStops' | 'open' | 'openIn' | 'questionOf'>

export interface TourPorts {
  journeys: Journeys
  mapPanel: MapPanel
  beats: Beats
  codeLinks: CodeLinks
  valueHints: ValueHints
  store: Store
  /** The check, once it is started. */
  check(): TourCheck | undefined
  /** The code link lit is a check thread's (its Back goes to the question, not to a step). */
  isCheckLink(key: string): boolean
  /** The Journeys view drawn again (the list's sort changed on the map). */
  refreshJourneyList(): void
}

const slot = portsSlot<TourPorts>('the tour')

/** createTour only. */
export const useTourPorts = slot.set

export const journeys = () => slot.get().journeys
export const mapPanel = () => slot.get().mapPanel
export const beats = () => slot.get().beats
export const codeLinks = () => slot.get().codeLinks
export const valueHints = () => slot.get().valueHints
export const notesStore = () => slot.get().store
export const check = () => slot.get().check()
export const isCheckLink = (key: string) => slot.get().isCheckLink(key)
export const refreshJourneyList = () => slot.get().refreshJourneyList()
