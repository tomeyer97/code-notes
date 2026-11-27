// The understanding check on a question's thread: the answer shown as typed, the code links of the question and its
// grades, "Next question ›", and the rows of the grading (checking, a concern, a journey through the code, a failure).
import { isDone } from '../../check/types'
import type { ThreadStatus } from '../../check/controller'
import { Cmd, HiddenCmd } from '../../platform/commands'
import { isAgent } from '../../notes/identity'
import type { Note } from '../../notes/store'
import type { TourApi } from '../../tour/api'
import { THREAD_WORD } from '../context'
import type { Links } from '../links'
import type { ThreadsCheck } from '../ports'
import { systemRow, type ThreadContribution, type ThreadRow } from '../rows'

type Concern = NonNullable<ThreadStatus['concern']>

/** A concern the grader found: Suggest a fix, Add TODO, Flag for reviewer; quiet: Mark fixed once it is flagged (it
 *  leaves the merge request), Dismiss with a reason when it is wrong. */
function concernRow(id: string, c: Concern): ThreadRow {
  const text = (l: Links) => {
    const act = (label: string, action: string) => l.to(label, Cmd.checkConcern, id, action)
    const acts = [
      act('Suggest a fix', 'fix'),
      c.todo ? `TODO added at ${c.todo}` : act('Add TODO', 'todo'),
      act(c.flagged ? (c.by ? `Flagged by ${c.by} ✓` : 'Flagged ✓') : 'Flag for reviewer', 'flag'),
      ...(c.flagged ? [act('Mark fixed', 'fixed')] : []),
      act('Dismiss', 'dismiss'),
    ]
    return `⚠ ${c.text}\n\n${acts.join(' · ')}`
  }
  return { comment: systemRow(text, c.suspect ? 'Understanding check' : 'Found while grading') }
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
    ...(s?.concern ? [concernRow(id, s.concern)] : []),
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
      return { pinned: chk.pinned(n), working: !!s?.checking, failed: !!s?.error, words: isCheck ? [THREAD_WORD.check] : [], neverResolved: isCheck }
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
