// What the Code Notes and Journeys views need from the features they show, given to the sidebar's activate
// (sidebar/index.ts) and read by its modules through these getters.
import type { Journeys } from '../journeys/journeys'
import type { MapPanel } from '../journeys/mapPanel'
import type { LoadedJourney } from '../journeys/steps'
import type { Store } from '../notes/store'
import type { PodcastStatus, TourApi } from '../tour/api'
import { portsSlot } from '../platform/ports'

export interface SidebarPorts {
  journeys: Journeys
  mapPanel: MapPanel
  store: Store
  /** Where the walk is and where each journey was left; opening a journey from its row. */
  tour: Pick<TourApi, 'state' | 'touring' | 'tourJourney' | 'positions' | 'resumeAt' | 'walkJourney'>
  /** A journey's podcast (its row's ♪ and ▶), once the podcast player is started. */
  podcastStatus(lj: LoadedJourney): PodcastStatus | undefined
}

const slot = portsSlot<SidebarPorts>('the views')

/** sidebar/index.ts only. */
export const useSidebarPorts = slot.set

export const journeys = () => slot.get().journeys
export const mapPanel = () => slot.get().mapPanel
export const notesStore = () => slot.get().store
export const tour = () => slot.get().tour
export const podcastStatus = (lj: LoadedJourney) => slot.get().podcastStatus(lj)
