// Who wrote a message or made a status change. The extension writes a role on everything it writes ("human" for the
// person, "agent" for Claude and the check); names decide only for files written without one (older files, agents
// that leave it out) and to tell the person from other people. Pure.

import type { Role } from '../../core/format/noteModel'

/** The names that were the person's by default once: their messages still count as theirs. */
export const LEGACY_MY_NAMES: readonly string[] = ['me', 'You']

export interface MyNames {
  /** The name notes are written under now. */
  current: string
  /** Names used before (an author setting changed), and the OS account's (in a container: "openvscode-server"). */
  past: readonly string[]
}

/** A name of the person's: now, earlier, the OS account's, or a legacy default. */
export const isMyName = (name: string, me: MyNames) => name === me.current || LEGACY_MY_NAMES.includes(name) || me.past.includes(name)

export interface Authorship {
  /** Written by the person (by name: another person's message has role "human" too). */
  mine: boolean
  /** Written by an agent: role "agent"; with no role, anything not the person's. */
  agent: boolean
}

/** The one rule for who wrote `m`. */
export function classifyAuthor(m: { author: string; role?: Role }, me: MyNames): Authorship {
  const mine = isMyName(m.author, me)
  return { mine, agent: m.role === 'agent' || (!m.role && !mine) }
}
