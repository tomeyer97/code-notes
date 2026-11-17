// A check thread's link to its question (in the note's `extra.check`): which check file, which question, and a hash
// of the question's text when the thread was made.
import { createHash } from 'crypto'
import type { Note } from '../store'
import { Question, questionBody } from '../checkModel'

export const isCheck = (n: Note): boolean => !!(n.data.extra as { check?: unknown } | undefined)?.check
/** A thread's link to its question: the check file, the question's id, and a hash of the text it was shown with. */
export const linkOf = (n: Note) => (n.data.extra as { check?: { file: string; q: string; h?: string } } | undefined)?.check
export const textHash = (q: Question): string => createHash('sha1').update(`${q.id}\0${q.text}`, 'utf8').digest('hex').slice(0, 12)
/** The thread was made for this question as it is now (an older thread without a hash: its first message says). */
export function sameQuestion(n: Note, q: Question): boolean {
  const h = linkOf(n)?.h
  return h ? h === textHash(q) : n.data.messages[0]?.body === questionBody(q)
}
