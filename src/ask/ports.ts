// What asking Claude about a note needs from the features around it, given to ask's activate (ask/index.ts) and read
// by its modules through these getters.
import type * as vscode from 'vscode'
import type { CheckController } from '../check/controller'
import type { Store } from '../notes/store'
import { portsSlot } from '../platform/ports'

/** What asking asks of the understanding check (a question on a check question is asked as the check's). */
export type AskCheck = Pick<CheckController, 'isCheck' | 'questionOf' | 'branchOf'>

export interface AskPorts {
  store: Store
  /** Where code opens beside the map (the tour's code group). */
  codeColumn(): vscode.ViewColumn | undefined
  /** The check, once it is started. */
  check(): AskCheck | undefined
}

const slot = portsSlot<AskPorts>('asking Claude')

/** ask/index.ts only. */
export const useAskPorts = slot.set

export const notesStore = () => slot.get().store
export const codeColumn = () => slot.get().codeColumn()
export const check = () => slot.get().check()
