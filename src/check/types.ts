// The understanding check's shapes, as the CLI defines them (cli/understanding/types.ts): the check file (Check,
// Question, Attempt), where a branch stands (BranchStatus, its CheckPosition, its Words), and the question states'
// rules (isDone, isPassed). One definition for both sides: the extension compiles the CLI's modules it uses.
import { isDone } from '../../cli/understanding/state'
import type { BranchStatus, QState, Who } from '../../cli/understanding/types'

export type {
  Attempt, BranchStatus, Check, CheckPosition, CheckTour, CodeStat, Concern, Config, Kind, Link, ParsedVerdict, Phase,
  PushResult, QState, Question, QuestionAnchor, Range, Summary, Verdict, Who, Words,
} from '../../cli/understanding/types'
export { isDone, isPassed } from '../../cli/understanding/state'

/** A question that still asks for an answer: todo, ungraded or retry (not done). */
export const notDone = (s: QState): boolean => !isDone(s)

/** What a refresh read on the worker thread (cliWorker.ts refreshState); `same`: nothing changed since the key given. */
export interface RefreshResult {
  key?: string
  same?: boolean
  st?: BranchStatus
  error?: string
  ident?: Who
}
