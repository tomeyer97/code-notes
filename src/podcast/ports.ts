// What the podcast player needs from the features around it, given to podcast's activate (podcast/index.ts) and
// passed on to the player's parts. The player drives the walk only through the TourApi.
import type { Beats } from '../codeLinks/beats'
import type { Journeys } from '../journeys/journeys'
import type { MapPanel } from '../journeys/mapPanel'
import type { TourApi } from '../tour/api'

export interface PodcastPorts {
  journeys: Journeys
  mapPanel: MapPanel
  beats: Beats
  tour: TourApi
  /** The Journeys view drawn again (a row's ♪ listening or paused). */
  refreshJourneyList(): void
}
