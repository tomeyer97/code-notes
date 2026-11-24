// What the check's wiring needs from the features around it, given to the check's activate (check/index.ts), which
// hands each wiring function the ports it uses.
import type { MapPanel } from '../journeys/mapPanel'
import type { Store } from '../notes/store'
import type { TourApi } from '../tour/api'

export interface CheckPorts {
  store: Store
  mapPanel: MapPanel
  /** The check's tour is walked like a journey; its questions are stops of it. */
  tour: Pick<TourApi, 'codeColumn' | 'checkTour' | 'checkTourChanged' | 'openCheckpoint' | 'walkJourney' | 'lensesChanged'>
  /** The Journeys view drawn again (the check's row). */
  refreshJourneyList(): void
}
