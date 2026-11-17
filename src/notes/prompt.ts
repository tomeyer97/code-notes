// A prompt for an agent (in the clipboard) to answer notes.

import * as vscode from 'vscode'
import { byId, log, notes } from '../app'
import { mine } from '../identity'
import { checked, lastMessage } from '../sidebar/nodes'
import { Note } from '../store'
import { agentPrompt } from './folder'
import { notesFrom } from './target'

/** The toast says what is in the clipboard: the ticked notes, or the waiting ones. */
export const copyAgentPrompt = async () => {
  const waiting = notes().filter((n) => n.data.status === 'open' && lastMessage(n) && mine(lastMessage(n)!)).length
  const ticked = [...checked].map(byId).filter((n): n is Note => !!n)
  if (!ticked.length && !waiting) { vscode.window.showInformationMessage('No notes are waiting for an agent. Select notes (Ctrl+click) to ask about them.'); return }
  await vscode.env.clipboard.writeText(agentPrompt(ticked.length ? ticked : undefined))
  log.info(`copied a prompt for ${ticked.length ? ticked.map((n) => n.data.id).join(', ') : `the ${waiting} waiting notes`}`)
  const k = ticked.length || waiting
  vscode.window.showInformationMessage(`Copied a prompt for ${k} ${ticked.length ? 'selected' : 'waiting'} note${k === 1 ? '' : 's'}.`)
}

export const copyNotePrompt = async (arg?: any) => {
  const [n] = notesFrom(arg)
  if (!n) return
  await vscode.env.clipboard.writeText(agentPrompt([n]))
  vscode.window.showInformationMessage('Copied a prompt for this note.')
}
