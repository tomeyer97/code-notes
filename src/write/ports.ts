// What writing and refreshing journeys needs from the features around it, given to write's activate (write/index.ts)
// and read by its modules through these getters.
import type { ClaudeLinks } from '../codeLinks/claudeChatLinks'
import type { Journeys } from '../journeys/journeys'
import type { MapPanel } from '../journeys/mapPanel'
import type { TourApi } from '../tour/api'
import { portsSlot } from '../platform/ports'

export interface WritePorts {
  journeys: Journeys
  mapPanel: MapPanel
  /** Lines of code an explanation points at, lit in the editor. */
  claudeLinks: ClaudeLinks
  /** A journey written or asked for opens like any: its map and its walk. */
  tour: Pick<TourApi, 'touring' | 'tourJourney' | 'walkJourney'>
  /** The Journeys view drawn again (a journey being written, refreshed or done). */
  refreshJourneyList(): void
}

const slot = portsSlot<WritePorts>('writing journeys')

/** write/index.ts only. */
export const useWritePorts = slot.set

export const journeys = () => slot.get().journeys
export const mapPanel = () => slot.get().mapPanel
export const claudeLinks = () => slot.get().claudeLinks
export const tour = () => slot.get().tour
export const refreshJourneyList = () => slot.get().refreshJourneyList()
