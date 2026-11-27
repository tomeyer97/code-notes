// The running tour's state: which journey and step, what the editor shows for it, and the step card's state. One
// object per window (createTour makes it), passed to the walk and the card; other features read it as a TourView
// (api.ts). What is stored across reloads is in platform/state.ts.
import type * as vscode from 'vscode'
import type { TourView } from './api'
import type { StepRef } from './stepText'

/** Where a step was shown: its journey, id, file and lines, and where the journey file put it then (`wrote`). */
export interface ShownAt { key: string; id: string; file: string; start: number; end: number; removed: boolean; wrote: string }

export class TourState implements TourView {
  // ---------- where the walk is (walk.ts) ----------

  /** The journey whose map is open (its file URI), and the step shown (1-based; 0: browsing the map, no tour running). */
  key: string | undefined
  step = 0
  /** The current step's id: the tour follows the step, not its number, when the journey is edited. */
  stepId: string | undefined
  /** On a check's tour: the question the walk is at (a stop after step `step`), else undefined. */
  checkpointId: string | undefined
  /** The journey whose walk was just finished: its panel says Done until a step opens again. */
  finishedKey: string | undefined
  /** goToStep calls still running (a scene going away meanwhile leaves the editor to them). */
  stepping = 0
  /** The newest step opened: an older one still waiting (a quick Next, Next, Next) never shows its file or card. */
  stepGen = 0
  /** Where a journey code link's Back goes: the step walked when it was clicked (gone once the walk moves on). */
  linkBack: { journey: string; step: number } | undefined

  // ---------- the editor (walk.ts) ----------

  /** The file the tour last opened, in the code group (its preview tab is closed when the tour ends). */
  doc: { uri: vscode.Uri; column: vscode.ViewColumn } | undefined
  /** The editor group the walk shows code in: kept for the window (another journey, the map's moments in a podcast,
   *  the walk ended), so step code always opens in the same group beside the panel (walk.codeColumn). */
  walkGroup: vscode.TabGroup | undefined
  /** The last "Journey updated: this step is now N" status message: gone once the walk moves on. */
  notice: vscode.Disposable | undefined
  /** Until then, cursor moves are the journey's, not the reader's. */
  cursorUntil = 0
  /** The step's file doesn't exist: its card is in the map, whatever the setting. */
  fileGone = false
  /** Where the current step was shown (to see that the agent moved it). */
  shownAt: ShownAt | undefined

  // ---------- the step card (card.ts) ----------

  /** The step card's details ("More") are open. */
  detailsOpen = false
  /** One line on the card about what just changed under the reader: for that step only. */
  cardNotice: { id: string; text: string } | undefined
  /** The panel's step card's links (posted back by index). */
  panelRefs: StepRef[] = []
  /** The step card is being made again (restoreStepCard). */
  restoring = false
  /** The step file that was on screen at the last change (only a return re-makes the card). */
  shownFor: string | undefined

  // ---------- files the step's text references (card.ts, refs.ts) ----------

  /** A reference opened from the step card: its lines are highlighted, with "← Back to step n" above them. */
  refHere: { uri: string; start: number; end: number } | undefined
  /** Files referenced by the current step that don't exist (folder|path), and how many lines the others have, checked when the step opens. */
  readonly refGone = new Set<string>()
  readonly refLines = new Map<string, number>()

  /** The tour is on step n of this journey (whether or not a step is shown). */
  isAt(lj: { key: string }, n: number): boolean {
    return this.key === lj.key && this.step === n
  }

  /** What the integration tests read of where the walk is. */
  snapshot() {
    return { step: this.step, cp: this.checkpointId, fileGone: this.fileGone, ref: this.refHere, codeColumn: this.doc?.column }
  }

  // ---------- moves made outside the walk (commands.ts) ----------

  /** A journey's map is open with no step shown (its walk not running). */
  browse(key: string): void {
    this.key = key
    this.step = 0
    this.stepId = undefined
  }

  /** The walk ended (its place is stored): no step, nothing opened for it; the journey's map may stay. */
  stop(): void {
    this.doc = undefined
    this.step = 0
    this.stepId = undefined
  }
}

/**
 * What the integration tests read of the tour that nothing else needs: written where it happens, read only by the
 * test API (tour/testing.ts). Kept apart so TourState holds only what drives the tour.
 */
export class TourProbe {
  /** The last ref opened as a peek under the step. */
  lastPeek: { uri: string; start: number; end: number; under?: number } | undefined
  /** A journey left for another one mid-way: where. */
  lastLeft: { title: string; at: string } | undefined
  /** Editors (their file) that show the step's bar now. */
  marked: string[] = []
}
