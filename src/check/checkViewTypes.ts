// What the Check view's page (media/check.js, media/checkAnswer.js) is sent to draw (CheckView), and what the view
// model is told besides the CLI's status (CheckViewOptions, one slice per part that knows it). No vscode API here.
import type { Part } from '../core/linkParts'
import type { ActionId } from './checkWords'
import type { CommitPlan } from './commitPlan'
import type { QState, Who, Words } from './types'

export type { Part } from '../core/linkParts'

/** A question as a row of the view. */
export interface CheckRow {
  /** The question's id in the check file (what a click on the row posts). */
  id: string
  /** Its number, from 1. */
  n: number
  /** Its kind in words ("Edge case"). */
  kind: string
  /** The question; `name` in backticks is drawn as code. */
  text: string
  /** Where it points: "file:line", or the file alone. */
  where: string
  /** The other places it names, "file:start-end". */
  also: string[]
  state: QState
  /** The state in words ("try again"; '' when the icon says it all). */
  word: string
  /** A concern about the code, in a few words ("may be a bug"). */
  flag?: string
  /** The step of the tour after which it is asked. */
  step?: number
}

/** The view's one button. */
export interface ViewButton { id: ActionId; label: string }

export interface CheckView {
  branch: string; file: string
  tone: Words['tone']; title: string; line: string
  rows: CheckRow[]
  /** The one button, when there is one. */
  action?: ViewButton
  /** After a push of a branch without a merge request: a link that opens one. */
  mr?: string
  /** Someone else's check: whose, in one line. */
  who?: string
  /** Writing questions now: "Writing questions · 0:42 · reading the change". */
  busy?: string
  /** One line about what the questions left out. */
  notice?: string
  /** With Commit & push: what it commits ("feat-x.json, .gitattributes"), and files a TODO or an applied fix went to, to tick. */
  commits?: string
  also?: { file: string; label: string; on: boolean }[]
  /** The answer box: only for the selected question (answerBox.ts / media/checkAnswer.js). */
  answer?: AnswerBox
  /** Writing the questions failed: why, in plain words, with Retry (and the model setting when it was the model; install
   *  and the path setting when Claude Code wasn't found). */
  failed?: { text: string; setting?: boolean; path?: boolean }
  /** One line saying what was just done (a merge kept both answers). */
  said?: string
  /** The tour of the change: walk it ("Walk the tour · 9 steps"), or write one (an older check, a failed run). */
  tour?: { label: string; action?: 'walk' | 'write' }
}

/** The selected question's answer box in the Check view, and its latest grade (short). */
export interface AnswerBox {
  id: string; n: number
  /** The box is shown (not done yet, or explained: say it back); else only the grade and "Next question ›". */
  open: boolean
  draft: string
  checking?: boolean
  grade?: { pass: boolean; feedback: Part[]; hint?: Part[]; say?: string }
  /** "Next question ›": this one is done and another is open. */
  next?: boolean
  /** Grading failed (the answer is kept): why, with Try again. */
  error?: string
  /** A concern about the code (found while grading, or "may be a bug" once answered), with its actions; `applied`: its
   *  suggested fix is in the code, not committed yet. */
  concern?: { text: string; flagged: boolean; applied?: boolean }
}

/** How the last Commit & push (or Pull) went, as the view acts on it: Pull is offered after a rejected push. */
export type PushOutcome = 'pushed' | 'rejected' | 'other'

// ---- What the view shows besides the CLI's status, by the part that knows it (controller.ts current() gathers them) ----

/** The writer (writer.ts). */
export interface WriterView {
  /** Writing the questions now: "Writing questions · 0:42 · reading the change" (or "Pushing…"). */
  busy?: string
  /** Writing the tour now: "Writing the tour · 1:20". */
  tourBusy?: string
  /** The last try at the tour failed: offered again. */
  tourFailed?: boolean
  /** Writing the questions failed: why, with the setting that may help. */
  failed?: { text: string; setting?: boolean; path?: boolean }
  /** What the questions left out (uncommitted files). */
  notice?: string
  /** No check yet and nothing of the change committed: Commit… first. */
  uncommitted?: boolean
}

/** Grading (grading.ts). */
export interface GraderView {
  /** Questions being graded, or whose answer is being taken. */
  grading?: Set<string>
  /** Why grading the selected question failed. */
  error?: string
}

/** Commit & push (push.ts). */
export interface PushView {
  /** The branch has commits its remote doesn't, or no upstream (undefined: not known). */
  unpushed?: boolean
  /** What the last Commit & push (or Pull) said. */
  pushed?: string
  /** How it went; without it, read from `pushed` (viewModel.ts pushOutcome). */
  pushOutcome?: PushOutcome
  /** The push's "create a merge request" link. */
  mr?: string
  /** What Commit & push would commit. */
  commit?: CommitPlan
}

/** The view itself and the check's state (controller.ts, state.ts). */
export interface SelectionView {
  /** The question selected in the view (its answer box is shown), and its unsent answer. */
  selected?: string
  draft?: string
  /** One line about what was just done (a merge kept both answers). */
  said?: string
  /** Who answers (git's identity): someone else's check says whose it is. */
  me?: Who
  /** Where an invalid check file stops being JSON ("Line 3: expected double-quoted property name."). */
  invalidAt?: string
}

export type CheckViewOptions = WriterView & GraderView & PushView & SelectionView
