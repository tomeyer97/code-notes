// The running tour's state, its step card and its walk: one of each for the window, made here; and the status bar
// items and the card's comment controller and decorations, made when the extension starts.
//
// Only this file imports card.ts and walk.ts (helpers they used to export are in stepPlace.ts and state.ts): their
// modules import the rest of the extension, which imports this one back, so they must have loaded before the two
// objects are made here.

import * as vscode from 'vscode'
import { provide, tourItems } from '../app'
import { StepCard } from './card'
import { stepLenses } from './lenses'
import { STEP_SCHEME } from './refs'
import { TourState } from './state'
import { Walk } from './walk'

/** The running tour: journey, step, the step card's state (tour/state.ts). */
export const tourState = new TourState()

/** The step card (tour/card.ts). */
export const card = new StepCard(tourState)

/** The walk (tour/walk.ts): opening steps, moving on, the status bar item, where each journey was left. */
export const walk = new Walk(tourState, card)

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
  card.refDeco = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor('editor.rangeHighlightBackground'),
    overviewRulerColor: new vscode.ThemeColor('textLink.foreground'),
    overviewRulerLane: vscode.OverviewRulerLane.Center,
  })
  const lenses = vscode.languages.registerCodeLensProvider([{ scheme: 'file' }, { scheme: STEP_SCHEME }], {
    onDidChangeCodeLenses: card.lensChanged.event,
    provideCodeLenses: stepLenses,
  })
  context.subscriptions.push(card.refDeco, card.lensChanged, lenses)
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

/** More / Less on the step card (`open`: which; none: the other). */
export const stepDetails = (open?: boolean) => {
  tourState.detailsOpen = open ?? !tourState.detailsOpen
  const lj = walk.tourJourney()
  if (lj && tourState.step) card.show(lj, tourState.step)
}
