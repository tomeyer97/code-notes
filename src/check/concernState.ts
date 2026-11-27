// A concern about the code (found while grading, or a question's "may be a bug"): whether it is shown, and the people
// in it (who flagged it, who fixed it). No vscode API here (unit-tested in test/checkConcernState.test.ts).
import { sameWho } from '../../cli/understanding/checkFile'
import type { Question, Who } from './types'

/** The actions the Check view's buttons send: Suggest a fix, Add a TODO, Flag for review, Dismiss. */
export const VIEW_CONCERN_ACTIONS = ['fix', 'todo', 'flag', 'dismiss'] as const
/** Every action on a concern (the codeNotes.checkConcern command takes any of them): the view's, and marked fixed. */
export const CONCERN_ACTIONS = [...VIEW_CONCERN_ACTIONS, 'fixed'] as const
export type ViewConcernAction = (typeof VIEW_CONCERN_ACTIONS)[number]
export type ConcernAction = (typeof CONCERN_ACTIONS)[number]

const oneOf = <T extends string>(list: readonly T[]) => (a: unknown): a is T => (list as readonly unknown[]).includes(a)
/** A command's argument read as a ConcernAction. */
export const isConcernAction = oneOf(CONCERN_ACTIONS)
/** One of the Check view's concern buttons. */
export const isViewConcernAction = oneOf(VIEW_CONCERN_ACTIONS)

/** A concern as shown: its words, flagged for review, whether it is the question's own "may be a bug", who flagged it. */
export interface ConcernView {
  text: string
  flagged: boolean
  suspect: boolean
  by?: string
}

export const SUSPECT = 'May be a bug.'
/**
 * The words a question's own "may be a bug" was stored with when flagged, this version's and older ones: a concern
 * with one of them is that one (the file keeps no kind for it). Add the old wording here when SUSPECT changes.
 */
const SUSPECT_WORDINGS: readonly string[] = [SUSPECT, 'May be a bug: fix it or explain.']

/**
 * A question's concern: the one stored on it (found while grading), else the question's own "may be a bug", shown
 * only once it has been answered (before, it would give the answer away).
 */
export function concernOf(q: Question): ConcernView | undefined {
  const c = q.concern
  // Dismissed (with a reason) or marked fixed: done with; nothing more to do about it.
  if (c?.dismissed || c?.fixed) return undefined
  if (c?.text) {
    const suspect = !!q.suspect && SUSPECT_WORDINGS.includes(c.text)
    const by = c.by ? { by: c.by.name ?? c.by.email } : {}
    return { text: c.text, flagged: !!c.flagged, suspect, ...by }
  }
  const graded = (q.attempts ?? []).some((a) => a.verdict)
  return q.suspect && graded ? { text: SUSPECT, flagged: false, suspect: true } : undefined
}

/** One person's identity as stored in the check file: only the fields git has. */
export function whoOf(me: Who): Who {
  const who: Who = {}
  if (me.name) who.name = me.name
  if (me.email) who.email = me.email
  return who
}
/** The same person: by email when both have one, else by name (the CLI's rule, for the merge request too). */
export const samePerson = (a: Who, b: Who): boolean => sameWho(a, b)

/**
 * A concern done with: dismissed (`how.reason`) or fixed, by `me` (when git knows who that is) at `at`; no longer
 * flagged. `text`: its words when the question has no concern stored yet (its own "may be a bug").
 */
export function settledConcern(
  c: Question['concern'], text: string, how: { reason: string } | { fixed: true }, me: Who | undefined, at: string,
): NonNullable<Question['concern']> {
  const by = me?.name || me?.email ? { by: whoOf(me) } : {}
  const done = 'reason' in how ? { dismissed: { reason: how.reason, ...by, at } } : { fixed: { ...by, at } }
  return { ...(c ?? { text }), text: c?.text ?? text, flagged: false, ...done }
}
