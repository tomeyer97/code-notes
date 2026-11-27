// Note files changed on disk by someone else (an agent replied, resolved, or added a note; git): each note compared
// with what it was before (the store's `base`, as last read or written), its rule applied, the change announced, and
// the notes re-anchored after the burst.

import * as vscode from 'vscode'
import { store } from './ports'
import { log } from '../platform/host'
import { isAgent, mine } from './identity'
import { Message, NoteData, NoteEvent } from '../core/format/noteModel'
import { DiskChange, Note } from './store'
import { reanchorAll } from './reanchor'
import { addEvent, statusEvent } from './status'
import { lastMessage, notesChanged, notesModel } from './model'
import { Debouncer } from '../platform/debounce'

/** After a burst of changes on disk, the notes are re-anchored once. */
const REANCHOR_AFTER_MS = 200

/** Changes on disk: their rules, then announced (all read again: the store says 'loaded' itself). */
export function followNotesOnDisk(): vscode.Disposable {
  const later = new Debouncer('notes: re-anchor after changes on disk')
  const sub = store().onDidChangeOnDisk((c) => notesModel().batch(async () => {
    await notesChangedOnDisk(c)
    later.later('reanchor', REANCHOR_AFTER_MS, reanchorAll)
  }))
  return vscode.Disposable.from(later, sub)
}

/** Each note's rule, then the change announced. */
async function notesChangedOnDisk(c: DiskChange): Promise<void> {
  for (const { note, before } of c.notes) if (before) await statusChangedOnDisk(note, before)
  if (!c.loaded) notesChanged({ kind: 'disk', ids: c.notes.map((x) => x.note.data.id) })
}

/** A status change by the author of message `m` (someone, when there is none). */
const addEventOf = (n: Note, type: NoteEvent['type'], m: Message | undefined) =>
  addEvent(n, type, m?.author ?? 'someone', m && isAgent(m) ? 'agent' : undefined)

/**
 * Someone else's reply reopens a resolved note. A status changed on disk without saying so in "events" is recorded, as
 * theirs, so it shows as new; not when the file lost events (an older version restored: git checkout, undo), nor twice
 * in a row for the same change.
 *
 * Either rule saves the note, which the watcher sees; that read compares the note with what was just written (now the
 * store's `base`): the same status and messages, so neither rule applies again.
 */
async function statusChangedOnDisk(n: Note, before: NoteData): Promise<void> {
  const count = n.data.messages.length
  const replied = count > before.messages.length && n.data.messages.slice(before.messages.length).some((m) => !mine(m))
  if (before.status === 'resolved' && n.data.status === 'resolved' && replied) {
    n.data.status = 'open'
    addEventOf(n, 'reopened', lastMessage(n))
    log().appendLine(`note ${n.data.id}: reopened by a reply from ${lastMessage(n)?.author}`)
    await store().save(n)
  } else if (before.status !== n.data.status) {
    log().info(`note ${n.data.id}: ${n.data.status} on disk (by someone else)`)
    const evs = n.data.events ?? []
    const type = statusEvent(n.data.status)
    if (evs.length === (before.events?.length ?? 0) && evs[evs.length - 1]?.type !== type) {
      addEventOf(n, type, [...n.data.messages].reverse().find((m) => !mine(m)))
      await store().save(n)
    }
  }
}
