// The running tour, its step card and its walk: one of each for the window.

import * as vscode from 'vscode'
import { beats, cmdLink, codeLinks, journeys, log, mapPanel, notes, now, provide, setCtx, state, store, tourItems, valueHints } from '../app'
import { checkLinkNote } from '../understanding'
import { Asked, askedOf, askedText, revealJourneyRow, stepLinkOf } from '../sidebar/journeyRows'
import { tree } from '../sidebar/notesTree'
import { linesOfUri, notesFor } from '../notes/location'
import { editorSettling, newThread, setCollapse, setThread, settleLater, settling, whenSettled } from '../threads/settle'
import { refreshDecorations } from '../notes/decorations'
import { syncThread, threads } from '../threads/sync'
import { StepCard } from './card'
import { nextStop, openCheckpoint, seeAlsoLink, stopsOf } from './checkTour'
import { panelFits } from './layout'
import { endTour, finishTour } from './open'
import { pickJourney } from './pick'
import { STEP_SCHEME, stepLenses } from './refs'
import { TourState } from './state'
import { tutorialMark } from './tutorial'
import { Walk } from './walk'

/** The running tour: journey, step, the step card's state (tour/state.ts). */
export const tour = new TourState()

/** The step card (tour/card.ts): what it uses from here, read when it is used. */
export const card: StepCard = new StepCard(tour, {
  get journeys() { return journeys }, get mapPanel() { return mapPanel }, get codeLinks() { return codeLinks }, get valueHints() { return valueHints },
  touring: () => walk.touring(), tourJourney: () => walk.tourJourney(), askedOf: (lj) => askedOf(lj), askedText: (a) => askedText(a as Asked), nextStop: (lj) => nextStop(lj),
  seeAlsoLink: (files) => seeAlsoLink(files), tutorialMark: () => tutorialMark, cmdLink: (...a) => cmdLink(...a), linesOfUri: (uri) => linesOfUri(uri),
  editorSettling: (uri) => editorSettling(uri), settling: (t) => settling(t), whenSettled: (t, k, fn) => whenSettled(t, k, fn), get settleLater() { return settleLater },
  newThread: (c, uri, range, comments) => newThread(c, uri, range, comments), setThread: (t, k, v) => setThread(t, k, v),
})

/** The walk (tour/walk.ts): opening steps, moving on, the status bar item, where each journey was left. */
export const walk: Walk = new Walk(tour, card, {
  get journeys() { return journeys }, get mapPanel() { return mapPanel }, get state() { return state }, get log() { return log }, get beats() { return beats },
  get codeLinks() { return codeLinks }, get tourItems() { return tourItems },
  now: () => now(), refreshTree: () => tree.refresh(), syncStepNotes: () => { if (store) for (const n of notes()) if (stepLinkOf(n)) syncThread(n) },
  setCtx: (k, v) => setCtx(k, v), checkLinkNote: (key) => checkLinkNote(key), endTour: () => endTour(), finishTour: () => finishTour(),
  revealJourneyRow: (lj) => revealJourneyRow(lj), editorSettling: (uri) => editorSettling(uri),
  foldNotes: (uri, at) => { for (const nt of notesFor(uri)) if (nt.data.range.start <= at.end && nt.data.range.end >= at.start) { const th = threads.get(nt.data.id); if (th) setCollapse(th, vscode.CommentThreadCollapsibleState.Collapsed, nt.data.id) } },
  refreshDecorations: () => refreshDecorations(), stopsOf: (lj) => stopsOf(lj), openCheckpoint: (lj, id) => openCheckpoint(lj, id),
  pickJourney: () => pickJourney(), panelFits: () => panelFits(),
})

/** The walk's status bar items: ‹ step › ×. */
export function createTourItems(): void {
  provide({ tourItems: {
    prev: vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 49.3),
    pos: vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 49.2),
    next: vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 49.1),
    end: vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 49.0),
  } })
  tourItems.end.text = '$(close)'
  tourItems.end.command = 'codeNotes.endJourney'
  tourItems.prev.text = '$(chevron-left)'
  tourItems.prev.command = 'codeNotes.previousStep'
  tourItems.pos.command = 'codeNotes.showMap'
  tourItems.next.text = '$(chevron-right)'
  tourItems.next.command = 'codeNotes.nextStep'
}

/** The step card's comment controller, its decorations, and the lenses above the code journeys walk. */
export function createCard(context: vscode.ExtensionContext): void {
  card.refDeco = vscode.window.createTextEditorDecorationType({ isWholeLine: true, backgroundColor: new vscode.ThemeColor('editor.rangeHighlightBackground'), overviewRulerColor: new vscode.ThemeColor('textLink.foreground'), overviewRulerLane: vscode.OverviewRulerLane.Center })
  context.subscriptions.push(card.refDeco, card.lensChanged, vscode.languages.registerCodeLensProvider([{ scheme: 'file' }, { scheme: STEP_SCHEME }], { onDidChangeCodeLenses: card.lensChanged.event, provideCodeLenses: stepLenses }))
  card.controller = vscode.comments.createCommentController('codeNotes.journey', 'Journey')
  card.controller.options = { prompt: '', placeHolder: '' }
  card.deco = {
    at: vscode.window.createTextEditorDecorationType({
      // A faint tint too: clear which lines the step is about; selection and find stay on top.
      isWholeLine: true, borderWidth: '0 0 0 2px', borderStyle: 'solid', borderColor: new vscode.ThemeColor('textLink.foreground'),
      backgroundColor: new vscode.ThemeColor('codeNotes.stepBackground'),
      overviewRulerColor: new vscode.ThemeColor('textLink.foreground'), overviewRulerLane: vscode.OverviewRulerLane.Center,
    }),
    stale: vscode.window.createTextEditorDecorationType({
      isWholeLine: true, borderWidth: '0 0 0 2px', borderStyle: 'dashed', borderColor: new vscode.ThemeColor('editorWarning.foreground'),
      overviewRulerColor: new vscode.ThemeColor('editorWarning.foreground'), overviewRulerLane: vscode.OverviewRulerLane.Center,
    }),
  }
  context.subscriptions.push(card.controller, card.deco.at, card.deco.stale, { dispose: () => card.clear() })
}

export const toggleStepDetails = (open?: boolean) => {
  tour.detailsOpen = open ?? !tour.detailsOpen
  const lj = walk.tourJourney()
  if (lj && tour.step) card.show(lj, tour.step)
}
