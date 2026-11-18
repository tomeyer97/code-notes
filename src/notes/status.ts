// Changing notes: replies, resolving and reopening (with their history), deleting, and Undo for each.

import * as vscode from 'vscode'
import { byId, log, notes, now, setCtx, store } from '../app'
import { askClaude, claudeMode } from '../ask'
import { evMine, me, mine } from '../identity'
import { refreshAll } from '../refresh'
import { markRead, restoreSeen, seenCount, seenSnapshot, setSeen, unread, visitFrom } from '../seen'
import { checked, matchesFilter } from '../sidebar/nodes'
import { treeView } from '../sidebar/notesTree'
import { NoteData, NoteEvent } from '../noteModel'
import { folderName, Note } from '../store'
import { describeNotes, noteTitle, plural } from '../text'
import { noteOfThread, revealed, shape, shapeOf, syncThread } from '../threads/threads'
import { notesFrom, target } from './target'

/** Records a status change in the note's history. */
export function addEvent(n: Note, type: NoteEvent['type'], by = me(), role: NoteEvent['role'] = 'human'): void {
  n.data.events = [...(n.data.events ?? []), { type, by, ...(role ? { role } : {}), at: now() }]
}

/** The last undoable action: the toast's Undo, and "Code Notes: Undo" after the toast is gone. */
let lastUndo: { what: string; run: () => Promise<void> } | undefined

export function offerUndo(what: string, run: () => Promise<void>, quiet = false): void {
  const entry = { what, run }
  lastUndo = entry
  setCtx('codeNotes.canUndo', true)
  // Quiet: nothing pops up; "Code Notes: Undo" still brings it back.
  if (!quiet) void vscode.window.showInformationMessage(what, 'Undo').then((pick) => { if (pick === 'Undo') return undoLast(entry) })
}

async function undoLast(entry = lastUndo): Promise<void> {
  if (!entry || entry !== lastUndo) return // already undone
  lastUndo = undefined
  setCtx('codeNotes.canUndo', false)
  await entry.run()
  vscode.window.setStatusBarMessage(`$(discard) Undone: ${entry.what}`, 3000)
}

/** A copy of a note's data, to put back (a failed save, an undo). */
export const snapshot = (n: Note): NoteData => structuredClone(n.data)

async function setStatus(list: Note[], status: 'open' | 'resolved', record = true): Promise<void> {
  for (const n of list) {
    const before = snapshot(n)
    if (record && n.data.status !== status) addEvent(n, status === 'resolved' ? 'resolved' : 'reopened')
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
    const titles = list.slice(0, 5).map((n) => `• ${noteTitle(n, 60)}`).join('\n') + (list.length > 5 ? `\n… and ${list.length - 5} more` : '')
    const ok = await vscode.window.showWarningMessage(`Resolve ${list.length} notes${scope}? ${withUnread.length} unread.`, { modal: true, detail: titles }, 'Resolve')
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
function undoResolveEvent(n: Note): Note {
  const last = n.data.events?.[n.data.events.length - 1]
  if (last?.type === 'resolved' && evMine(last)) { n.data.events = n.data.events!.slice(0, -1); if (!n.data.events.length) delete n.data.events }
  return n
}

export async function trash(list: Note[], what: string): Promise<void> {
  for (const n of list) { checked.delete(n.data.id); await store.trash(n) }
  refreshAll()
  offerUndo(`Deleted ${what}`, async () => { for (const n of list) await store.restore(n); refreshAll() })
}

/** An agent deleted a note file (rm): its last version is restorable from .trash ("Code Notes: Undo"), without a toast. */
export function offerRestore(n: Note): void {
  offerUndo(`Note deleted on disk: "${noteTitle(n)}"`, async () => { await store.restore(n); refreshAll() }, true)
}

/** Replies being saved (note and text): a second Ctrl+Enter meanwhile (the box keeps its text until the command returns) is not a second reply. */
const replying = new Set<string>()

/** Adds your message; on a failed save (an error toast is shown) the note is left as it was. */
export const addReply = async (n: Note, text: string, status?: 'open' | 'resolved'): Promise<boolean> => {
  const k = `${n.data.id}\0${text}\0${status ?? ''}`
  if (replying.has(k)) return false
  replying.add(k)
  try {
    const before = { messages: n.data.messages.length, status: n.data.status, events: n.data.events }
    if (text) n.data.messages.push({ author: me(), role: 'human', body: text, at: now() })
    const next = status ?? (n.data.status === 'resolved' && text ? 'open' : n.data.status)
    if (next !== n.data.status) addEvent(n, next === 'resolved' ? 'resolved' : 'reopened')
    n.data.status = next
    // In the thread at once, before it is saved (taken back if the save fails).
    syncThread(n)
    if (!(await store.save(n))) {
      n.data.messages.length = before.messages
      n.data.status = before.status
      if (before.events) n.data.events = before.events; else delete n.data.events
      refreshAll()
      return false
    }
    shape.set(n.data.id, shapeOf(n))
    void markRead([n]).then(undefined, (e) => log.error(`mark read: ${e}`))
    return true
  } finally { replying.delete(k) }
}

export const replyTo = async (r: vscode.CommentReply) => {
  const n = noteOfThread(r.thread)
  if (!n || !r.text.trim()) return
  if ((await addReply(n, r.text.trim())) && claudeMode() === 'always') await askClaude(n)
}

/** Answer and close in one step (the usual end of a thread). */
export const replyAndResolve = async (reply: vscode.CommentReply) => {
  const n = noteOfThread(reply.thread)
  if (!n) return
  if (!(await addReply(n, reply.text.trim(), 'resolved'))) return
  if (revealed.id === n.data.id) revealed.id = undefined
  refreshAll()
  offerUndo(`Resolved "${noteTitle(n)}"`, () => setStatus([undoResolveEvent(n)], 'open', false))
}

export const undo = () => (lastUndo ? undoLast() : vscode.window.setStatusBarMessage('$(info) Nothing to undo', 2500))

export const markUnread = async (arg?: any) => {
  const [n] = notesFrom(arg)
  if (!n) return
  let i = n.data.messages.length - 1
  while (i >= 0 && mine(n.data.messages[i])) i--
  if (i < 0) { vscode.window.setStatusBarMessage('$(info) Nothing to mark unread: every message is yours', 2500); return }
  visitFrom.delete(n.data.id)
  if (revealed.id === n.data.id) revealed.id = undefined
  await setSeen([[n.data.id, i]])
  refreshAll()
}

export const reopenNotes = async (arg?: any, many?: any[]) => {
  const list = await target(arg, many)
  if (!list.length) return
  await setStatus(list, 'open')
  vscode.window.setStatusBarMessage(`$(issue-reopened) Reopened ${describeNotes(list)}`, 3000)
}

export const deleteNotes = async (arg?: any, many?: any[]) => {
  const list = await target(arg, many)
  if (list.length) return trash(list, describeNotes(list))
}

export const resolveChecked = () => {
  const sel = treeView.selection.filter((x) => x.kind === 'note').map((x) => (x as { note: Note }).note)
  const list = checked.size ? [...checked].map(byId).filter((n): n is Note => !!n && matchesFilter(n)) : sel
  if (!list.length) { vscode.window.setStatusBarMessage('$(info) Select the notes to resolve (Ctrl+click for several)', 2500); return }
  return resolve(list)
}

export const resolveAll = async () => {
  const open = notes().filter((n) => n.data.status === 'open')
  if (!open.length) return
  const u = open.filter((n) => unread(n) > 0).length
  const ok = await vscode.window.showWarningMessage(`${open.length === 1 ? 'Resolve 1 note?' : `Resolve all ${open.length} notes?`}${u ? ` ${u} ${u === 1 ? 'has' : 'have'} replies you haven't read.` : ''} Journeys stay.`, { modal: true }, 'Resolve All')
  if (ok === 'Resolve All') { await markRead(open); await setStatus(open, 'resolved') }
}

export const deleteResolved = async () => {
  const done = notes().filter((n) => n.data.status === 'resolved')
  if (!done.length) { vscode.window.setStatusBarMessage('$(info) No resolved notes', 2500); return }
  const u = done.filter((n) => unread(n) > 0).length
  const ok = await vscode.window.showWarningMessage(`Purge ${plural(done.length, 'resolved note')}?`, {
    modal: true, detail: `${u ? `${u} unread. ` : ''}They go to ${folderName()}/.trash; Undo brings them back.`,
  }, 'Purge')
  if (ok === 'Purge') await trash(done, plural(done.length, 'resolved note'))
}

export const markAllRead = async () => {
  const list = notes().filter((n) => unread(n) > 0)
  if (!list.length) return
  const before = seenSnapshot()
  await markRead(list)
  offerUndo(`Marked ${plural(list.length, 'note')} read`, async () => { await restoreSeen(before); refreshAll() })
}
