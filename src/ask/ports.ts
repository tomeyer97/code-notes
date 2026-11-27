// What asking Claude about a note needs from the features around it, given to ask's activate (ask/index.ts) and read
// by its modules through these getters.
import type * as vscode from 'vscode'
import type { Store } from '../notes/store'
import { portsSlot } from '../platform/ports'

export interface AskPorts {
  store: Store
  /** Where code opens beside the map (the tour's code group). */
  codeColumn(): vscode.ViewColumn | undefined
  /**
   * Not read by ask/ any more: a feature that asks about its own notes registers an AskHandler (ask/handlers.ts).
   * Kept while the composition root still passes it.
   */
  check?: unknown
}

const slot = portsSlot<AskPorts>('asking Claude')

/** ask/index.ts only. */
export const useAskPorts = slot.set

export const notesStore = () => slot.get().store
export const codeColumn = () => slot.get().codeColumn()
