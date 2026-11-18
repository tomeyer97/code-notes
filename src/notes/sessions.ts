// Note sessions (a review's findings): hidden or shown in the editor, resolved or deleted as a whole.

import * as vscode from 'vscode'
import { notes, state } from '../app'
import { refreshAll } from '../refresh'
import { Node, sessionOf } from '../sidebar/nodes'
import { HIDDEN_KEY, hiddenSessions, setSessionHidden } from '../sidebar/notesFilter'
import { folderName } from '../store'
import { resolve, trash } from './status'

const sessionArg = async (node?: Node): Promise<string | undefined> => {
  if (node?.kind === 'session') return node.name
  const names = [...new Set(notes().map(sessionOf))]
  if (names.length <= 1) return names[0]
  const pick = await vscode.window.showQuickPick(names.map((n) => ({ label: n || 'Notes', name: n, description: `${notes().filter((x) => sessionOf(x) === n).length} notes` })), { title: 'Which session?' })
  return pick?.name
}

export const hideSession = async (node?: Node) => { const x = await sessionArg(node); if (x !== undefined) await setSessionHidden([x], true) }

export const showSession = async (node?: Node) => { const x = await sessionArg(node); if (x !== undefined) await setSessionHidden([x], false) }

export const showOnlySession = async (node?: Node) => { const x = await sessionArg(node); if (x !== undefined) await setSessionHidden([x], false, true) }

export const showAllSessions = async () => { await state.update(HIDDEN_KEY, []); refreshAll() }

export const resolveSession = async (node?: Node) => {
  const x = await sessionArg(node)
  if (x === undefined) return
  await resolve(notes().filter((n) => sessionOf(n) === x && n.data.status === 'open'), x ? ` in "${x}"` : '')
  // "Show only" this session, and it is done: show the others again.
  const h = hiddenSessions()
  const rest = new Set(notes().filter((n) => n.data.status === 'open').map(sessionOf))
  if (!rest.has(x) && rest.size && [...rest].every((s) => h.has(s))) {
    await state.update(HIDDEN_KEY, [])
    refreshAll()
    vscode.window.setStatusBarMessage('$(eye) Showing all sessions again', 3000)
  }
}

export const deleteSession = async (node?: Node) => {
  const x = await sessionArg(node)
  if (x === undefined) return
  const list = notes().filter((n) => sessionOf(n) === x)
  const ok = await vscode.window.showWarningMessage(`Delete the session "${x || 'Notes'}" (${list.length} notes)?`, { modal: true, detail: `They move to ${folderName()}/.trash and can be restored with Undo.` }, 'Delete')
  if (ok === 'Delete') await trash(list, `the session "${x || 'Notes'}"`)
}
