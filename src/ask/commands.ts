// Ask Claude and Cancel, from wherever they are pressed: the note box, a thread's reply box, a row, a link, the cursor.

import { noteFromNewThread } from '../notes/create'
import { addReply } from '../notes/reply'
import { CommandArg, isReply, notesFrom } from '../notes/which'
import { noteOfThread } from '../threads/sync'
import { askHandlerOf } from './handlers'
import { askClaude, cancelAsk } from './run'

/** Ask Claude: from the note box (a new note), a thread's reply box (a follow-up), a row, a link, or the cursor. */
export const askClaudeCommand = async (arg?: CommandArg, many?: CommandArg[]) => {
  if (!isReply(arg)) {
    for (const n of notesFrom(arg, many)) await askClaude(n)
    return
  }
  const existing = noteOfThread(arg.thread)
  // The note box: the note is made, then asked.
  if (!existing) {
    const n = await noteFromNewThread(arg)
    if (n) await askClaude(n)
    return
  }
  // A note another feature asks about (a check question): what was typed goes to it, not into the thread.
  if (askHandlerOf(existing)) { await askClaude(existing, arg.text); return }
  // A reply box: what was typed is saved as a reply first.
  if (arg.text.trim() && !(await addReply(existing, arg.text.trim()))) return
  await askClaude(existing)
}

/** Cancel (or Dismiss a failure): by the id in a link (even of a note gone), else the notes the command is about. */
export const cancelClaudeCommand = (arg?: CommandArg) => {
  const ids = typeof arg === 'string' ? [arg] : notesFrom(arg).map((n) => n.data.id)
  for (const id of ids) cancelAsk(id)
}
