// The Check view's and the status bar's own words, in one place: a change of wording (or a translation) starts here.
// The CLI's words (where the check stands: Words) come with the status; the thread's words are threadText.ts's
// (re-exported below so they can be found from here). No vscode API here.
import type { Kind, QState } from './types'

export { SAY_IT_BACK } from './threadText'
export { SUSPECT } from './concernState'

/** A question's kind, as its row says it. */
export const KIND_LABEL: Record<Kind, string> = { how: 'How', why: 'Why', failure: 'Failure', edge: 'Edge case', change: 'Change' }

/** The words of a row's state (the icon says the rest). */
export const STATE_WORD: Record<QState, string> = {
  todo: '',
  ungraded: 'not graded',
  pass: '',
  retry: 'try again',
  explained: 'explained · say it back',
  restated: 'in your words',
}
/** A row whose answer is being graded. */
export const GRADING_WORD = 'checking…'

/** A row's flag when its question has a concern, by what became of it (flagWord in viewModel.ts picks one). */
export const FLAG_WORD = {
  applied: 'fix applied · not committed',
  suspect: 'may be a bug',
  flagged: 'flagged for review',
  concern: 'concern',
} as const

/** The view's buttons, id → label. The id is also what the button sends (viewMessages.ts CHECK_VIEW_REQUESTS). */
export const ACTIONS = {
  start: 'Start',
  topUp: 'Add questions',
  scm: 'Commit…',
  commitPush: 'Commit & push',
  openFile: 'Open',
  merge: 'Keep both answers',
  pull: 'Pull',
} as const
export type ActionId = keyof typeof ACTIONS
/** Commit & push's label when there is nothing to commit, only to push. */
export const PUSH_ONLY_LABEL = 'Push'

/** The line above the button where the button needs its own (else the CLI's line). */
export const LINE = {
  commitFirst: "Your change isn't committed yet: the questions are about committed code. Commit it and the check starts.",
  fixNotCommitted: 'Your fix is not committed yet.',
  notPushed: 'Not pushed yet.',
  tourOnly: 'Only the tour is new: it can go with your next push.',
  /** Also what push.ts says after a push that went through. */
  pushed: 'Pushed.',
} as const

/** The tour's link. */
export const TOUR = {
  walk: (steps: number) => `Walk the tour · ${steps} steps`,
  write: 'Write a tour',
  failed: "Couldn't write the tour · Try again",
} as const

/** Someone else's check (`whose`: their name, else their email). */
export const whoseCheck = (whose: string | undefined) => `${whose}'s check: your answers are recorded as yours.`

/** What Commit & push commits, and the files offered to tick beside it. */
export const COMMITS = {
  files: (names: string[], extra: string) => `Commits ${names.join(', ')}${extra}`,
  tourOnly: ' (the tour)',
  fold: 'also folds check files in diffs (.gitattributes)',
  yourFix: (name: string) => `${name} (your fix)`,
  todoAdded: (name: string) => `also ${name} (TODO added)`,
} as const

/** A pass graded without feedback. */
export const RIGHT = 'Right.'

/** "Writing questions · 0:42": what is being done, and for how long (`clock`: the time it has taken). */
export const busyWords = (what: string, clock: string) => `${what} · ${clock}`

/** The status bar item's icon (a codicon) by where the check stands. */
export const STATUS_ICON = { done: '$(pass)', warn: '$(warning)', todo: '$(checklist)' } as const
