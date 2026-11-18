// Who the person is: their name in notes, names they used before, and whether a message is theirs or an agent's.
// (What git says about the checkout: checkout.ts.)

import * as vscode from 'vscode'
import * as os from 'os'
import { cfg, state } from './app'
import { git } from './checkout'
import { Message, NoteEvent } from './noteModel'
import { Note } from './store'

let gitName: string | undefined

/** The OS account name: not shown (in a container it is "openvscode-server"), but notes written under it are yours. */
const osName = (() => { try { return os.userInfo().username } catch { return undefined } })()

export const me = () => cfg().get<string>('author') || gitName || 'You'

/** Names this person wrote under before (the author setting changed): still theirs. */
const PAST_KEY = 'codeNotes.pastNames'

const pastNames = () => state.get<string[]>(PAST_KEY) ?? []

/** The name in use when last looked at (an author setting changed from it is remembered as a past name). */
let lastMe = ''

/** A name of yours: your name now, an earlier name of yours, the OS account's, or "me"/"You" (the old defaults). */
function isMyName(name: string): boolean {
  return name === me() || name === 'me' || name === 'You' || (!!osName && name === osName) || pastNames().includes(name)
}

/** Yours: written under a name of yours. */
export const mine = (m: Message) => isMyName(m.author)

export const evMine = (e: NoteEvent) => isMyName(e.by)

/** An agent's message: marked as such, or (unmarked) not yours. */
export const isAgent = (m: Message) => m.role === 'agent' || (!m.role && !mine(m))

/** Waiting for an agent: open, and the last word is yours. */
export function waitingForAgent(n: Note): boolean {
  const last = n.data.messages[n.data.messages.length - 1]
  return n.data.status === 'open' && !!last && mine(last)
}

/** The name to write notes under: git's user.name in the first folder, unless the author setting names one. */
export async function initIdentity(folder: vscode.WorkspaceFolder | undefined): Promise<void> {
  gitName = await git(folder, ['config', 'user.name'])
}

/** Called once the notes are read: the name they are compared with from now on. */
export function rememberMe(): void { lastMe = me() }

/** The author setting changed: messages under the old name stay yours. */
export async function authorChanged(): Promise<void> {
  if (lastMe && lastMe !== me() && !pastNames().includes(lastMe)) await state.update(PAST_KEY, [...pastNames(), lastMe])
  lastMe = me()
}
