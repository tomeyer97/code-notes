// Who the person is: their name in notes and names they used before; whether a message is theirs or an agent's is
// model/author.ts's classifyAuthor. (What git says about the checkout: platform/checkout.ts.)

import * as vscode from 'vscode'
import * as os from 'os'
import { stored } from '../app'
import { gitIn } from '../platform/checkout'
import { cfg } from '../platform/settings'
import { Message, NoteEvent } from '../core/format/noteModel'
import { classifyAuthor, MyNames } from './model/author'
import { Note } from './store'
import { STATE } from '../platform/state'

/** The OS account name: not shown (in a container it is "openvscode-server"), but notes written under it are yours. */
const osName = (() => { try { return os.userInfo().username } catch { return undefined } })()

/** What identity knows: git's user.name (read at the start), and the name in use when last looked at (an author
 *  setting changed from it is remembered as a past name). */
const known: { gitName?: string; lastMe: string } = { lastMe: '' }

export const me = () => cfg().get<string>('author') || known.gitName || 'You'

const pastNames = () => stored.get(STATE.pastNames)

const myNames = (): MyNames => ({ current: me(), past: osName ? [osName, ...pastNames()] : pastNames() })

/** Yours: written under a name of yours. */
export const mine = (m: Message) => classifyAuthor(m, myNames()).mine

export const evMine = (e: NoteEvent) => classifyAuthor({ author: e.by, role: e.role }, myNames()).mine

/** An agent's message: marked as such, or (unmarked) not yours. */
export const isAgent = (m: Message) => classifyAuthor(m, myNames()).agent

/** Waiting for an agent: open, and the last word is yours. */
export function waitingForAgent(n: Note): boolean {
  const last = n.data.messages[n.data.messages.length - 1]
  return n.data.status === 'open' && !!last && mine(last)
}

/** The name to write notes under: git's user.name in the first folder, unless the author setting names one. */
export async function initIdentity(folder: vscode.WorkspaceFolder | undefined): Promise<void> {
  known.gitName = await gitIn(folder, ['config', 'user.name'])
}

/** Called once the notes are read: the name they are compared with from now on. */
export function rememberMe(): void { known.lastMe = me() }

/** The author setting changed: messages under the old name stay yours. */
export async function authorChanged(): Promise<void> {
  const { lastMe } = known
  if (lastMe && lastMe !== me() && !pastNames().includes(lastMe)) await stored.set(STATE.pastNames, [...pastNames(), lastMe])
  known.lastMe = me()
}
