// What a code link's click needs: the code links (made by codeLinks' activate, index.ts), the walk (a step card's
// link and its way back), and the check (a check thread's link and its way back to the question).
import type { Note } from '../notes/store'
import type { TourApi } from '../tour/api'
import type { CodeLinks } from './codeLinks'
import { portsSlot } from '../platform/ports'

/** A code link key of a check thread: its note and that message's links; the way back to its question. */
export interface CheckLinks {
  noteOf(key: string): { n: Note; links: Parameters<CodeLinks['present']>[2] } | undefined
  backToQuestion(n: Note): Promise<void>
}

export interface CodeLinkPorts {
  codeLinks: CodeLinks
  /** The walk (made after the code links: read when a link is clicked). */
  tour(): Pick<TourApi, 'state' | 'tourJourney' | 'goToStep' | 'inMap' | 'linkClicked' | 'ownCursorFor' | 'codeColumn'>
  /** The check's links, once it is started. */
  check(): CheckLinks | undefined
}

const slot = portsSlot<CodeLinkPorts>('code links')

/** codeLinks/index.ts only. */
export const useCodeLinkPorts = slot.set

export const codeLinks = () => slot.get().codeLinks
export const tour = () => slot.get().tour()
export const checkLinks = () => slot.get().check()
