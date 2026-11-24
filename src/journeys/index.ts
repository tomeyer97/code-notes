// The journeys of the workspace (read from their folders, their steps found in the code) and the journey panel.
import * as vscode from 'vscode'
import { onDidChangeChordKey } from '../platform/chordKey'
import { log, stored } from '../platform/host'
import type { WorkspaceEvents } from '../platform/events'
import { FollowJourneysPorts, followJourneys } from './follow'
import { Journeys } from './journeys'
import { MapMessage, MapPanel, TourInfo } from './mapPanel'
import type { LoadedJourney } from './steps'

/** What the panel needs from the tour: what each of its messages does, and what it shows besides the journey. */
export interface JourneysPorts {
  onMapMessage(lj: LoadedJourney, m: MapMessage): void
  mapState(lj: LoadedJourney): TourInfo
}

export interface JourneysFeature {
  journeys: Journeys
  mapPanel: MapPanel
  /** The journeys' steps follow the code: files renamed or edited, branches checked out. */
  follow(events: WorkspaceEvents, ports: FollowJourneysPorts): vscode.Disposable
}

export function activateJourneys(context: vscode.ExtensionContext, ports: JourneysPorts): JourneysFeature {
  const journeys = new Journeys(log(), stored())
  const mapPanel = new MapPanel(context.extensionUri, log(), (lj, m) => ports.onMapMessage(lj, m), (lj) => ports.mapState(lj), stored())
  // Hints in the panel name the chord prefix last pressed.
  context.subscriptions.push(journeys, mapPanel, onDidChangeChordKey(() => mapPanel.update()))
  return { journeys, mapPanel, follow: (events, follows) => followJourneys(events, journeys, follows) }
}
