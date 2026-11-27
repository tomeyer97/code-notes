// What the bridge needs from the features it drives, given to its activate (bridge/index.ts) and read by its modules
// through these getters.
import type { ClaudeLinks } from '../codeLinks/claudeChatLinks'
import type { Journeys } from '../journeys/journeys'
import type { AgentNote, AgentNoteResult } from '../notes/agentNote'
import { portsSlot } from '../platform/ports'

export interface BridgePorts {
  /** Lines lit in the editor, with Back above them (as a link from a chat lights them). */
  claudeLinks: Pick<ClaudeLinks, 'light'>
  journeys: Journeys
  /** A note written for a controller (notes/agentNote.ts). */
  addNote(a: AgentNote): Promise<AgentNoteResult>
}

const slot = portsSlot<BridgePorts>('the bridge')

/** bridge/index.ts only. */
export const useBridgePorts = slot.set

export const claudeLinks = () => slot.get().claudeLinks
export const journeys = () => slot.get().journeys
export const addNote = (a: AgentNote) => slot.get().addNote(a)
