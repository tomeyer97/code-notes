// The understanding check on a question's thread: the answer shown as typed, the code links of the question and its
// grades, "Next question ›", and the rows of the grading (checking, a concern, a journey through the code, a failure).
import { isDone } from '../../check/types'
import type { ThreadStatus } from '../../check/controller'
import { Cmd, HiddenCmd } from '../../platform/commands'
import { isAgent } from '../../notes/identity'
import type { Note } from '../../notes/store'
import type { TourApi } from '../../tour/api'
import { THREAD_WORD, type ThreadWord } from '../context'
import type { Links } from '../links'
import type { ThreadsCheck } from '../ports'
import { systemRow, type ThreadContribution, type ThreadRow } from '../rows'

type Concern = NonNullable<ThreadStatus['concern']>

/** A concern the grader found, and what was done about it. Its actions (Suggest a fix, Add TODO, Flag for reviewer,
 *  Mark fixed, Dismiss) are the thread's menu: links here were read aloud as their command URIs. */
function concernRow(c: Concern): ThreadRow {
  const done = [
    c.todo ? `TODO added at ${c.todo}` : '',
    c.flagged ? (c.by ? `Flagged by ${c.by} ✓` : 'Flagged ✓') : '',
  ].filter(Boolean).join(' · ')
  return { comment: systemRow(`⚠ ${c.text}${done ? `\n\n${done}` : ''}`, c.suspect ? 'Understanding check' : 'Found while grading') }
}

/** The words the concern's menu items look for. */
export function concernWords(c: Concern | undefined): ThreadWord[] {
  if (!c) return []
  return [THREAD_WORD.concern, ...(c.todo ? [THREAD_WORD.todo] : []), ...(c.flagged ? [THREAD_WORD.flagged] : [])]
}

/** An open question whose code a journey of the repository walks: one link to that step. */
function seeAlsoRow(n: Note, chk: ThreadsCheck, tour: Pick<TourApi, 'seeAlsoLink'>): ThreadRow[] {
  const q = chk.isCheck(n) ? chk.questionOf(n) : undefined
  if (!q || isDone(chk.rowOf(n)?.state ?? '')) return []
  const files = [q.file, ...(q.also ?? []).map((x) => x.file)]
  const also = tour.seeAlsoLink(files, q.start ? { start: n.data.range.start, end: n.data.range.end } : undefined)
  return also ? [{ comment: systemRow(also, 'See also') }] : []
}

function statusRows(n: Note, chk: ThreadsCheck, tour: Pick<TourApi, 'seeAlsoLink'>): ThreadRow[] {
  const id = n.data.id
  const s = chk.threadStatus(n)
  return [
    ...(s?.checking ? [{ comment: systemRow('_Checking your answer…_', 'Understanding check', 'checking…') }] : []),
    ...(s?.concern ? [concernRow(s.concern)] : []),
    ...seeAlsoRow(n, chk, tour),
    ...(s?.error ? [{ comment: systemRow((l) => `⚠ ${s.error} ${l.to('Try again', Cmd.gradeCheck, id)}`, 'Code Notes') }] : []),
  ]
}

/** `check`: the check, once it is started. */
export function checkRows(check: () => ThreadsCheck | undefined, tour: () => Pick<TourApi, 'seeAlsoLink'>): ThreadContribution {
  return {
    facts: (n) => {
      const chk = check()
      if (!chk) return undefined
      const s = chk.threadStatus(n)
      const isCheck = chk.isCheck(n)
      const words = [...(isCheck ? [THREAD_WORD.check] : []), ...concernWords(s?.concern)]
      return { pinned: chk.pinned(n), working: !!s?.checking, failed: !!s?.error, words, neverResolved: isCheck }
    },
    message: (n, index) => {
      const chk = check()
      if (!chk) return undefined
      const m = n.data.messages[index]
      // A check question done while others are open: "Next question ›" under its last grade.
      const next = !!chk.threadStatus(n)?.next && index === n.data.messages.map((x) => isAgent(x)).lastIndexOf(true)
      return {
        // An answer typed in a check thread, shown as typed (a "---" or "# …" in it).
        verbatim: chk.isCheck(n) && !!m && !isAgent(m),
        codeLinks: chk.linksIn(n, index),
        after: next ? (l) => l.to('Next question ›', HiddenCmd.nextCheckQuestion) : undefined,
      }
    },
    rows: (n) => {
      const chk = check()
      return chk ? statusRows(n, chk, tour()) : []
    },
  }
}
