// The words a thread's and a comment's contextValue is made of. package.json's menus test them (`commentThread =~
// /stale/`, `comment == message`); test/threadContext.test.ts checks every word the menus use is one of these. No
// vscode here.

/** A note thread's words: "note;open;stale;asking;check" (the ones that apply). */
export const THREAD_WORD = {
  note: 'note',
  open: 'open',
  resolved: 'resolved',
  stale: 'stale',
  /** Claude is answering the note. */
  asking: 'asking',
  /** A question of the understanding check. */
  check: 'check',
} as const

export type ThreadWord = (typeof THREAD_WORD)[keyof typeof THREAD_WORD]

/** A comment's contextValue: a row the extension writes, a status change, or a message. */
export const COMMENT_CONTEXT = { system: 'system', event: 'event', message: 'message' } as const

export type CommentContext = (typeof COMMENT_CONTEXT)[keyof typeof COMMENT_CONTEXT]

/** The thread's contextValue: note, its status, stale, then the words the features add (asking, check). */
export function threadContextValue(status: 'open' | 'resolved', stale: boolean, more: readonly ThreadWord[]): string {
  const words: ThreadWord[] = [THREAD_WORD.note, status === 'open' ? THREAD_WORD.open : THREAD_WORD.resolved]
  if (stale) words.push(THREAD_WORD.stale)
  return [...words, ...more].join(';')
}

/** Why a note has a thread in the editor (undefined: it has none). */
export type ShownBecause = 'open' | 'showResolved' | 'unread' | 'revealed' | 'pinned' | 'working' | 'failed'

export interface ShownFacts {
  open: boolean
  /** The setting shows resolved notes in the editor. */
  showResolved: boolean
  unread: boolean
  /** The note the person opened last. */
  revealed: boolean
  /** Kept in view by a feature (the check's graded question). */
  pinned: boolean
  /** Its session is hidden in the editor. */
  hidden: boolean
  /** A feature is at work on it (Claude answering, the check grading). */
  working: boolean
  /** A feature's work on it failed (the thread says so, with Try again). */
  failed: boolean
}

/** Listed notes are shown unless their session is hidden; one at work or failed is always shown. */
export function shownBecause(f: ShownFacts): ShownBecause | undefined {
  if (!f.hidden) {
    const listed: [boolean, ShownBecause][] = [
      [f.open, 'open'], [f.showResolved, 'showResolved'], [f.unread, 'unread'], [f.revealed, 'revealed'], [f.pinned, 'pinned'],
    ]
    const why = listed.find(([yes]) => yes)
    if (why) return why[1]
  }
  if (f.working) return 'working'
  if (f.failed) return 'failed'
  return undefined
}
