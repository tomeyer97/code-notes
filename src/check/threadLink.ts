// A check thread's link to its question (in the note's `extra.check`): which check file, which question, and a hash
// of the question's text when the thread was made. Also the other keys the check keeps in a note's `extra`.
import { createHash } from 'crypto'
import type { Note } from '../notes/store'
import type { Question } from './types'
import { questionBody } from './threadText'

/** A check thread's link: the check file, the question's id, and a hash of the text it was shown with. */
export interface CheckLink { file: string; q: string; h?: string }

/**
 * The keys the check keeps in a note's `extra` (core/format/noteModel.ts keeps unknown keys as they are): a check
 * thread's link to its question, and on a note made from one (Ask Claude, Suggest a fix) its check file and question.
 */
export interface CheckNoteExtra {
  check?: CheckLink
  checkFile?: string
  checkAsk?: string
  checkFix?: string
}
/** A note's `extra`, read as the check's keys (the one place it is cast). */
export const checkExtra = (n: Note): CheckNoteExtra => (n.data.extra ?? {}) as CheckNoteExtra

/** A thread's link to its question, if it is a check thread. */
export const linkOf = (n: Note): CheckLink | undefined => checkExtra(n).check
export const isCheck = (n: Note): boolean => !!linkOf(n)

/** A short hash of a question's id and text: a thread made for other words is not this question's any more. */
export function textHash(q: Question): string {
  const sha = createHash('sha1').update(`${q.id}\0${q.text}`, 'utf8')
  return sha.digest('hex').slice(0, 12)
}
/** The thread was made for this question as it is now (an older thread without a hash: its first message says). */
export function sameQuestion(n: Note, q: Question): boolean {
  const h = linkOf(n)?.h
  return h ? h === textHash(q) : n.data.messages[0]?.body === questionBody(q)
}
