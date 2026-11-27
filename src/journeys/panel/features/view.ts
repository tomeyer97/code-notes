// The panel itself: the tutorial, the legend and the widths the reader dragged.

import type { PanelViewInfo } from '../../../protocol/map'
import type { PanelFeature } from '../controller'
import { onTutorial } from '../../../tour/tutorial'
import { fireAndForget } from '../../../platform/run'
import { STATE, StateStore } from '../../../platform/state'

export interface ViewFeatureDeps {
  /** The window's state (read when used). */
  stored(): StateStore
  /** The panel was resized (the layout keeps the reader's width). */
  panelResized(): Promise<void>
}

export function viewFeature(d: ViewFeatureDeps): PanelFeature {
  return {
    name: 'the panel',
    handlers: {
      tutorial: (lj, m) => onTutorial(lj, m),
      panelWidth: () => fireAndForget(d.panelResized(), 'panel: rememberPanelWidth'),
      mapWidth: (_lj, m) => fireAndForget(d.stored().set(STATE.mapWidth, m.w > 0 ? Math.round(m.w) : undefined), 'panel: store mapWidth'),
    },
    slice: (): PanelViewInfo => {
      const mapWidth = d.stored().get(STATE.mapWidth)
      return {
        tutorial: !d.stored().get(STATE.tutorialSeen),
        legendHidden: d.stored().get(STATE.legendHidden),
        ...(mapWidth ? { mapWidth } : {}),
      }
    },
  }
}
