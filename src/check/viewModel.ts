// The Check view's model (what media/check.js and media/checkAnswer.js draw): where the check stands in the CLI's words,
// the questions as rows, one button, the selected question's answer box, the tour; and the status bar item's text.
// Its parts: the shapes (checkViewTypes.ts), the words (checkWords.ts), the button per phase (actions.ts), the answer
// box (answerBox.ts). No vscode API here (unit-tested in test/checkModel.test.ts and test/checkViewModel.test.ts).
import { clock } from '../core/writing'
import { baseName } from '../core/paths'
import { definedOnly } from '../core/objects'
import { concernOf, samePerson } from './concernState'
import { notDone } from './types'
import type { BranchStatus, Phase, QState, Question, Range, Words } from './types'
import { viewAction } from './actions'
import { answerBox } from './answerBox'
import type { CheckRow, CheckView, CheckViewOptions, AnswerBox } from './checkViewTypes'
import type { CommitPlan } from './commitPlan'
import { busyWords, COMMITS, FLAG_WORD, GRADING_WORD, KIND_LABEL, STATE_WORD, STATUS_ICON, TOUR, whoseCheck } from './checkWords'

// What the rest of the extension imports from here.
export type { AnswerBox, CheckRow, CheckView, CheckViewOptions, Part } from './checkViewTypes'
export type { CommitPlan } from './commitPlan'
export { ACTIONS, type ActionId, KIND_LABEL, STATE_WORD } from './checkWords'
export { runAction, type RunStep } from './actions'
export { answerBox } from './answerBox'
export { linkParts } from '../core/linkParts'
export { definedOnly } from '../core/objects'

/** "Writing questions · 0:42": what is being done, and for how long. */
export const busyLabel = (what: string, started: number, now = Date.now()): string => busyWords(what, clock(now - started))

/**
 * The Check view: where the check stands (the CLI's words), the questions, one button. `unpushed`: the branch has
 * commits its remote doesn't (undefined: no upstream). `pushed`: what Commit & push said last.
 */
export function checkView(st: BranchStatus, w: Words, o: CheckViewOptions = {}): CheckView {
  const p = st.state.phase
  const rows = rowsOf(st, o)
  const { action, line } = viewAction(st, w.line, o)
  const commit = action?.id === 'commitPush' && o.commit ? commitOf(st, o.commit) : {}
  // While questions are written, or a write failed (its Retry is the way on), there is no button.
  const offered = action && !o.busy && !o.failed
  return definedOnly({
    branch: st.branch, file: st.file, tone: w.tone, title: w.title, line, rows,
    ...(offered ? { action, ...commit } : {}),
    busy: o.busy || undefined,
    notice: o.notice || undefined,
    tour: tourOf(st, o),
    who: whoOf(st, o),
    answer: answerOf(st, rows, o),
    mr: o.mr && p === 'done' && !o.busy ? o.mr : undefined,
    failed: o.failed && !o.busy ? o.failed : undefined,
    said: o.said && st.check ? o.said : undefined,
  })
}

/** Someone else's check (its answers so far are theirs): whose, in one line. */
function whoOf(st: BranchStatus, o: CheckViewOptions): string | undefined {
  const by = st.check?.answeredBy
  return by && o.me && !samePerson(by, o.me) ? whoseCheck(by.name ?? by.email) : undefined
}

const range = (r: Range) => `${r.file}:${r.start}${r.end > r.start ? `-${r.end}` : ''}`
const where = (q: Question) => (q.target === 'file' || !q.start ? q.file : `${q.file}:${q.start}`)

/** The questions as rows: number, kind, where, state (and its word), a concern's flag, the tour step. */
function rowsOf(st: BranchStatus, o: CheckViewOptions): CheckRow[] {
  return (st.check?.questions ?? []).map((q, i) => {
    const grading = o.grading?.has(q.id)
    const state: QState = grading ? 'ungraded' : st.summary?.states[i] ?? 'todo'
    return definedOnly({
      id: q.id,
      n: i + 1,
      kind: KIND_LABEL[q.kind] ?? q.kind,
      text: q.text,
      where: where(q),
      also: (q.also ?? []).map(range),
      state,
      word: grading ? GRADING_WORD : STATE_WORD[state],
      flag: flagWord(q, !!o.commit?.applied?.includes(q.id)),
      step: q.step && st.check?.journey ? q.step : undefined,
    })
  })
}

/** A row's flag: an applied fix beats "may be a bug", which beats "flagged for review"; nothing without a concern. */
function flagWord(q: Question, applied: boolean): string | undefined {
  const c = concernOf(q)
  if (!c) return undefined
  if (applied) return FLAG_WORD.applied
  if (c.suspect) return FLAG_WORD.suspect
  if (c.flagged) return FLAG_WORD.flagged
  return FLAG_WORD.concern
}

/**
 * What Commit & push names: the files it commits; a TODO added from the check is the person's choice (ticked), an
 * applied fix goes unless unticked.
 */
function commitOf(st: BranchStatus, c: CommitPlan): Pick<CheckView, 'commits' | 'also'> {
  const files = [...(st.dirty ? [st.file] : []), ...c.files.filter((f) => f !== st.file)]
  const fixes = c.fixes ?? []
  const also = [
    ...fixes.map((f) => ({ file: f, label: COMMITS.yourFix(baseName(f)), on: !c.exclude?.has(f) })),
    ...c.todos.filter((f) => !fixes.includes(f)).map((f) => ({ file: f, label: COMMITS.todoAdded(baseName(f)), on: c.include.has(f) })),
  ]
  // The first check commit of a repository also folds check files in diffs: said on the same line.
  const fold = !!c.fold && st.dirty
  const tour = c.tourOnly && st.dirty ? COMMITS.tourOnly : ''
  const folds = fold ? `, ${c.foldText ?? COMMITS.fold}` : ''
  return definedOnly({
    commits: files.length ? COMMITS.files(files.map(baseName), `${tour}${folds}`) : undefined,
    also: also.length ? also : undefined,
  })
}

/** The selected question's answer box. */
function answerOf(st: BranchStatus, rows: CheckRow[], o: CheckViewOptions): AnswerBox | undefined {
  const qs = st.check?.questions ?? []
  const si = o.selected ? qs.findIndex((x) => x.id === o.selected) : -1
  if (si < 0) return undefined
  const q = qs[si]
  return answerBox(q, si + 1, st.summary?.states[si] ?? 'todo', {
    draft: o.draft,
    grading: !!o.grading?.has(q.id),
    others: rows.some((r, k) => k !== si && notDone(r.state)),
    applied: !!o.commit?.applied?.includes(q.id),
    error: o.error,
  })
}

/** The phases in which a check without a tour offers to write one: its questions are there. */
const TOUR_TO_WRITE: ReadonlySet<Phase> = new Set(['answering', 'short', 'done'])

/** The tour: walk it; an older check (or a run that failed) offers to write one. Nothing while one is being written. */
function tourOf(st: BranchStatus, o: CheckViewOptions): CheckView['tour'] {
  const steps = st.check?.journey?.steps?.length ?? 0
  // Documentation that describes no code: no tour, on purpose; nothing offers one.
  const noTourOnPurpose = !!st.check?.noTour && !steps
  if (!st.check || o.busy || noTourOnPurpose) return undefined
  if (o.tourBusy) return { label: o.tourBusy }
  if (steps) return { label: TOUR.walk(steps), action: 'walk' }
  if (!TOUR_TO_WRITE.has(st.state.phase)) return undefined
  return { label: o.tourFailed ? TOUR.failed : TOUR.write, action: 'write' }
}

/**
 * The CLI's status bar words carry a ✓ of their own (cli/understanding phases); the item shows a codicon instead
 * (STATUS_ICON), so the mark is dropped here, the one place the CLI's decoration is undone.
 */
const CLI_MARK = /^✓\s*/

/** The status bar, from the CLI's words: hidden when no check is needed; an icon by tone; amber for a top-up. */
export function statusText(st: BranchStatus | undefined, w: Words | undefined): { text: string; tip: string; warn: boolean } | undefined {
  if (!st || !w || !w.bar) return undefined
  const p = st.state.phase
  const icon = p === 'done' ? STATUS_ICON.done : w.tone === 'warn' ? STATUS_ICON.warn : STATUS_ICON.todo
  return { text: `${icon} ${w.bar.replace(CLI_MARK, '')}`, tip: [w.title, w.line].filter(Boolean).join(' · '), warn: p === 'drift' }
}
