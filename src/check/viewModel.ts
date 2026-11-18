// The Check view's model (what media/check.js and media/checkAnswer.js draw): where the check stands in the CLI's words,
// the questions as rows, one button, the selected question's answer box, the tour; and the status bar item's text.
// No vscode API here (unit-tested in test/checkModel.test.ts).
import { clock } from '../writing'
import { concernOf, samePerson } from './concernState'
import { SAY_IT_BACK, retryText } from './threadText'
import { notDone } from './types'
import type { Attempt, Kind, QState, Question, Range, Status, Who, Words } from './types'
import { baseName } from '../paths'

export const KIND_LABEL: Record<Kind, string> = { how: 'How', why: 'Why', failure: 'Failure', edge: 'Edge case', change: 'Change' }


const range = (r: Range) => `${r.file}:${r.start}${r.end > r.start ? `-${r.end}` : ''}`

/** The words of a row's state (the icon says the rest). */
export const STATE_WORD: Record<QState, string> = { todo: '', ungraded: 'not graded', pass: '', retry: 'try again', explained: 'explained · say it back', restated: 'in your words' }

export interface CheckRow { id: string; n: number; kind: string; text: string; where: string; also: string[]; state: QState; word: string; flag?: string; step?: number }
export interface CheckView {
  branch: string; file: string
  tone: Words['tone']; title: string; line: string
  rows: CheckRow[]
  /** The one button, when there is one. */
  action?: { id: ActionId; label: string }
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
  /** The answer box: only for the selected question (checkAnswer.ts / media/checkAnswer.js). */
  answer?: AnswerBox
  /** Writing the questions failed: why, in plain words, with Retry (and the model setting when it was the model; install
   *  and the path setting when Claude Code wasn't found). */
  failed?: { text: string; setting?: boolean; path?: boolean }
  /** One line saying what was just done (a merge kept both answers). */
  said?: string
  /** The tour of the change: walk it ("Walk the tour · 9 steps"), or write one (an older check, a failed run). */
  tour?: { label: string; action?: 'walk' | 'write' }
}

/** Words of a grade, with the code-link phrases marked (`link`: its index in the grade's links). */
export interface Part { text: string; link?: number }
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

/** A text split at the code links' phrases (each phrase once, the first time it appears). */
export function linkParts(text: string, links: { phrase: string }[] = []): Part[] {
  const hits = links.map((l, i) => ({ i, at: l.phrase ? text.indexOf(l.phrase) : -1, len: l.phrase.length })).filter((h) => h.at >= 0).sort((a, b) => a.at - b.at)
  const out: Part[] = []
  let pos = 0
  for (const h of hits) {
    if (h.at < pos) continue
    if (h.at > pos) out.push({ text: text.slice(pos, h.at) })
    out.push({ text: text.slice(h.at, h.at + h.len), link: h.i })
    pos = h.at + h.len
  }
  if (pos < text.length) out.push({ text: text.slice(pos) })
  return out
}

/** `o` without its undefined fields (instead of `...(x ? { x } : {})` chains; the view is compared as JSON and in tests). */
export function definedOnly<T extends object>(o: T): T {
  for (const k of Object.keys(o) as (keyof T)[]) if (o[k] === undefined) delete o[k]
  return o
}

/** "Writing questions · 0:42": what is being done, and for how long. */
export const busyLabel = (what: string, started: number, now = Date.now()): string => `${what} · ${clock(now - started)}`

/**
 * The answer box of question `q` (number `n`, state `state`): open while it is to be answered (or explained: say it
 * back), its latest grade under it, "Next question ›" once it is done while `others` are open.
 */
export function answerBox(q: Question, n: number, state: QState, o: { draft?: string; grading?: boolean; others?: boolean; applied?: boolean; error?: string } = {}): AnswerBox {
  const a = [...(q.attempts ?? [])].reverse().find((x) => x.verdict)
  const pass = state === 'pass' || state === 'restated'
  const grade = a && !o.grading ? gradeOf(a, state) : undefined
  const concern = o.grading ? undefined : concernOf(q)
  return definedOnly({
    id: q.id,
    n,
    open: !pass,
    draft: o.draft ?? '',
    checking: o.grading ? true : undefined,
    grade,
    error: o.error && !o.grading ? o.error : undefined,
    next: pass && o.others ? true : undefined,
    concern: concern ? definedOnly({ text: concern.text, flagged: concern.flagged, applied: o.applied ? true : undefined }) : undefined,
  })
}
/** The latest grade under the answer box: the same words as the thread's (gradeBody), with its code links. */
function gradeOf(a: Attempt, state: QState): AnswerBox['grade'] {
  const feedback = a.verdict === 'retry' ? retryText(a.feedback) : a.feedback || (a.verdict === 'pass' ? 'Right.' : '')
  return definedOnly({
    pass: a.verdict === 'pass' || a.verdict === 'restated',
    feedback: linkParts(feedback, a.links),
    hint: a.verdict === 'retry' && a.hint ? linkParts(a.hint, a.links) : undefined,
    say: a.verdict === 'explained' && state === 'explained' ? SAY_IT_BACK : undefined,
  })
}

const where = (q: Question) => (q.target === 'file' || !q.start ? q.file : `${q.file}:${q.start}`)

/** What the view shows besides the CLI's status, by the part that knows it (controller.ts current() gathers them). */
export interface CheckViewOptions {
  // ---- the writer (writer.ts) ----
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
  // ---- grading (grading.ts) ----
  /** Questions being graded, or whose answer is being taken. */
  grading?: Set<string>
  /** Why grading the selected question failed. */
  error?: string
  // ---- Commit & push (push.ts) ----
  /** The branch has commits its remote doesn't, or no upstream (undefined: not known). */
  unpushed?: boolean
  /** What the last Commit & push (or Pull) said. */
  pushed?: string
  /** The push's "create a merge request" link. */
  mr?: string
  /** What Commit & push would commit. */
  commit?: CommitPlan
  // ---- the view itself (controller.ts) ----
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

/**
 * The Check view: where the check stands (the CLI's words), the questions, one button. `unpushed`: the branch has
 * commits its remote doesn't (undefined: no upstream). `pushed`: what Commit & push said last.
 */
export function checkView(st: Status, w: Words, o: CheckViewOptions = {}): CheckView {
  const p = st.state.phase
  const rows = rowsOf(st, o)
  const { action, line } = actionOf(st, w.line, o)
  const commit = action?.id === 'commitPush' && o.commit ? commitOf(st, o.commit) : {}
  const by = st.check?.answeredBy
  return definedOnly({
    branch: st.branch, file: st.file, tone: w.tone, title: w.title, line, rows,
    // A failed write: its Retry is the action.
    ...(action && !o.busy && !o.failed ? { action, ...commit } : {}),
    busy: o.busy || undefined,
    notice: o.notice || undefined,
    tour: tourOf(st, o),
    who: by && o.me && !samePerson(by, o.me) ? `${by.name ?? by.email}'s check: your answers are recorded as yours.` : undefined,
    answer: answerOf(st, rows, o),
    mr: o.mr && p === 'done' && !o.busy ? o.mr : undefined,
    failed: o.failed && !o.busy ? o.failed : undefined,
    said: o.said && st.check ? o.said : undefined,
  })
}

/** The questions as rows: number, kind, where, state (and its word), a concern's flag, the tour step. */
function rowsOf(st: Status, o: CheckViewOptions): CheckRow[] {
  return (st.check?.questions ?? []).map((q, i) => {
    const grading = o.grading?.has(q.id)
    const state: QState = grading ? 'ungraded' : st.summary?.states[i] ?? 'todo'
    const c = concernOf(q)
    const flag = !c ? undefined
      : o.commit?.applied?.includes(q.id) ? 'fix applied · not committed'
      : c.suspect ? 'may be a bug'
      : c.flagged ? 'flagged for review'
      : 'concern'
    return definedOnly({
      id: q.id, n: i + 1, kind: KIND_LABEL[q.kind] ?? q.kind, text: q.text, where: where(q), also: (q.also ?? []).map(range),
      state, word: grading ? 'checking…' : STATE_WORD[state],
      flag,
      step: q.step && st.check?.journey ? q.step : undefined,
    })
  })
}

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
/** A button: its id and label (its usual one unless given). */
const button = (id: ActionId, label: string = ACTIONS[id]): NonNullable<CheckView['action']> => ({ id, label })

/** A check that needs a top-up: Commit… first when only uncommitted lines put it over, else Add questions. */
const driftAction = (st: Status): 'scm' | 'topUp' => (st.state.commitFirst ? 'scm' : 'topUp')
/** Done, and something is left to send: the check file changed (`dirty`), an applied fix, or a push (or no upstream). */
const leftToSend = (dirty: boolean | undefined, fixes: string[] | undefined, unpushed: boolean | undefined): boolean => {
  return !!(dirty || fixes?.length || unpushed !== false)
}

/**
 * The view's one button and the line above it (`line`: the CLI's words, replaced where the button needs its own).
 * Check my understanding (the command) decides with runAction, next to this.
 */
function actionOf(st: Status, line: string, o: CheckViewOptions): { action?: CheckView['action']; line: string } {
  const p = st.state.phase
  // Nothing of the change committed yet: said before any Claude call; Commit… (the check starts once it is in).
  if (p === 'none' && o.uncommitted) {
    const commitFirst = "Your change isn't committed yet: the questions are about committed code. Commit it and the check starts."
    return { action: button('scm'), line: commitFirst }
  }
  if (p === 'none') return { action: button('start'), line }
  // A file that can't be read: open it (at the first conflict); a conflict whose sides both read: keep both answers.
  if (p === 'invalid') {
    const action = button(st.state.conflict?.mergeable ? 'merge' : 'openFile')
    // Where the file stops being JSON ("Line 3: expected double-quoted property name."): Open goes there.
    return { action, line: o.invalidAt && !st.state.conflict ? o.invalidAt : line }
  }
  if (p === 'drift') return { action: button(driftAction(st)), line }
  if (p === 'done') return doneAction(st, line, o)
  return { line }
}
/** Done: whatever is left to commit or push, the button is there (the check file, an applied fix, the push itself). */
function doneAction(st: Status, line: string, o: CheckViewOptions): { action?: CheckView['action']; line: string } {
  let action: CheckView['action']
  const fixes = o.commit?.fixes ?? []
  if (leftToSend(st.dirty, fixes, o.unpushed)) {
    action = button('commitPush', st.dirty || fixes.length || o.commit?.todos.length ? ACTIONS.commitPush : 'Push')
    if (!st.dirty) line = fixes.length ? 'Your fix is not committed yet.' : 'Not pushed yet.'
    // Only the tour is new (the answers are committed): no need for a push of its own.
    else if (o.commit?.tourOnly) line = 'Only the tour is new: it can go with your next push.'
  } else line = 'Pushed.'
  if (o.pushed && o.pushed !== 'Pushed.') line = o.pushed
  // Rejected: origin has newer commits. Pull is the way on (a conflict in the check file is then offered to merge).
  if (o.pushed && /rejected/.test(o.pushed)) action = button('pull')
  return { action, line }
}

/**
 * What Check my understanding (the command, the status bar item) does: the view's button (actionOf, above; the same
 * driftAction and leftToSend), except that a file that can't be read is opened (the view may offer Keep both answers),
 * no check yet starts writing (the view says Commit… first when nothing is committed), and done, a change of the tour
 * alone is no reason to commit. Where the view has no button the command still shows something: the view (nothing to
 * check, a stash), else the tour or the next question (`walk`).
 */
export type RunStep = Exclude<ActionId, 'merge' | 'pull'> | 'show' | 'walk'
export function runAction(st: Status, o: { commit?: Pick<CommitPlan, 'fixes' | 'tourOnly'>; unpushed?: boolean }): RunStep {
  const p = st.state.phase
  if (p === 'invalid') return 'openFile'
  if (p === 'nothing' || p === 'stashed') return 'show'
  if (p === 'none') return 'start'
  if (p === 'drift') return driftAction(st)
  // Only the tour is new: no commit and pipeline of its own (it goes with the next push).
  const dirty = st.dirty && !o.commit?.tourOnly
  if (p === 'done' && leftToSend(dirty, o.commit?.fixes, o.unpushed)) return 'commitPush'
  return 'walk'
}

/**
 * What Commit & push names: the files it commits; a TODO added from the check is the person's choice (ticked), an
 * applied fix goes unless unticked.
 */
function commitOf(st: Status, c: CommitPlan): Pick<CheckView, 'commits' | 'also'> {
  const files = [...(st.dirty ? [st.file] : []), ...c.files.filter((f) => f !== st.file)]
  const fixes = c.fixes ?? []
  const also = [
    ...fixes.map((f) => ({ file: f, label: `${baseName(f)} (your fix)`, on: !c.exclude?.has(f) })),
    ...c.todos.filter((f) => !fixes.includes(f)).map((f) => ({ file: f, label: `also ${baseName(f)} (TODO added)`, on: c.include.has(f) })),
  ]
  // The first check commit of a repository also folds check files in diffs: said on the same line.
  const fold = !!c.fold && st.dirty
  const tour = c.tourOnly && st.dirty ? ' (the tour)' : ''
  const folds = fold ? `, ${c.foldText ?? 'also folds check files in diffs (.gitattributes)'}` : ''
  return definedOnly({
    commits: files.length ? `Commits ${files.map(baseName).join(', ')}${tour}${folds}` : undefined,
    also: also.length ? also : undefined,
  })
}

/** The selected question's answer box. */
function answerOf(st: Status, rows: CheckRow[], o: CheckViewOptions): AnswerBox | undefined {
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

/** The tour: walk it; an older check (or a run that failed) offers to write one. Nothing while one is being written. */
function tourOf(st: Status, o: CheckViewOptions): CheckView['tour'] {
  const p = st.state.phase
  const steps = st.check?.journey?.steps?.length ?? 0
  // Documentation that describes no code: no tour, on purpose; nothing offers one.
  if (!st.check || o.busy || (st.check.noTour && !steps)) return undefined
  if (o.tourBusy) return { label: o.tourBusy }
  if (steps) return { label: `Walk the tour · ${steps} steps`, action: 'walk' }
  if (p === 'answering' || p === 'short' || p === 'done') return { label: o.tourFailed ? "Couldn't write the tour · Try again" : 'Write a tour', action: 'write' }
  return undefined
}

/**
 * What Commit & push would commit: the check file and setup files (`files`), files a TODO went to (`todos`, ticked
 * into `include`), files an applied fix changed (`fixes`, going unless in `exclude`; `applied`: the questions whose fix
 * they hold), whether the check file's only change is its tour, and whether the repository's first check commit also
 * adds the .gitattributes line that folds check files in diffs (`fold`, said as `foldText`).
 */
export interface CommitPlan { files: string[]; todos: string[]; include: Set<string>; fixes?: string[]; exclude?: Set<string>; applied?: string[]; tourOnly?: boolean; fold?: boolean; foldText?: string }

/** The status bar, from the CLI's words: hidden when no check is needed; an icon by tone; amber for a top-up. */
export function statusText(st: Status | undefined, w: Words | undefined): { text: string; tip: string; warn: boolean } | undefined {
  if (!st || !w || !w.bar) return undefined
  const p = st.state.phase
  const icon = p === 'done' ? '$(pass)' : w.tone === 'warn' ? '$(warning)' : '$(checklist)'
  return { text: `${icon} ${w.bar.replace(/^✓\s*/, '')}`, tip: [w.title, w.line].filter(Boolean).join(' · '), warn: p === 'drift' }
}
