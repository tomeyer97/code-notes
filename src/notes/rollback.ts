// A change to a note in memory, taken back when it could not be saved: the one way commands undo a failed save.
// Pure (no vscode).

import type { NoteData } from '../core/format/noteModel'

/**
 * Runs `change` (it changes the note and saves it: false when the save failed); on false the note's `fields` are put
 * back as they were. Only those fields: a save that merged a change made on disk before it failed keeps the rest.
 */
export async function withRollback<F extends keyof NoteData>(n: { data: NoteData }, fields: readonly F[], change: () => Promise<boolean>): Promise<boolean> {
  const before = fields.map((f) => [f, f in n.data, structuredClone(n.data[f])] as const)
  if (await change()) return true
  for (const [f, had, value] of before) {
    if (had) n.data[f] = value
    else delete (n.data as Partial<NoteData>)[f]
  }
  return false
}
