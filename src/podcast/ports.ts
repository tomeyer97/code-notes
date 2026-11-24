// What the podcast player needs from the features around it, given to podcast's activate (podcast/index.ts) and read
// by its modules through these getters. The player drives the walk only through the TourApi.
import type { Beats } from '../codeLinks/beats'
import type { Journeys } from '../journeys/journeys'
import type { MapPanel } from '../journeys/mapPanel'
import type { TourApi } from '../tour/api'
import { portsSlot } from '../platform/ports'

export interface PodcastPorts {
  journeys: Journeys
  mapPanel: MapPanel
  beats: Beats
  tour: TourApi
  /** The Journeys view drawn again (a row's ♪ listening or paused). */
  refreshJourneyList(): void
}

const slot = portsSlot<PodcastPorts>('the podcast player')

/** podcast/index.ts only. */
export const usePodcastPorts = slot.set

export const journeys = () => slot.get().journeys
export const mapPanel = () => slot.get().mapPanel
export const beats = () => slot.get().beats
export const tour = () => slot.get().tour
export const refreshJourneyList = () => slot.get().refreshJourneyList()
