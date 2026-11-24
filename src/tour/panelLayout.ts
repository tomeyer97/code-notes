// The tour's way to the journey panel's layout (src/journeys/panel/layout.ts): the one PanelLayout of the panel,
// made from the tour's parts on first use. The tour's modules call these; new code takes the PanelLayout.

import type * as vscode from 'vscode'
import { mapPanel } from './ports'
import { walk } from './instances'
import { chordKey } from '../platform/chordKey'
import { log, stored } from '../platform/host'
import { MAP_VIEW, MapPanel } from '../journeys/mapPanel'
import { PanelLayout } from '../journeys/panel/layout'

let made: { panel: MapPanel; layout: PanelLayout } | undefined

/** The layout of the panel the tour has (a new one when the panel is another: a new window's tour). */
export function panelLayout(): PanelLayout {
  const panel = mapPanel()
  if (made?.panel !== panel) {
    const layout = new PanelLayout({
      viewColumn: () => panel.viewColumn,
      isOpen: () => !!panel.journey,
      close: () => panel.close(),
      codeColumn: () => walk().codeColumn(),
      episodeOn: () => walk().episodeOn(),
      chordKey,
      viewType: MAP_VIEW,
      log: log(),
      stored: stored(),
    })
    made = { panel, layout }
  }
  return made.layout
}

export const panelFits = () => panelLayout().panelFits()
export const codeGetsMoreRoom = () => panelLayout().codeGetsMoreRoom()
export const noteLayout = () => panelLayout().noteLayout()
export const keepWidthOnFocus = () => panelLayout().keepWidthOnFocus()
export const rememberPanelWidth = () => panelLayout().rememberPanelWidth()
export const keepOffMap = (t: vscode.Tab) => panelLayout().keepOffMap(t)
export const roomForMap = () => panelLayout().roomForMap()
export const cardOnly = () => panelLayout().cardOnly()
