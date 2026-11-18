// Note sessions (a review's findings): hidden or shown in the editor, resolved or deleted as a whole.

import * as vscode from 'vscode'
import { notes, state } from '../app'
import { refreshAll } from '../refresh'
import { HIDDEN_KEY, hiddenSessions, Node, sessionOf, setSessionHidden } from '../sidebar/nodes'
import { folderName } from '../store'
import { resolve, trash } from './status'

/** The session a command is about: its row's, the only one, or the one picked ('' is the notes without a session). */
const sessionArg = async (node?: Node): Promise<string | undefined> => {
  if (node?.kind === 'session') return node.name
  const names = [...new Set(notes().map(sessionOf))]
  if (names.length <= 1) return names[0]
  const count = (session: string) => notes().filter((x) => sessionOf(x) === session).length
  const items = names.map((session) => ({ label: session || 'Notes', name: session, description: `${count(session)} notes` }))
  const pick = await vscode.window.showQuickPick(items, { title: 'Which session?' })
  return pick?.name
}

/** A session command: `fn` on the session of the row, or the one picked; nothing when none is. */
const withSession = (fn: (session: string) => Promise<void>) => async (node?: Node) => {
  const session = await sessionArg(node)
  if (session !== undefined) await fn(session)
}

export const hideSession = withSession((session) => setSessionHidden([session], true))

export const showSession = withSession((session) => setSessionHidden([session], false))

/** This session shown, every other hidden. */
export const showOnlySession = withSession((session) => setSessionHidden([session], false, true))

export const showAllSessions = async () => { await state.update(HIDDEN_KEY, []); refreshAll() }

export const resolveSession = withSession(async (session) => {
  await resolve(notes().filter((n) => sessionOf(n) === session && n.data.status === 'open'), session ? ` in "${session}"` : '')
  // "Show only" this session, and it is done: show the others again.
  const h = hiddenSessions()
  const rest = new Set(notes().filter((n) => n.data.status === 'open').map(sessionOf))
  if (!rest.has(session) && rest.size && [...rest].every((s) => h.has(s))) {
    await state.update(HIDDEN_KEY, [])
    refreshAll()
    vscode.window.setStatusBarMessage('$(eye) Showing all sessions again', 3000)
  }
})

export const deleteSession = withSession(async (session) => {
  const list = notes().filter((n) => sessionOf(n) === session)
  const name = session || 'Notes'
  const detail = `They move to ${folderName()}/.trash and can be restored with Undo.`
  const ok = await vscode.window.showWarningMessage(`Delete the session "${name}" (${list.length} notes)?`, { modal: true, detail }, 'Delete')
  if (ok === 'Delete') await trash(list, `the session "${name}"`)
})
