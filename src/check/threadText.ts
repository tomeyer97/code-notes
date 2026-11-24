// A question's thread as text: the question (with the code it also depends on), the grader's replies, the code links
// of each message, and the messages a thread is missing. No vscode API here (unit-tested in
// test/checkThreadText.test.ts).
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
 * Where a check thread's grades are: the thread is the question (message 0), then each answer and its grade, as
 * threads.ts writes them; the k-th agent reply after the question holds the k-th grade gradedAttempts lists. Every
 * reader of a thread by position goes through this (`roles`: each message's role).
 */
export function gradeMessages(roles: readonly string[]): number[] {
  return roles.flatMap((r, i) => (i > 0 && r === 'agent' ? [i] : []))
}

/**
 * The code links of message `mi` of a check thread (`roles`: each message's role): the question's for the first
 * message, then each grade's own. Answers have none.
 */
export function linksAt(q: Question, roles: string[], mi: number): Link[] {
  if (roles[mi] !== 'agent') return []
  // The question's own links, then its "Also read" names (last in its text, so they are found there).
  if (mi === 0) return [...(q.links ?? []), ...alsoLinks(q)]
  const k = gradeMessages(roles).indexOf(mi)
  return gradedAttempts(q)[k]?.links ?? []
}

/**
 * The attempts whose grade the thread shows, in order (see gradeMessages): a superseded answer's grade only when it
 * explained (the lesson stays). threads.ts writes the thread by this.
 */
export function gradedAttempts(q: Question): Attempt[] {
  return (q.attempts ?? []).filter(showsGrade)
}
/** The index of the message that holds the k-th grade (k from 1, see gradeMessages); -1 when the thread has none. */
export function gradeMessageAt(roles: string[], k: number): number {
  return gradeMessages(roles)[k - 1] ?? -1
}
/** An attempt whose grade is in the thread (see gradedAttempts). */
export const showsGrade = (a: Attempt): boolean => !!a.verdict && (a.answer !== undefined || a.verdict === 'explained')

/** After an explanation: the offer to say it back (the thread and the Check view say the same words). */
export const SAY_IT_BACK = 'Got it? Say it back in one sentence (optional).'

/** The grader's words around its feedback in a thread. */
export const GRADE_WORDS = {
  /** A pass with no feedback. */
  right: 'Right.',
  /** A retry opens with it (unless the grader's own words already do). */
  notQuite: 'Not quite.',
  hint: 'Hint:',
  sayItBack: SAY_IT_BACK,
  /** After a restatement that missed: the question is done anyway. */
  tryOnceMore: 'Try once more, or leave it: it is done.',
} as const

/** The markdown a thread message uses. */
const md = { bold: (s: string) => `**${s}**`, italic: (s: string) => `_${s}_` }

/**
 * The grader's reply as parts: pass → a short confirmation; retry → feedback + hint; explained → the explanation and
 * an offer to say it back; a restatement that missed (`restatement`) → what is still off, and that it is done anyway.
 */
export type GradeReply =
  | { tone: 'pass'; feedback: string }
  | { tone: 'retry'; feedback: string; hint?: string }
  | { tone: 'explained'; feedback: string; offer: 'sayItBack' | 'tryOnceMore' }

export function gradeReply(a: Attempt, o: { restatement?: boolean } = {}): GradeReply {
  if (a.verdict === 'pass' || a.verdict === 'restated') {
    return { tone: 'pass', feedback: a.feedback || GRADE_WORDS.right }
  }
  if (a.verdict === 'retry') {
    return { tone: 'retry', feedback: retryText(a.feedback), ...(a.hint ? { hint: a.hint } : {}) }
  }
  return { tone: 'explained', feedback: a.feedback ?? '', offer: o.restatement ? 'tryOnceMore' : 'sayItBack' }
}

/** The grader's reply in the thread, as markdown (see gradeReply). */
export function gradeBody(a: Attempt, o: { restatement?: boolean } = {}): string {
  const r = gradeReply(a, o)
  switch (r.tone) {
    case 'pass': return `✓ ${r.feedback}`
    case 'retry': return (r.hint ? `${r.feedback}\n\n${md.bold(GRADE_WORDS.hint)} ${r.hint}` : r.feedback).trim()
    case 'explained': return `${r.feedback}\n\n${md.italic(GRADE_WORDS[r.offer])}`.trim()
  }
}

/** A retry's feedback, opening with "Not quite." (unless the grader's words already do). */
export function retryText(feedback: string | undefined): string {
  const text = feedback ?? ''
  const stem = GRADE_WORDS.notQuite.replace(/\.$/, '').toLowerCase()
  return text.toLowerCase().startsWith(stem) ? text : `${GRADE_WORDS.notQuite} ${text}`
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
