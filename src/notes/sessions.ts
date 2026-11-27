// Note sessions (a review's findings): hidden or shown in the editor, resolved or deleted as a whole.

import * as vscode from 'vscode'
import { byId, visibleNotes } from './visible'
import { notesModel, sessionOf } from './model'
import { forgetRevealed, revealedId } from './revealed'
import { foldThread } from './threadView'
import { hint } from './hint'
import { isRow, SessionRow } from './model/rows'
import { folderName } from './notesFolder'
import { resolve, trash } from './status'
import { markRead, unread } from './seen'
import { threads } from '../threads/sync'

/** The note's thread is open in the editor. Folding or removing it would make VS Code ask (modal) whether to drop
 *  a reply being typed, and hold every later command until answered. */
const threadOpen = (id: string) => threads.get(id)?.collapsibleState === vscode.CommentThreadCollapsibleState.Expanded

/** Hides or shows sessions; `only` shows these and hides every other one. An open thread stays (see threadOpen). */
export async function setSessionHidden(names: string[], hidden: boolean, only = false): Promise<void> {
  const model = notesModel()
  model.query.keepInEditor = threadOpen
  const h = only ? new Set(visibleNotes().map(sessionOf).filter((x) => !names.includes(x))) : new Set(model.hiddenSessions())
  if (!only) for (const name of names) hidden ? h.add(name) : h.delete(name)
  await model.setHiddenSessions(h, () => {
    // The note just opened from the list, folded, is no longer shown when its session is hidden now.
    const id = revealedId()
    const r = id ? byId(id) : undefined
    if (!r || !h.has(sessionOf(r)) || threadOpen(r.data.id)) return
    forgetRevealed(r.data.id)
    foldThread(r.data.id)
  })
}

/** The session a command is about: its row's, the only one, or the one picked ('' is the notes without a session). */
const sessionArg = async (node?: unknown): Promise<string | undefined> => {
  if (isRow<SessionRow>(node, 'session')) return node.name
  const names = [...new Set(visibleNotes().map(sessionOf))]
  if (names.length <= 1) return names[0]
  const count = (session: string) => visibleNotes().filter((x) => sessionOf(x) === session).length
  const item = (session: string) => ({ label: session || 'Notes', name: session, description: `${count(session)} notes` })
  const items = names.map(item)
  const pick = await vscode.window.showQuickPick(items, { title: 'Which session?' })
  return pick?.name
}

/** A session command: `fn` on the session of the row, or the one picked; nothing when none is. */
const withSession = (fn: (session: string) => Promise<void>) => async (node?: unknown) => {
  const session = await sessionArg(node)
  if (session !== undefined) await fn(session)
}

export const hideSession = withSession((session) => setSessionHidden([session], true))

export const showSession = withSession((session) => setSessionHidden([session], false))

/** This session shown, every other hidden. */
export const showOnlySession = withSession((session) => setSessionHidden([session], false, true))

export const showAllSessions = () => notesModel().setHiddenSessions([])

export const resolveSession = withSession(async (session) => {
  const notes = visibleNotes().filter((n) => sessionOf(n) === session)
  const open = notes.filter((n) => n.data.status === 'open')
  await resolve(open, session ? ` in "${session}"` : '')
  // Cancelled (or not saved): nothing else. Done: the ones resolved by others are read too, or they stay listed as new.
  if (open.some((n) => n.data.status === 'open')) return
  const resolvedUnread = notes.filter((n) => n.data.status === 'resolved' && unread(n) > 0)
  if (resolvedUnread.length) await markRead(resolvedUnread)
  // "Show only" this session, and it is done: show the others again.
  const h = notesModel().hiddenSessions()
  const rest = new Set(visibleNotes().filter((n) => n.data.status === 'open').map(sessionOf))
  if (!rest.has(session) && rest.size && [...rest].every((s) => h.has(s))) {
    await notesModel().setHiddenSessions([])
    hint('Showing all sessions again', 'eye')
  }
})

export const deleteSession = withSession(async (session) => {
  const list = visibleNotes().filter((n) => sessionOf(n) === session)
  const name = session || 'Notes'
  const detail = `They move to ${folderName()}/.trash and can be restored with Undo.`
  const question = `Delete the session "${name}" (${list.length} notes)?`
  const ok = await vscode.window.showWarningMessage(question, { modal: true, detail }, 'Delete')
  if (ok === 'Delete') await trash(list, `the session "${name}"`)
})
