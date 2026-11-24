// The journey panel's controller as the tour wires it: each feature of the panel (src/journeys/panel/features/)
// registers its messages and its part of what the panel shows; the Journeys list's state comes from the sidebar.

import type { FromMap as MapMessage, TourInfo } from '../protocol/map'
import type { LoadedJourney } from '../journeys/steps'
import { PanelController } from '../journeys/panel/controller'
import { authorFeature } from '../journeys/panel/features/author'
import { checkFeature } from '../journeys/panel/features/check'
import { listFeature } from '../journeys/panel/features/list'
import { podcastFeature } from '../journeys/panel/features/podcast'
import { viewFeature } from '../journeys/panel/features/view'
import { walkFeature } from '../journeys/panel/features/walk'
import { askedOf } from '../sidebar/journeyRows'
import { listModel, listState } from '../sidebar/listModel'
import { stored } from '../platform/host'
import { rememberPanelWidth } from './panelLayout'

export { showBeat, toggleAnimation } from '../journeys/panel/features/walk'
export { toggleAuthorMode } from '../journeys/panel/features/author'

let controller: PanelController | undefined

/** The panel's controller with every feature registered (made on first use: the tour's parts exist by then). */
function panelController(): PanelController {
  controller ??= new PanelController([
    walkFeature({ askedOf }),
    viewFeature({ stored, panelResized: rememberPanelWidth }),
    authorFeature(),
    checkFeature(),
    listFeature({
      listModel,
      homeQuery: () => listState.homeQuery,
      setHomeQuery: (q) => { listState.homeQuery = q },
      showAllHere: () => { listState.hereAll = true },
      stored,
    }),
    podcastFeature(),
  ])
  return controller
}

export function onMapMessage(lj: LoadedJourney, m: MapMessage): void {
  panelController().onMessage(lj, m)
}

/** What the journey panel shows of a journey besides the journey itself: every feature's part. */
export function mapState(lj: LoadedJourney): TourInfo {
  return panelController().state(lj)
}
