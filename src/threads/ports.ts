// What the notes' comment threads need from the features around them, given to their activate (threads/index.ts)
// and read by the threads' modules through these getters.
import type * as vscode from 'vscode'
import type { CheckController } from '../check/controller'
import type { Journeys } from '../journeys/journeys'
import type { TourApi } from '../tour/api'
import { portsSlot } from '../platform/ports'

/** What the threads ask of the understanding check (a question's thread looks and links like the check says). */
export type ThreadsCheck = Pick<CheckController, 'isCheck' | 'pinned' | 'threadStatus' | 'linksIn' | 'questionOf' | 'rowOf'>

export interface ThreadsPorts {
  /** The notes' comment controller (the threads are its threads). */
  controller: vscode.CommentController
  journeys: Journeys
  /** Where the walk is (a step question's back-link says less on its step), and a check question's "See also". */
  tour: Pick<TourApi, 'state' | 'touring' | 'seeAlsoLink'>
  /** The check, once it is started. */
  check(): ThreadsCheck | undefined
}

const slot = portsSlot<ThreadsPorts>('the threads')

/** threads/index.ts only. */
export const useThreadsPorts = slot.set

export const controller = () => slot.get().controller
export const journeys = () => slot.get().journeys
export const tour = () => slot.get().tour
export const check = () => slot.get().check()
