// What the check's wiring needs from the features around it, given to the check's activate (check/index.ts), and the
// controller it made; read through these getters.
import type { MapPanel } from '../journeys/mapPanel'
import type { Store } from '../notes/store'
import type { TourApi } from '../tour/api'
import type { CheckController } from './controller'
import { portsSlot } from '../platform/ports'

export interface CheckPorts {
  store: Store
  mapPanel: MapPanel
  /** The check's tour is walked like a journey; its questions are stops of it. */
  tour: Pick<TourApi, 'codeColumn' | 'checkTour' | 'checkTourChanged' | 'openCheckpoint' | 'walkJourney' | 'lensesChanged'>
  /** The Journeys view drawn again (the check's row). */
  refreshJourneyList(): void
}

const slot = portsSlot<CheckPorts & { controller: CheckController }>('the understanding check')

/** check/index.ts only. */
export const useCheckPorts = slot.set

export const checkPorts = (): CheckPorts => slot.get()
export const controller = () => slot.get().controller
/** The controller, or undefined before the check started (code links and D / A ask before). */
export const started = () => (slot.ready ? slot.get().controller : undefined)
