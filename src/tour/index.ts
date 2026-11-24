// The tour: walking a journey step by step (walk.ts), its step card (card.ts), the map's messages and the tour's
// commands. createTour makes its parts for the window and hands back the TourApi the other features get.
import * as vscode from 'vscode'
import { chord, onDidChangeChordKey, STEP_PRIORITY, Steppers } from '../platform/chordKey'
import type { LoadedJourney } from '../journeys/steps'
import type { FromMap as MapMessage, TourInfo } from '../protocol/map'
import { Cmd, HiddenCmd } from '../platform/commands'
import { log } from '../platform/host'
import { registerCommands } from '../platform/registerCommands'
import type { WorkspaceEvents } from '../platform/events'
import type { NotesApi } from '../notes/model'
import type { TourApi, TourPodcast } from './api'
import { StepCard } from './card'
import { currentTour, openCheckpoint, seeAlsoLink, tourChanged } from './checkTour'
import { backToStep, closeWalkTabs, endJourney, openJourney, openMap, openStepLink, restoreMapPanel, restoreTour, showMap, startJourney, stepDetails, walkJourney } from './commands'
import { askStep, askUpdate } from './askStep'
import { stepsFollowed, tourFollows } from './follow'
import { AskBoxes, TourItems, useTourParts } from './instances'
import { pickJourneyStep, stepLenses } from './lenses'
import { mapState, onMapMessage, showBeat, toggleAnimation, toggleAuthorMode } from './mapMessages'
import { codeGetsMoreRoom } from './panelLayout'
import { pickJourney } from './pick'
import { TourPorts, useTourPorts } from './ports'
import { openRef, registerRefPages, STEP_SCHEME } from './refs'
import { TourProbe, TourState } from './state'
import { tutorial } from './tutorial'
import { TutorialSpot } from './tutorialSpot'
import { Walk } from './walk'

export type { TourApi, TourPodcast } from './api'

/** What the composition root needs besides the TourApi: when the journeys are read, and the walk after a reload. */
export interface TourFeature {
  api: TourApi
  /** The journeys are read: a map panel VS Code restored can be drawn. */
  journeysLoaded(): void
  /** The walk where it was before the reload. */
  restore(): Promise<void>
  /** The tour follows the notes' changes, the journeys and the editors (after what shows the notes). */
  follow(model: NotesApi, events: WorkspaceEvents): vscode.Disposable
  /** The journey panel's messages, and what the panel is told besides the journey (journeys/mapPanel.ts asks). */
  onMapMessage(lj: LoadedJourney, m: MapMessage): void
  mapState(lj: LoadedJourney): TourInfo
  /** What the integration tests read and drive of the tour (tour/testing.ts). */
  parts: { state: TourState; probe: TourProbe; card: StepCard; walk: Walk; items: TourItems; spot: TutorialSpot; asks: AskBoxes }
}

/** The walk's status bar items: ‹ step › ×. */
function createTourItems(): TourItems {
  const items: TourItems = {
    prev: vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 49.3),
    pos: vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 49.2),
    next: vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 49.1),
    end: vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 49.0),
  }
  items.end.text = '$(close)'
  items.end.command = Cmd.endJourney
  items.prev.text = '$(chevron-left)'
  items.prev.command = Cmd.previousStep
  items.pos.command = Cmd.showMap
  items.next.text = '$(chevron-right)'
  items.next.command = Cmd.nextStep
  return items
}

/** Makes the tour for this window: its state, card, walk, status items and the tutorial's spot, its commands and what
 *  it follows (the notes' changes, the journeys, the editors). */
export function createTour(context: vscode.ExtensionContext, ports: TourPorts, steppers: Steppers): TourFeature {
  useTourPorts(ports)
  const state = new TourState()
  const probe = new TourProbe()
  // The card asks the walk what a podcast shows on the step (the walk's controller): made right below.
  const card = StepCard.create(state, probe, (lj, n) => walk.narration(lj, n), log())
  const walk = new Walk(state, card, probe)
  const items = createTourItems()
  const spot = new TutorialSpot()
  let podcast: TourPodcast | undefined
  const asks: AskBoxes = { drafts: new Map(), open: undefined }
  useTourParts({ state, probe, card, walk, items, spot, asks, podcast: () => podcast })

  context.subscriptions.push(
    card, walk, spot, ...Object.values(items),
    vscode.languages.registerCodeLensProvider([{ scheme: 'file' }, { scheme: STEP_SCHEME }], {
      onDidChangeCodeLenses: card.lensChanged.event,
      provideCodeLenses: stepLenses,
    }),
    // While the voice tells the step the marks show what is said: no beat box, no caret moved to it.
    ports.beats.usePolicy({ quiet: () => card.narrating(), follow: walk.following }),
    // Hints name the chord prefix last pressed.
    onDidChangeChordKey(() => walk.updateTour()),
  )
  registerRefPages(context)
  const journeysLoaded = restoreMapPanel(context)
  registerCommands(context, {
    [Cmd.openJourney]: openJourney,
    [Cmd.showMap]: showMap,
    [Cmd.startJourney]: startJourney,
    [Cmd.nextStep]: () => walk.stepBy(1),
    [Cmd.previousStep]: () => walk.stepBy(-1),
    [Cmd.endJourney]: endJourney,
    [HiddenCmd.openStepLink]: openStepLink,
    [Cmd.toggleAuthorMode]: toggleAuthorMode,
    [Cmd.toggleAnimation]: chord(toggleAnimation),
    [Cmd.backToStep]: backToStep,
    [Cmd.askStep]: (text?: string) => askStep(text),
    [HiddenCmd.askStepUpdate]: () => askUpdate(),
    [Cmd.tutorial]: tutorial,
    [Cmd.stepDetails]: stepDetails,
    [Cmd.pickJourneyStep]: pickJourneyStep,
  })

  const api: TourApi = {
    state,
    touring: () => walk.touring(),
    tourJourney: () => walk.tourJourney(),
    positions: () => walk.positions(),
    resumeAt: (lj) => walk.resumeAt(lj),
    codeColumn: walk.codeColumn,
    columnFor: (uri) => walk.columnFor(uri),
    stepBy: (dir) => walk.stepBy(dir),
    goToStep: (lj, n, opts) => walk.goToStep(lj, n, opts),
    walkJourney,
    openMap,
    showMap: (lj, preserveFocus) => walk.showMap(lj, preserveFocus),
    endJourney,
    closeWalkTabs,
    pickJourney,
    showBeat,
    codeGetsMoreRoom,
    openRef,
    updateTour: () => walk.updateTour(),
    statusChanged: () => walk.statusChanged(),
    stepsFollowed: stepsFollowed(),
    inMap: (lj, n) => card.inMap(lj, n),
    narrates: (e) => card.narrates(e),
    refreshCard: () => card.refreshDecorations(),
    showCard: (lj, n) => card.show(lj, n),
    lensesChanged: () => card.lensChanged.fire(),
    linkClicked: (back) => { state.linkBack = back },
    ownCursorFor: (ms) => { state.cursorUntil = Date.now() + ms },
    forgetStepId: () => { state.stepId = undefined },
    checkTourChanged: tourChanged,
    checkTour: currentTour,
    openCheckpoint,
    seeAlsoLink,
    usePodcast: (p) => {
      podcast = p
      const walkSub = walk.setController(p)
      return new vscode.Disposable(() => {
        walkSub.dispose()
        if (podcast === p) podcast = undefined
      })
    },
    podcast: () => podcast,
    onDidMove: walk.onDidMove,
    onDidRestore: walk.onDidRestore,
  }
  context.subscriptions.push(steppers.register(STEP_PRIORITY.walk, { step: (dir) => walk.touring() && walk.stepBy(dir) }))
  return {
    api, journeysLoaded, restore: restoreTour, parts: { state, probe, card, walk, items, spot, asks },
    follow: (model, events) => tourFollows(model, events),
    onMapMessage, mapState,
  }
}
