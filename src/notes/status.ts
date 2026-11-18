// Resolving and reopening notes (with their history, and Undo), and deleting them (to the notes folder's .trash).

import * as vscode from 'vscode'
import { byId, notes, now, store } from '../app'
import { evMine, me } from '../identity'
import { refreshAll } from '../refresh'
import { markRead, seenCount, setSeen, unread } from '../seen'
import { checked, matchesFilter } from '../sidebar/notesFilter'
import { treeView } from '../sidebar/notesTree'
import { NoteEvent } from '../noteModel'
import { folderName, Note } from '../store'
import { describeNotes, noteTitle, plural } from '../text'
import { revealed } from '../threads/sync'
import { shape, shapeOf } from './changedOnDisk'
import { offerUndo, snapshot } from './undo'
import { pickNotes } from './which'

/** Records a status change in the note's history. */
export function addEvent(n: Note, type: NoteEvent['type'], by = me(), role: NoteEvent['role'] = 'human'): void {
  n.data.events = [...(n.data.events ?? []), { type, by, ...(role ? { role } : {}), at: now() }]
}

/** The history's word for a change to `status`. */
export const statusEvent = (status: string): NoteEvent['type'] => (status === 'resolved' ? 'resolved' : 'reopened')

/** The notes in `list` set to `status`; `record`: the change goes in their history. Saved, else as they were. */
export async function setStatus(list: Note[], status: 'open' | 'resolved', record = true): Promise<void> {
  for (const n of list) {
    const before = snapshot(n)
    if (record && n.data.status !== status) addEvent(n, statusEvent(status))
    n.data.status = status
    checked.delete(n.data.id)
    // Not saved (a file another user wrote): the note stays as the file says; the error says why.
    if (!(await store.save(n))) n.data = before
    shape.set(n.data.id, shapeOf(n))
  }
  refreshAll()
}

export async function resolve(list: Note[], scope = ''): Promise<void> {
  list = list.filter((n) => n.data.status === 'open' || unread(n) > 0)
  if (!list.length) return
  const withUnread = list.filter((n) => unread(n) > 0)
  if (list.length > 1 && withUnread.length) {
    const titles = list.slice(0, 5).map((n) => `• ${noteTitle(n, 60)}`).join('\n')
    const more = list.length > 5 ? `\n… and ${list.length - 5} more` : ''
    const question = `Resolve ${list.length} notes${scope}? ${withUnread.length} unread.`
    const ok = await vscode.window.showWarningMessage(question, { modal: true, detail: titles + more }, 'Resolve')
    if (ok !== 'Resolve') return
  }
  if (revealed.id && list.some((n) => n.data.id === revealed.id)) revealed.id = undefined
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
  const last = n.data.events?.[n.data.events.length - 1]
  if (last?.type === 'resolved' && evMine(last)) { n.data.events = n.data.events!.slice(0, -1); if (!n.data.events.length) delete n.data.events }
  return n
}

/** Notes to the trash, with Undo; `what` names them in the toast. */
export async function trash(list: Note[], what: string): Promise<void> {
  for (const n of list) { checked.delete(n.data.id); await store.trash(n) }
  refreshAll()
  offerUndo(`Deleted ${what}`, async () => { for (const n of list) await store.restore(n); refreshAll() })
}

/** An agent deleted a note file (rm): its last version is restorable from .trash ("Code Notes: Undo"), without a toast. */
export function offerRestore(n: Note): void {
  offerUndo(`Note deleted on disk: "${noteTitle(n)}"`, async () => { await store.restore(n); refreshAll() }, true)
}

/** codeNotes.reopen */
export const reopenNotes = async (arg?: any, many?: any[]) => {
  const list = await pickNotes(arg, many)
  if (!list.length) return
  await setStatus(list, 'open')
  vscode.window.setStatusBarMessage(`$(issue-reopened) Reopened ${describeNotes(list)}`, 3000)
}

/** codeNotes.delete */
export const deleteNotes = async (arg?: any, many?: any[]) => {
  const list = await pickNotes(arg, many)
  if (list.length) return trash(list, describeNotes(list))
}

/** codeNotes.resolveChecked: the ticked notes (the filter's), else the rows selected. */
export const resolveChecked = () => {
  const sel = treeView.selection.filter((x) => x.kind === 'note').map((x) => (x as { note: Note }).note)
  const list = checked.size ? [...checked].map(byId).filter((n): n is Note => !!n && matchesFilter(n)) : sel
  if (!list.length) { vscode.window.setStatusBarMessage('$(info) Select the notes to resolve (Ctrl+click for several)', 2500); return }
  return resolve(list)
}

/** codeNotes.resolveAll: every open note, after asking. */
export const resolveAll = async () => {
  const open = notes().filter((n) => n.data.status === 'open')
  if (!open.length) return
  const u = open.filter((n) => unread(n) > 0).length
  const question = open.length === 1 ? 'Resolve 1 note?' : `Resolve all ${open.length} notes?`
  const unreadPart = u ? ` ${u} ${u === 1 ? 'has' : 'have'} replies you haven't read.` : ''
  const ok = await vscode.window.showWarningMessage(`${question}${unreadPart} Journeys stay.`, { modal: true }, 'Resolve All')
  if (ok === 'Resolve All') { await markRead(open); await setStatus(open, 'resolved') }
}

/** codeNotes.deleteResolved: every resolved note to the trash, after asking. */
export const deleteResolved = async () => {
  const done = notes().filter((n) => n.data.status === 'resolved')
  if (!done.length) { vscode.window.setStatusBarMessage('$(info) No resolved notes', 2500); return }
  const u = done.filter((n) => unread(n) > 0).length
  const detail = `${u ? `${u} unread. ` : ''}They go to ${folderName()}/.trash; Undo brings them back.`
  const ok = await vscode.window.showWarningMessage(`Purge ${plural(done.length, 'resolved note')}?`, { modal: true, detail }, 'Purge')
  if (ok === 'Purge') await trash(done, plural(done.length, 'resolved note'))
}

