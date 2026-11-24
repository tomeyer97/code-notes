// What the notes' modules share: the store and the comment controller notes' activate (notes/index.ts) made, and what
// the notes need from the features above them, handed to activate as ports. Read through the getters below; they
// throw before activate.
import type * as vscode from 'vscode'
import type { Journeys } from '../journeys/journeys'
import type { LoadedJourney } from '../journeys/steps'
import type { Note, Store } from './store'

/** Where the tour shows code, and what it shows (the tour's TourApi, the part notes use). */
export interface NotesLayout {
  /** The editor group code opens in beside the map (never the map's). */
  codeColumn(): vscode.ViewColumn | undefined
  /** The editor that already shows `uri` (outside the map's group), else the code group. */
  columnFor(uri: vscode.Uri): vscode.ViewColumn | undefined
  /** The journey whose walk is running, if one is. */
  walking(): LoadedJourney | undefined
  /** Opens a step's reference under the step card (a link in a note to a step's line). */
  openRef(lj: LoadedJourney, file: string, line: number, end: number, step: number): Promise<void>
  /** The editor shows the code the podcast's voice tells now (the notes' bars stay off it). */
  narrates(editor: vscode.TextEditor): boolean
  /** The step card's own bars drawn again (after the notes' bars). */
  refreshCard(): void
  /** The cursor moved because the tour moved it (not the reader). */
  tourMovedCursor(): boolean
}

/** What notes need from outside the notes. */
export interface NotesFeaturePorts {
  journeys: Journeys
  /** The journey panel: where it is and what it shows. */
  map: { readonly journey: LoadedJourney | undefined; readonly viewColumn: vscode.ViewColumn | undefined }
  layout: NotesLayout
  /** A suggestion of a check's fix was applied (the check counts it). */
  fixApplied(fixFor: string, file: string): Promise<void>
  /** The note is a question of the understanding check. */
  isCheck(n: Note): boolean
  /** The note's thread is drawn in the editor now. */
  hasThread(id: string): boolean
}

interface Made {
  store: Store
  controller: vscode.CommentController
  ports: NotesFeaturePorts
  /** Notes the lists leave out (registered by a feature: the check hides another branch's questions). */
  hidden: ((n: Note) => boolean)[]
}

let made: Made | undefined

/** notes/index.ts's activate only. */
export function useNotes(m: Made): void { made = m }

function the(): Made {
  if (!made) throw new Error('Code Notes: the notes are read before they are started')
  return made
}

export const store = () => the().store
export const controller = () => the().controller
export const notesPorts = () => the().ports
export const hiddenBy = () => the().hidden
