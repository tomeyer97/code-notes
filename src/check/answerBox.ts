// The selected question's answer box in the Check view (media/checkAnswer.js draws it): the box, its latest grade with
// its code links, a concern, "Next question ›". No vscode API here.
import { definedOnly } from '../core/objects'
import { linkParts } from '../core/linkParts'
import { concernOf } from './concernState'
import { RIGHT, SAY_IT_BACK } from './checkWords'
import { retryText } from './threadText'
import { isPassed } from './types'
import type { Attempt, QState, Question } from './types'
import type { AnswerBox } from './checkViewTypes'

/** What the box is told besides the question. */
export interface AnswerBoxOptions {
  /** Its unsent answer. */
  draft?: string
  /** Its answer is being graded. */
  grading?: boolean
  /** Other questions are still open. */
  others?: boolean
  /** Its concern's suggested fix is in the code, not committed yet. */
  applied?: boolean
  /** Why grading it failed. */
  error?: string
}

/**
 * The answer box of question `q` (number `n`, state `state`): open while it is to be answered (or explained: say it
 * back), its latest grade under it, "Next question ›" once it is done while `others` are open.
 */
export function answerBox(q: Question, n: number, state: QState, o: AnswerBoxOptions = {}): AnswerBox {
  const pass = isPassed(state)
  // While it is graded the box says "Checking…" and nothing of the last round: no grade, no error, no concern.
  const last = o.grading ? undefined : { attempt: latestGraded(q), error: o.error || undefined, concern: concernOf(q) }
  const concern = last?.concern
  return definedOnly({
    id: q.id,
    n,
    open: !pass,
    draft: o.draft ?? '',
    checking: o.grading || undefined,
    grade: last?.attempt && gradeOf(last.attempt, state),
    error: last?.error,
    next: (pass && o.others) || undefined,
    concern: concern && definedOnly({ text: concern.text, flagged: concern.flagged, applied: o.applied || undefined }),
  })
}

/** The latest attempt with a verdict. */
const latestGraded = (q: Question): Attempt | undefined => [...(q.attempts ?? [])].reverse().find((x) => x.verdict)

/** The latest grade under the answer box: the same words as the thread's (gradeBody), with its code links. */
function gradeOf(a: Attempt, state: QState): AnswerBox['grade'] {
  const feedback = a.verdict === 'retry' ? retryText(a.feedback) : a.feedback || (a.verdict === 'pass' ? RIGHT : '')
  return definedOnly({
    pass: a.verdict === 'pass' || a.verdict === 'restated',
    feedback: linkParts(feedback, a.links),
    hint: a.verdict === 'retry' && a.hint ? linkParts(a.hint, a.links) : undefined,
    say: a.verdict === 'explained' && state === 'explained' ? SAY_IT_BACK : undefined,
  })
}
