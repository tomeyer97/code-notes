// Replies: your message added to a note (from its thread's box), with Claude asked next when set to always; Reply and
// Resolve in one step.

import * as vscode from 'vscode'
import { log, now, store } from '../app'
import { askClaude } from '../ask/run'
import { askAlways } from '../ask/settings'
import { me } from './identity'
import { refreshAll } from '../refresh'
import { markRead } from './seen'
import { Note } from './store'
import { noteTitle } from '../core/text'
import { noteOfThread, revealed, syncThread } from '../threads/sync'
import { shape, shapeOf } from './changedOnDisk'
import { addEvent, setStatus, statusEvent, undoResolveEvent } from './status'
import { offerUndo } from './undo'
import { fireAndForget } from '../platform/run'

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
    if (next !== n.data.status) addEvent(n, statusEvent(next))
    n.data.status = next
    // In the thread at once, before it is saved (taken back if the save fails).
    syncThread(n)
    if (!(await store.save(n))) {
      // Field by field, not snapshot(): a save that merged a change from disk before it failed keeps the rest of it.
      n.data.messages.length = before.messages
      n.data.status = before.status
      if (before.events) n.data.events = before.events; else delete n.data.events
      refreshAll()
      return false
    }
    shape.set(n.data.id, shapeOf(n))
    fireAndForget(markRead([n]), 'mark read')
    return true
  } finally { replying.delete(k) }
}

/** codeNotes.reply (and replyReopen): Ctrl+Enter in a thread's box. */
export const replyTo = async (r: vscode.CommentReply) => {
  const n = noteOfThread(r.thread)
  if (!n || !r.text.trim()) return
  if ((await addReply(n, r.text.trim())) && askAlways()) await askClaude(n)
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
