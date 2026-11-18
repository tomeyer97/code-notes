// The running tour's state: which journey and step, the step card's state, and what the editor shows for it.
// One object, held by the extension and passed to the tour's parts (it was ~25 module-level variables).
import type * as vscode from 'vscode'
import type { StepRef } from './stepText'

/** Stored in the workspace: the running tour's posKey (restored after a reload), where each journey was left
 *  (posKey -> { step, id, at }), and the journey last shown on the map. */
export const TOUR_KEY = 'codeNotes.tour'
export const POS_KEY = 'codeNotes.journeyPos'
export const MAP_KEY = 'codeNotes.mapJourney'

/** Where a step was shown: its journey, id, file and lines, and where the journey file put it then (`wrote`). */
export interface ShownAt { key: string; id: string; file: string; start: number; end: number; removed: boolean; wrote: string }

export class TourState {
  /** The journey whose map is open (its file URI), and the step shown (1-based; 0: browsing the map, no tour running). */
  key: string | undefined
  step = 0
  /** The current step's id: the tour follows the step, not its number, when the journey is edited. */
  stepId: string | undefined
  /** On a check's tour: the question the walk is at (a stop after step `step`), else undefined. */
  cp: string | undefined
  /** The file the tour last opened, in the code group (its preview tab is closed when the tour ends). */
  doc: { uri: vscode.Uri; column: vscode.ViewColumn } | undefined
  /** The step card's details ("More") are open. */
  detailsOpen = false
  /** A reference opened from the step card: its lines are highlighted, with "← Back to step n" above them (R8). */
  refHere: { uri: string; start: number; end: number } | undefined
  /** The last ref opened as a peek under the step (for the tests). */
  lastPeek: { uri: string; start: number; end: number; under?: number } | undefined
  /** Until then, cursor moves are the journey's, not the reader's. */
  cursorUntil = 0
  /** Where a journey code link's Back goes: the step walked when it was clicked (gone once the walk moves on). */
  linkBack: { journey: string; step: number } | undefined
  /** goToStep calls still running (a scene going away meanwhile leaves the editor to them). */
  stepping = 0
  /** The newest step opened: an older one still waiting (a quick Next, Next, Next) never shows its file or card. */
  stepGen = 0
  /** A journey left for another one mid-way: where (for the tests). */
  lastLeft: { title: string; at: string } | undefined
  /** Files referenced by the current step that don't exist (folder|path), and how many lines the others have, checked when the step opens. */
  readonly refGone = new Set<string>()
  readonly refLines = new Map<string, number>()
  /** The step's file doesn't exist: its card is in the map, whatever the setting. */
  fileGone = false
  /** One line on the card about what just changed under the reader: for that step only. */
  cardNotice: { id: string; text: string } | undefined
  /**
   * Where the current step was shown (to see that the agent moved it). `wrote`: where the journey file put the step
   * then (a change there is the agent re-anchoring it).
   */
  shownAt: ShownAt | undefined
  /** The panel's step card's links (posted back by index). */
  panelRefs: StepRef[] = []
  /** The step card is being made again (restoreStepCard). */
  restoring = false
  /** The step file that was on screen at the last change (only a return re-makes the card). */
  shownFor: string | undefined
  /** Editors (their file) that show the step's bar now (for the tests). */
  marked: string[] = []
  /** The journey whose walk was just finished: its panel says Done until a step opens again. */
  finishedKey: string | undefined

  /** The tour is on step n of this journey (whether or not a step is shown). */
  isAt(lj: { key: string }, n: number): boolean {
    return this.key === lj.key && this.step === n
  }
}
