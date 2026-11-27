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
export const addReply = async (n: Note, text: string, status?: 'open' | 'resolved'): Promise<boolean> => (await sendReply(n, text, status)) === 'saved'

/** addReply, saying whether it was not saved because the same reply is being saved already ('busy'). */
async function sendReply(n: Note, text: string, status?: 'open' | 'resolved'): Promise<'saved' | 'failed' | 'busy'> {
  const saved = await replying.run(`${n.data.id}\0${text}\0${status ?? ''}`, () => withRollback(n, ['messages', 'status', 'events'], async () => {
    if (text) n.data.messages.push({ author: me(), role: 'human', body: text, at: now() })
    const next = status ?? (n.data.status === 'resolved' && text ? 'open' : n.data.status)
    if (next !== n.data.status) addEvent(n, statusEvent(next))
    n.data.status = next
    // In the thread at once, before it is saved (taken back if the save fails).
    syncThread(n)
    return store().save(n)
  }))
  if (saved === undefined) return 'busy'
  if (!saved) {
    notesChanged({ kind: 'saved', ids: [n.data.id] })
    return 'failed'
  }
  fireAndForget(markRead([n]), 'mark read')
  return 'saved'
}

/** VS Code clears a thread's box when its command returns, and leaves it as it is when the command fails: a reply
 *  that was not saved (the error is shown) stays there to send again. Cancelled: VS Code shows nothing more. */
const keepInBox = (): never => { throw new vscode.CancellationError() }

/** codeNotes.reply (and replyReopen): Ctrl+Enter in a thread's box. */
export const replyTo = async (r: vscode.CommentReply) => {
  const n = noteOfThread(r.thread)
  if (!n || !r.text.trim()) return
  const sent = await sendReply(n, r.text.trim())
  if (sent === 'failed') keepInBox()
  // Not awaited: the box is cleared once the reply is saved, not when Claude has answered.
  if (sent === 'saved' && askAlways()) fireAndForget(askClaude(n), 'ask Claude after a reply')
}

/** Answer and close in one step (the usual end of a thread): the reply, then the same resolve as the Resolve button. */
export const replyAndResolve = async (reply: vscode.CommentReply) => {
  const n = noteOfThread(reply.thread)
  if (!n) return
  // The reply keeps the status as it is (a resolved thread is not reopened by it): resolving is resolve's.
  const text = reply.text.trim()
  const sent = text ? await sendReply(n, text, n.data.status) : 'saved'
  if (sent === 'failed') keepInBox()
  if (sent !== 'saved') return
  await resolve([n])
}
