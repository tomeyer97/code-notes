// The tour's own parts for this window: its state, the step card, the walk, the status bar items and the tutorial's
// spot. createTour (index.ts) makes them when the extension starts and the tour's modules read them through these
// getters; no other feature does (they get the TourApi, api.ts). Nothing is made at import time.
import type * as vscode from 'vscode'
import type { StepCard } from './card'
import type { TourPodcast } from './api'
import type { TourProbe, TourState } from './state'
import type { TutorialSpot } from './tutorialSpot'
import type { Walk } from './walk'
import { portsSlot } from '../platform/ports'

/** The walk's status bar items: ‹ step › ×. */
export type TourItems = { prev: vscode.StatusBarItem; pos: vscode.StatusBarItem; next: vscode.StatusBarItem; end: vscode.StatusBarItem }

/** The Ask boxes on steps: what was typed and not sent (by journey and step: platform/keys.ts stepDraftKey), and the
 *  box open now (Enter sends it). */
export interface AskBoxes {
  readonly drafts: Map<string, string>
  open: { box: vscode.InputBox; accept: () => void } | undefined
}

export interface TourParts {
  state: TourState
  probe: TourProbe
  card: StepCard
  walk: Walk
  items: TourItems
  spot: TutorialSpot
  asks: AskBoxes
  /** The podcast player registered (TourApi.usePodcast), if any. */
  podcast(): TourPodcast | undefined
}

const slot = portsSlot<TourParts>('the tour')

/** createTour only. */
export const useTourParts = slot.set

export const tourState = () => slot.get().state
export const tourProbe = () => slot.get().probe
export const card = () => slot.get().card
export const walk = () => slot.get().walk
export const tourItems = () => slot.get().items
export const tutorialSpot = () => slot.get().spot
export const podcast = () => slot.get().podcast()
export const askBoxes = () => slot.get().asks
