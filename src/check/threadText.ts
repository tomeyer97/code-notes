// A question's thread as text: the question (with the code it also depends on), the grader's replies, the code links
// of each message, and the messages a thread is missing. No vscode API here (unit-tested in test/checkModel.test.ts).
import type { Attempt, Link, Question, Range } from './types'
import { baseName } from '../core/paths'

/** The question as the first message of its thread; unchanged code it depends on (not linked from its words) below it. */
export function questionBody(q: Question): string {
  const also = alsoLinks(q)
  return also.length ? `${q.text}\n\nAlso read: ${also.map((l) => l.phrase).join(', ')}` : q.text
}

/**
 * The unchanged code a question also depends on (not linked from its words already), as code links named by file
 * ("queue.js"; "queue.js (2)" for a second range in it): a click lights the lines, never a line number.
 */
export function alsoLinks(q: Question): Link[] {
  const linked = (r: Range) => (q.links ?? []).some((l) => l.file === r.file && l.start <= r.end && r.start <= l.end)
  const seen = new Map<string, number>()
  return (q.also ?? []).filter((r) => !linked(r)).map((r) => {
    const name = baseName(r.file), k = (seen.get(name) ?? 0) + 1
    seen.set(name, k)
    return { phrase: k > 1 ? `${name} (${k})` : name, file: r.file, start: r.start, end: r.end }
  })
}

/**
 * The code links of message `mi` of a check thread (`roles`: each message's role): the question's for the first
 * message, then each grade's own (the n-th agent reply is the n-th graded attempt). Answers have none.
 */
export function linksAt(q: Question, roles: string[], mi: number): Link[] {
  if (roles[mi] !== 'agent') return []
  const k = roles.slice(0, mi).filter((r) => r === 'agent').length
  // The question's own links, then its "Also read" names (last in its text, so they are found there).
  if (k === 0) return [...(q.links ?? []), ...alsoLinks(q)]
  return gradedAttempts(q)[k - 1]?.links ?? []
}

/**
 * The attempts whose grade the thread shows, in order (the n-th agent reply after the question is the n-th of them): a
 * superseded answer's grade only when it explained (the lesson stays). threads.ts messagesOf writes the thread by this.
 */
export function gradedAttempts(q: Question): Attempt[] {
  return (q.attempts ?? []).filter(showsGrade)
}
/**
 * The index of the message that holds the k-th grade gradedAttempts lists (k from 1: the k-th agent reply after the
 * question); -1 when the thread has none (`roles`: each message's role).
 */
export function gradeMessageAt(roles: string[], k: number): number {
  let seen = 0
  return roles.findIndex((r, x) => x > 0 && r === 'agent' && ++seen === k)
}
/** An attempt whose grade is in the thread (see gradedAttempts). */
export const showsGrade = (a: Attempt): boolean => !!a.verdict && (a.answer !== undefined || a.verdict === 'explained')

/**
 * The grader's reply in the thread: pass → a short confirmation; retry → feedback + hint; explained → the
 * explanation and an offer to say it back; a restatement → ✓, or what is still off.
 */
export function gradeBody(a: Attempt, o: { restatement?: boolean } = {}): string {
  if (a.verdict === 'pass' || a.verdict === 'restated') return `✓ ${a.feedback || 'Right.'}`
  if (a.verdict === 'retry') return `${retryText(a.feedback)}${a.hint ? `\n\n**Hint:** ${a.hint}` : ''}`.trim()
  if (o.restatement) return `${a.feedback ?? ''}\n\n_Try once more, or leave it: it is done._`.trim()
  return `${a.feedback ?? ''}\n\n_${SAY_IT_BACK}_`.trim()
}

/** After an explanation: the offer to say it back (the thread and the Check view say the same words). */
export const SAY_IT_BACK = 'Got it? Say it back in one sentence (optional).'
/** A retry's feedback, opening with "Not quite." (unless the grader's words already do). */
export function retryText(feedback: string | undefined): string {
  return `${/^not quite/i.test(feedback ?? '') ? '' : 'Not quite. '}${feedback ?? ''}`
}

/**
 * The messages of `want` that a thread (`have`) doesn't hold yet. Append-only: the thread may hold more (a remark
 * after the question was done), never less; its first k human (agent) messages stand for want's first k.
 */
export function missingMessages<M extends { role?: string }>(have: M[], want: M[]): M[] {
  const seen = { human: have.filter((m) => m.role === 'human').length, agent: have.filter((m) => m.role === 'agent').length }
  return want.filter((m) => {
    const role = m.role === 'human' ? 'human' : 'agent'
    if (seen[role] > 0) { seen[role]--; return false }
    return true
  })
}
