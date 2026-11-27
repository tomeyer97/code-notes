// What the rest of the extension may ask the understanding check (the threads, the tour, the code links), and the
// arguments of the commands the check's thread links run. No vscode at run time.
import type * as vscode from 'vscode'
import type { Note } from '../notes/store'
import type { Link, QState, Question } from './types'
import { isConcernAction, type ConcernAction } from './concernState'

/** A check thread's state for its comments (threads/comments.ts commentsOf). */
export interface ThreadStatus {
  /** Being graded (or its answer taken). */
  checking?: boolean
  /** Why it couldn't be graded. */
  error?: string
  /** A concern about the code; `todo`: where a TODO about it was added ("limits.js:12"). */
  concern?: { text: string; flagged: boolean; suspect: boolean; by?: string; todo?: string }
  /** Done, and another question is open: "Next question ›". */
  next?: boolean
}

/** A question as a stop of the check's tour: after which step, its state. */
export interface TourStop { id: string; n: number; step: number; text: string; state: QState }

/** What other modules ask the check (the controller answers). */
export interface CheckQuery {
  isCheck(n: Note): boolean
  /** A check thread of another branch's check, or a note made from one: not shown. */
  offBranch(n: Note): boolean
  /** For a note made from a check thread: the check it belongs to. */
  branchOf(n: Note): { checkFile?: string }
  /** Graded in this window: the thread stays open where it is. */
  pinned(n: Note): boolean
  /** The ids of the questions not done yet in this file. */
  openIn(uri: vscode.Uri): string[]
  hasOpenIn(uri: vscode.Uri): boolean
  threadStatus(n: Note): ThreadStatus | undefined
  /** A check thread's question id. */
  qidOf(n: Note): string | undefined
  rowOf(n: Note): { text: string; state: string } | undefined
  /** The code links of message `mi` of a check thread (with the line text to find them after edits). */
  linksIn(n: Note, mi: number): (Link & { text: string })[]
  questionOf(n: Note): Question | undefined
  tourStops(): TourStop[]
}

// ---------- the commands of a check thread's links (threads/comments.ts builds them with cmdLink) ----------

/** codeNotes.checkConcern's arguments: `action` on note `id`'s concern; `reason`: a dismissal's. */
export interface CheckConcernArgs { id: string; action: ConcernAction; reason?: string }
/** The arguments, in the order the command takes them. */
export const checkConcernArgs = (a: CheckConcernArgs): string[] => [a.id, a.action, ...(a.reason !== undefined ? [a.reason] : [])]
/** The command's arguments as a link passed them (anything: a link can be written by hand); undefined: not valid. */
export function parseCheckConcernArgs(id: unknown, action: unknown, reason: unknown): CheckConcernArgs | undefined {
  if (typeof id !== 'string' || !isConcernAction(action)) return undefined
  return typeof reason === 'string' ? { id, action, reason } : { id, action }
}
/** codeNotes.gradeCheck's argument (Try again): a note id. */
export const parseNoteIdArg = (id: unknown): string | undefined => (typeof id === 'string' ? id : undefined)
