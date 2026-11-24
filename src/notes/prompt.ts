// A prompt for an agent to answer notes, copied to the clipboard: for the notes ticked or one note, else for every
// note waiting for an answer.

import * as vscode from 'vscode'
import { byId, log, notes } from '../app'
import { me, waitingForAgent } from './identity'
import { checked } from '../sidebar/notesFilter'
import { folderName, Note } from './store'
import { plural, rangeLabel } from '../core/text'
import { notesFrom } from './which'
import { fileName } from '../platform/jsonFolder'
import { fireAndForget } from '../platform/run'

/** The prompt's words; `dir`: the notes folder. No frozen timestamp: a prompt pasted an hour later must not date replies in the past. */
const PROMPT = {
  rules: (dir: string, me: string) =>
    `Format and rules: ${dir}/README.md. I'm ${me}. Use the current time for "at". ` +
    'If a note is "stale", the code changed: "anchor.text" is what it was about. ' +
    "Answer in the note; don't change code unless a note asks you to.",
  answer: 'Read the code each one points at, then append your answer to "messages" with "role": "agent".',
  these: (count: number, which: string) => `Answer ${count === 1 ? 'my code note' : `these ${count} code notes`}: ${which}.`,
  waiting: (dir: string) =>
    `Answer my open code notes in ${dir}/: a note needs an answer when its status is "open" and its last message has "role": "human".`,
}

/** The prompt for these notes, or (none) for every note waiting for an answer. */
export function agentPrompt(list?: Note[]): string {
  const dir = folderName()
  const rules = PROMPT.rules(dir, me())
  if (list?.length) {
    const which = list.map((n) => `${dir}/${fileName(n.uri)} (${n.data.file} ${rangeLabel(n)})`).join(', ')
    return `${PROMPT.these(list.length, which)} ${PROMPT.answer} ${rules}`
  }
  return `${PROMPT.waiting(dir)} ${PROMPT.answer} ${rules}`
}

/** The toast says what is in the clipboard: the ticked notes, or the waiting ones. */
export const copyAgentPrompt = async () => {
  const waiting = notes().filter(waitingForAgent).length
  const ticked = [...checked].map(byId).filter((n): n is Note => !!n)
  if (!ticked.length && !waiting) {
    fireAndForget(vscode.window.showInformationMessage('No notes are waiting for an agent. Select notes (Ctrl+click) to ask about them.'), 'prompt: window.showInformationMessage')
    return
  }
  await vscode.env.clipboard.writeText(agentPrompt(ticked.length ? ticked : undefined))
  log.info(`copied a prompt for ${ticked.length ? ticked.map((n) => n.data.id).join(', ') : `the ${waiting} waiting notes`}`)
  const k = ticked.length || waiting
  fireAndForget(vscode.window.showInformationMessage(`Copied a prompt for ${plural(k, `${ticked.length ? 'selected' : 'waiting'} note`)}.`), 'prompt: window.showInformationMessage')
}

export const copyNotePrompt = async (arg?: any) => {
  const [n] = notesFrom(arg)
  if (!n) return
  await vscode.env.clipboard.writeText(agentPrompt([n]))
  fireAndForget(vscode.window.showInformationMessage('Copied a prompt for this note.'), 'prompt: window.showInformationMessage')
}
