// Resolving and reopening notes (with their history, and Undo), and deleting them (to the notes folder's .trash).

import * as vscode from 'vscode'
import { store } from './ports'
import { byId, visibleNotes } from './visible'
import { now } from '../platform/host'
import { evMine, me } from './identity'
import { markRead, seenCount, setSeen, unread } from './seen'
import { matchesFilter, notesModel, notesChanged, selection } from './model'
import { NoteEvent } from '../core/format/noteModel'
import { Note } from './store'
import { folderName } from './notesFolder'
import { describeNotes, noteTitle, plural } from '../core/text'
import { offerUndo } from './undo'
import { CommandArg, pickNotes } from './which'
import { forgetRevealed } from './revealed'
import { withRollback } from './rollback'
import { hint } from './hint'

/** Records a status change in the note's history. */
export function addEvent(n: Note, type: NoteEvent['type'], by = me(), role: NoteEvent['role'] = 'human'): void {
  n.data.events = [...(n.data.events ?? []), { type, by, ...(role ? { role } : {}), at: now() }]
}

/** The history's word for a change to `status`. */
export const statusEvent = (status: string): NoteEvent['type'] => (status === 'resolved' ? 'resolved' : 'reopened')

/** The notes in `list` set to `status`; `record`: the change goes in their history. Saved, else as they were. */
export async function setStatus(list: Note[], status: 'open' | 'resolved', record = true): Promise<void> {
  await notesModel().batch(async () => {
    for (const n of list) {
      selection().checked.delete(n.data.id)
      // Not saved (a file another user wrote): the note stays as the file says; the error says why.
      await withRollback(n, ['status', 'events'], () => {
        if (record && n.data.status !== status) addEvent(n, statusEvent(status))
        n.data.status = status
        return store().save(n)
      })
    }
    notesChanged({ kind: 'saved', ids: list.map((n) => n.data.id) })
  })
}

/** How many titles a confirmation lists. */
const TITLES_SHOWN = 5

/** Asks (modal) before `question`'s action on `list`: the first titles, and how many have replies not read. True: go
 *  on. `after`: a last line under the titles (where deleted notes go). */
async function confirmWithUnread(list: Note[], question: string, button: string, after?: string): Promise<boolean> {
  const u = list.filter((n) => unread(n) > 0).length
  const titles = list.slice(0, TITLES_SHOWN).map((n) => `• ${noteTitle(n, 60)}`).join('\n')
  const more = list.length > TITLES_SHOWN ? `\n… and ${list.length - TITLES_SHOWN} more` : ''
  const detail = titles + more + (after ? `\n\n${after}` : '')
  return (await vscode.window.showWarningMessage(`${question}${u ? ` ${u} unread.` : ''}`, { modal: true, detail }, button)) === button
}

/**
 * Resolves the open (or unread) notes of `list`, with Undo (their seen counts too). Several with unread replies, or
 * `ask` 'always': asked first. `scope` follows the count in the question (` in "session"`).
 */
export async function resolve(list: Note[], scope = '', ask: 'unread' | 'always' = 'unread'): Promise<void> {
  list = list.filter((n) => n.data.status === 'open' || unread(n) > 0)
  if (!list.length) return
  const asks = ask === 'always' || (list.length > 1 && list.some((n) => unread(n) > 0))
  if (asks && !(await confirmWithUnread(list, `Resolve ${plural(list.length, 'note')}${scope}?`, 'Resolve'))) return
  for (const n of list) forgetRevealed(n.data.id)
  const seenBefore = Object.fromEntries(list.map((n) => [n.data.id, seenCount(n)]))
  await markRead(list)
  await setStatus(list, 'resolved')
  offerUndo(`Resolved ${describeNotes(list)}`, async () => {
    await setSeen(Object.entries(seenBefore))
    await setStatus(list.map(undoResolveEvent), 'open', false)
  })
}

/** Undoing a resolve: the resolve leaves no trace in the history. */
export function undoResolveEvent(n: Note): Note {
  const events = n.data.events
  const last = events?.[events.length - 1]
  if (!events || last?.type !== 'resolved' || !evMine(last)) return n
  n.data.events = events.slice(0, -1)
  if (!n.data.events.length) delete n.data.events
  return n
}

/** Notes to the trash, with Undo; `what` names them in the toast. */
export async function trash(list: Note[], what: string): Promise<void> {
  await notesModel().batch(async () => { for (const n of list) { selection().checked.delete(n.data.id); await store().trash(n) } })
  offerUndo(`Deleted ${what}`, () => notesModel().batch(async () => { for (const n of list) await store().restore(n) }))
}

/** An agent deleted a note file (rm): its last version is restorable from .trash ("Code Notes: Undo"), without a toast. */
export function offerRestore(n: Note): void {
  offerUndo(`Note deleted on disk: "${noteTitle(n)}"`, () => store().restore(n), true)
}

/** codeNotes.reopen */
export const reopenNotes = async (arg?: CommandArg, many?: readonly CommandArg[]) => {
  const list = await pickNotes(arg, many)
  if (!list.length) return
  await setStatus(list, 'open')
  hint(`Reopened ${describeNotes(list)}`, 'issue-reopened')
}

/** codeNotes.delete */
export const deleteNotes = async (arg?: CommandArg, many?: readonly CommandArg[]) => {
  const list = await pickNotes(arg, many)
  if (list.length) return trash(list, describeNotes(list))
}

/** codeNotes.resolveChecked: the ticked notes (the filter's), else the rows selected. */
export const resolveChecked = () => {
  const { checked, selected } = selection()
  const sel = selected.map(byId).filter((n): n is Note => !!n)
  const list = checked.size ? [...checked].map(byId).filter((n): n is Note => !!n && matchesFilter(n)) : sel
  if (!list.length) { hint('Select the notes to resolve (Ctrl+click for several)'); return }
  return resolve(list)
}

/** codeNotes.resolveAll: every open note, after asking (with Undo, as any resolve). */
export const resolveAll = () => resolve(visibleNotes().filter((n) => n.data.status === 'open'), ' (every open note)', 'always')

/** codeNotes.deleteResolved: every resolved note to the trash, after asking. */
export const deleteResolved = async () => {
  const done = visibleNotes().filter((n) => n.data.status === 'resolved')
  if (!done.length) { hint('No resolved notes'); return }
  const what = plural(done.length, 'resolved note')
  const where = `They go to ${folderName()}/.trash; Undo brings them back.`
  if (await confirmWithUnread(done, `Purge ${what}?`, 'Purge', where)) await trash(done, what)
}
