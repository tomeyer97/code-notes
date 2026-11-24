// Replies: your message added to a note (from its thread's box), with Claude asked next when set to always; Reply and
// Resolve in one step.

import * as vscode from 'vscode'
import { store } from './ports'
import { now } from '../platform/host'
import { askClaude } from '../ask/run'
import { askAlways } from '../ask/settings'
import { me } from './identity'
import { markRead } from './seen'
import { Note } from './store'
import { noteOfThread, syncThread } from '../threads/sync'
import { notesChanged } from './model'
import { addEvent, resolve, statusEvent } from './status'
import { fireAndForget } from '../platform/run'
import { OncePerSubmit } from './submit'
import { withRollback } from './rollback'

/** Replies being saved, by note, text and status: a second Ctrl+Enter meanwhile is not a second reply. */
const replying = new OncePerSubmit<string>()

/** Adds your message; on a failed save (an error toast is shown) the note is left as it was. */
export const addReply = async (n: Note, text: string, status?: 'open' | 'resolved'): Promise<boolean> => {
  const saved = await replying.run(`${n.data.id}\0${text}\0${status ?? ''}`, () => withRollback(n, ['messages', 'status', 'events'], async () => {
    if (text) n.data.messages.push({ author: me(), role: 'human', body: text, at: now() })
    const next = status ?? (n.data.status === 'resolved' && text ? 'open' : n.data.status)
    if (next !== n.data.status) addEvent(n, statusEvent(next))
    n.data.status = next
    // In the thread at once, before it is saved (taken back if the save fails).
    syncThread(n)
    return store().save(n)
  }))
  if (saved === undefined) return false
  if (!saved) {
    notesChanged({ kind: 'saved', ids: [n.data.id] })
    return false
  }
  fireAndForget(markRead([n]), 'mark read')
  return true
}

/** codeNotes.reply (and replyReopen): Ctrl+Enter in a thread's box. */
export const replyTo = async (r: vscode.CommentReply) => {
  const n = noteOfThread(r.thread)
  if (!n || !r.text.trim()) return
  if ((await addReply(n, r.text.trim())) && askAlways()) await askClaude(n)
}

/** Answer and close in one step (the usual end of a thread): the reply, then the same resolve as the Resolve button. */
export const replyAndResolve = async (reply: vscode.CommentReply) => {
  const n = noteOfThread(reply.thread)
  if (!n) return
  // The reply keeps the status as it is (a resolved thread is not reopened by it): resolving is resolve's.
  const text = reply.text.trim()
  if (text && !(await addReply(n, text, n.data.status))) return
  await resolve([n])
}
