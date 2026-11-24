// A concern about the code (found while grading, or a question's "may be a bug"): whether it is shown, and the people
// in it (who flagged it, who fixed it). No vscode API here (unit-tested in test/checkModel.test.ts).
import type { Question, Who } from './types'

/**
 * A question's concern: the one stored on it (found while grading), else the question's own "may be a bug", shown
 * only once it has been answered (before, it would give the answer away).
 */
export function concernOf(q: Question): { text: string; flagged: boolean; suspect: boolean; by?: string } | undefined {
  // Dismissed (with a reason) or marked fixed: done with; nothing more to do about it.
  if (q.concern?.dismissed || q.concern?.fixed) return undefined
  if (q.concern?.text) return { text: q.concern.text, flagged: !!q.concern.flagged, suspect: !!q.suspect && SUSPECTS.includes(q.concern.text), ...(q.concern.by ? { by: q.concern.by.name ?? q.concern.by.email } : {}) }
  return q.suspect && (q.attempts ?? []).some((a) => a.verdict) ? { text: SUSPECT, flagged: false, suspect: true } : undefined
}
export const SUSPECT = 'May be a bug.'
/** Its words in files written before (kept as a concern's text when flagged). */
const SUSPECTS = [SUSPECT, 'May be a bug: fix it or explain.']


/** One person's identity as stored in the check file: only the fields git has. */
export function whoOf(me: Who): Who {
  const who: Who = {}
  if (me.name) who.name = me.name
  if (me.email) who.email = me.email
  return who
}
/**
 * The same person: by email when both have one, else by name. (The CLI's sameWho, cli/understanding/checkFile.ts, is
 * this rule for the CLI and the merge request; the view model here is loaded without the CLI.)
 */
export function samePerson(a: Who, b: Who): boolean {
  return a.email && b.email ? a.email === b.email : a.name === b.name
}

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
