// Understanding check in the editor: the prompt that writes the questions, the plain phase shown while it works, the
// grader's reply as a thread message, the Check view's model, the status bar. No vscode API here (unit-tested in
// test/checkModel.test.ts). The rules (file format, grading prompt, the pass rule and the one state every surface
// shows: checkState / stateWords) live in cli/understanding.mjs; its shapes are typed here.
import * as path from 'path'
import { READ_ONLY_TOOLS } from './claude'
import type { AskErrorKind, ToolCall } from './claude'
import { clock } from './writing'

export type Kind = 'how' | 'why' | 'failure' | 'edge' | 'change'
export type Verdict = 'pass' | 'retry' | 'explained' | 'restated'
export type QState = 'todo' | 'ungraded' | 'pass' | 'retry' | 'explained' | 'restated'
export interface Who {
  name?: string
  email?: string
}
export interface Attempt {
  /** Missing on an answer that a later one superseded (not kept in the file). */
  answer?: string
  at?: string
  by?: Who
  verdict?: Verdict
  feedback?: string
  hint?: string
  /** Set when graded: CI notices an answer or verdict changed after grading (a bad merge). */
  hash?: string
  gradedAt?: string
  note?: string
  topic?: string
  concern?: string
  flagged?: boolean
  links?: Link[]
}
export interface Range { file: string; start: number; end: number }
/** A code link: words of a text that light these lines when clicked (the same as a journey step's links). */
export interface Link extends Range { phrase: string; text?: string }
export interface Question {
  id: string
  kind: Kind
  text: string
  file: string
  start?: number
  end?: number
  target?: 'file'
  anchor?: { v: 3; head: string; tail: string; lines: number; hash: string; before: string; after: string }
  attempts?: Attempt[]
  round?: number
  /** Unchanged code the question also depends on. */
  also?: Range[]
  /** The question's own "may be a bug" (see concernOf). */
  suspect?: boolean
  links?: Link[]
  /** The step of the check's tour after which its answer is visible. */
  step?: number
  /** A concern about the code found while grading; `flagged`: the author put it on the merge request. */
  concern?: {
    text: string
    flagged?: boolean
    at?: string
    by?: Who
    dismissed?: { reason: string; by?: Who; at?: string }
    fixed?: { by?: Who; at?: string }
  }
}
/** The check's tour: a journey of the change (the journey file format), its steps walked in the journey panel. */
export interface Tour {
  title: string
  steps: { id?: string; title: string; file: string; range: { start: number; end: number } }[]
  [k: string]: unknown
}
export interface Check {
  version: 1
  branch: string
  base?: string
  head: string
  answeredBy?: Who
  diffStat?: { files: number; added: number; removed: number }
  model?: string
  createdAt?: string
  questions: Question[]
  journey?: Tour
  /** Documentation that describes no code: no tour, on purpose. */
  noTour?: true
}
export interface Summary {
  total: number
  passed: number
  done: number
  explained: number
  restated: number
  retry: number
  todo: number
  ungraded: number
  open: number
  needed: number
  met: boolean
  states: QState[]
}
export type Phase = 'stashed' | 'nothing' | 'none' | 'invalid' | 'drift' | 'answering' | 'short' | 'done'
export interface State {
  phase: Phase
  stash?: string
  conflict?: { line: number; mergeable: boolean }
  passed?: number
  done?: number
  total?: number
  needed?: number
  maxDrift?: number
  grew?: number
  /** Drift: only uncommitted lines put it over (commit, then top up). */
  commitFirst?: boolean
  changed?: number
  exemptOnly?: boolean
  why?: string
}
export interface Words {
  tone: 'ok' | 'warn' | 'todo'
  /** The status bar's text. */
  bar: string
  title: string
  line: string
  rule: string
}
export interface Status {
  branch: string
  file: string
  base?: string
  baseRef?: string
  head?: string
  changed: number
  exists: boolean
  errors?: string[]
  conflict?: { line: number; mergeable: boolean }
  check?: Check
  summary?: Summary
  drift?: { lines: number; approx: boolean }
  pending?: { lines: number; approx: boolean }
  dirty?: boolean
  untracked?: boolean
  state: State
  next: string
}
export interface Config {
  questions: { min: number; max: number }
  passRatio: number
  maxDrift: number
  model: string | null
  exempt?: string[]
}
export interface PushResult {
  ok: boolean
  committed: boolean
  pushed: boolean
  line: string
  /** The host's "create a merge request" link from the push's output. */
  mr?: string
}
/** What a refresh read on the worker thread (cliWorker.ts refreshState); `same`: nothing changed since the key given. */
export interface RefreshResult {
  key?: string
  same?: boolean
  st?: Status
  error?: string
  ident?: Who
}

/**
 * The functions of cli/understanding.mjs the extension uses (it is loaded with import() at run time, untyped). Kept in
 * step with the file by test/checkModel.test.ts ("every function of Cli is in the CLI").
 */
export interface Cli {
  localStatus(repo: string, o?: { base?: string }): Status
  stateWords(state: State, st?: Partial<Status>): Words
  loadConfig(repo: string): Config
  readCheck(file: string): Check
  writeCheck(file: string, c: Check): void
  validateCheck(c: unknown, o?: { repo?: string }): string[]
  relocate(repo: string, c: Check): number
  stateOf(q: Question): QState
  summarize(c: Check, cfg: Config): Summary
  addAttempt(c: Check, q: Question, answer: string, who?: Who): Attempt
  gitIdentity(repo: string): Who | undefined
  attemptHash(q: Question, a: Attempt): string
  gradeMode(q: Question): { attempt: number; explanation?: string }
  graderPrompt(o: { q: Question; answer: string; attempt: number; explanation?: string; diff: string; code: string; canRead: boolean; tour?: string; others?: string[] }): string
  /** The texts of the check's other questions not done yet. */
  openOthers(check: Check, q: Question): string[]
  /** The tour as numbered lines (the grader's context): "3. The API refuses a used code (api/discounts.ts:40-52)". */
  tourText(c: Check): string
  parseVerdict(text: string, attempt: number, o?: { restate?: boolean }): { verdict: Verdict; feedback: string; hint: string; note?: string; topic?: string; concern?: string; links?: Link[] }
  diffText(repo: string, from: string, to?: string): string
  diffForGrader(diff: string, file: string): string
  codeWindow(repo: string, q: Question): string
  stamp(c: Check, cfg: Config): Check
  fileFor(branch: string): string
  slugOf(branch: string): string
  /** Where a branch's check waits while another branch is checked out. */
  cachedFor(branch: string): string
  commitAndPush(repo: string, files: string[], message: string): Promise<PushResult>
  /** Changed code lines between two commits (`to` undefined: the working tree). */
  codeStat(repo: string, from: string, to?: string, exempt?: string[]): { added: number; removed: number }
  linesOf(s: { added: number; removed: number }): number
  /** The code a question's concern is about (a link of the grade that raised it), if it named some. */
  concernLink(q: Question): Link | undefined
  /** The check file, Code Notes' notes and the setup files: never part of the change, never "uncommitted work". */
  own(file: string): boolean
  /** The repository's .gitattributes lacks the line that folds check files in diffs (the first check commit adds it). */
  foldMissing(repo: string): boolean
  /** Writes that .gitattributes line; returns what it added. */
  foldDiffs(repo: string): string[]
  /** "also folds check files in diffs (.gitattributes)" */
  FOLD_TEXT: string
  /** Conflict markers in a check file: the first one's line, and both sides merged when they read. */
  conflictOf(text: string): { line: number; merged?: Check } | undefined
  /** Both sides of a text with conflict markers: [ours, theirs]. */
  conflictSides(text: string): [string, string]
  codeLinksIn(repo: string, links: Link[]): Link[]
}

/** The prompt for `claude -p` that writes (or tops up) the questions with the understanding-check skill. */
export function checkPrompt(o: { skill: string; branch: string; baseRef: string; base: string; topUp: boolean; bundled: boolean; head?: string }): string {
  const how = o.bundled
    ? `Read ${o.skill}/SKILL.md and follow it exactly (it is the understanding-check skill; it is not installed, so do not look for it with the Skill tool)`
    : 'Use the understanding-check skill'
  // The branch and commit are pinned: the person may switch branches while this runs.
  const pin = o.head ? ` --branch ${o.branch} --head ${o.head}` : ''
  const start = `${o.skill}/scripts/questions.mjs start ${o.topUp ? '--top-up' : `--base ${o.base}`}${pin}`
  return [
    `${how} to ${o.topUp ? 'add 1-2 questions about what changed since the understanding check of' : 'write the questions of an understanding check for'} this branch (${o.branch}, compared with ${o.baseRef}).`,
    `Start with: ${start}`,
    `Run the script by its full path (${o.skill}/scripts/…), one command per call: no shell variables, no && or pipes. Do not modify any other file.`,
    'When done, reply with one line per question you wrote.',
  ].join('\n\n')
}

/**
 * The prompt that writes the check's tour (a journey of the change, embedded in the check file), right after the
 * questions: `resumed` when it goes on in the session that wrote them (the change is read already).
 */
export function tourPrompt(o: { skill: string; journeySkill: string; topUp: boolean; bundled: boolean; resumed: boolean }): string {
  const how = o.bundled || !o.resumed ? `Follow the section "The tour" of ${o.skill}/SKILL.md` : 'Follow the section "The tour" of the understanding-check skill'
  return [
    `${o.resumed ? 'Now write' : 'Write'} the tour of this change, so the author can click their way to each answer. ${how}.`,
    `Start with: ${o.skill}/scripts/questions.mjs tour${o.topUp ? ' --top-up' : ''}`,
    `Run the scripts by their full path (${o.skill}/scripts/… and ${o.journeySkill}/scripts/journey.py), one command per call: no shell variables, no && or pipes (a heredoc for journey.py's text is fine). Do not modify any other file.`,
    'When done, reply with the step titles, one per line.',
  ].join('\n\n')
}

/** The phase a `questions.mjs <command>` call starts (other commands: the phase goes on). */
const PHASE_OF: Record<string, string> = {
  start: 'reading the change',
  add: 'writing questions',
  remove: 'writing questions',
  finish: 'checking',
  'tour-finish': 'checking',
  tour: 'writing the tour',
}

/** What Claude is doing while it writes the questions (or the tour), in plain words, from its last tool call. */
export function checkPhase(tool: ToolCall | undefined, prev: string): string {
  if (!tool) return prev
  if (tool.name !== 'Bash') {
    // A look at the code while writing is part of the writing.
    const writing = prev === 'writing questions' || prev === 'writing the tour'
    return READ_ONLY_TOOLS.includes(tool.name) && !writing ? 'reading the code' : prev
  }
  const cmd = String(tool.input?.command ?? '')
  if (/journey\.py/.test(cmd)) return 'writing the tour'
  const m = /questions\.mjs\s+([a-z-]+)/.exec(cmd)
  return m && Object.hasOwn(PHASE_OF, m[1]) ? PHASE_OF[m[1]] : prev
}

export const KIND_LABEL: Record<Kind, string> = { how: 'How', why: 'Why', failure: 'Failure', edge: 'Edge case', change: 'Change' }

const range = (r: Range) => `${r.file}:${r.start}${r.end > r.start ? `-${r.end}` : ''}`

/** The question as the first message of its thread; unchanged code it depends on (not linked from its words) below it. */
export function questionBody(q: Question): string {
  const also = alsoLinks(q)
  return also.length ? `${q.text}\n\nAlso read: ${also.map((l) => l.phrase).join(', ')}` : q.text
}

/**
 * The unchanged code a question also depends on (not linked from its words already), as code links named by file
 * ("queue.js"; "queue.js (2)" for a second range in it): a click lights the lines, never a line number.
 */
export function alsoLinks(q: Question): Link[] {
  const linked = (r: Range) => (q.links ?? []).some((l) => l.file === r.file && l.start <= r.end && r.start <= l.end)
  const seen = new Map<string, number>()
  return (q.also ?? []).filter((r) => !linked(r)).map((r) => {
    const name = r.file.split('/').pop()!, k = (seen.get(name) ?? 0) + 1
    seen.set(name, k)
    return { phrase: k > 1 ? `${name} (${k})` : name, file: r.file, start: r.start, end: r.end }
  })
}

/**
 * The code links of message `mi` of a check thread (`roles`: each message's role): the question's for the first
 * message, then each grade's own (the n-th agent reply is the n-th graded attempt). Answers have none.
 */
export function linksAt(q: Question, roles: string[], mi: number): Link[] {
  if (roles[mi] !== 'agent') return []
  const k = roles.slice(0, mi).filter((r) => r === 'agent').length
  // The question's own links, then its "Also read" names (last in its text, so they are found there).
  if (k === 0) return [...(q.links ?? []), ...alsoLinks(q)]
  // The grades the thread shows: a superseded answer's only when it explained (check/threads.ts messagesOf).
  return (q.attempts ?? []).filter((a) => a.verdict && (a.answer !== undefined || a.verdict === 'explained'))[k - 1]?.links ?? []
}

/**
 * The grader's reply in the thread: pass → a short confirmation; retry → feedback + hint; explained → the
 * explanation and an offer to say it back; a restatement → ✓, or what is still off.
 */
export function gradeBody(a: Attempt, o: { restatement?: boolean } = {}): string {
  if (a.verdict === 'pass' || a.verdict === 'restated') return `✓ ${a.feedback || 'Right.'}`
  if (a.verdict === 'retry') return `${retryText(a.feedback)}${a.hint ? `\n\n**Hint:** ${a.hint}` : ''}`.trim()
  if (o.restatement) return `${a.feedback ?? ''}\n\n_Try once more, or leave it: it is done._`.trim()
  return `${a.feedback ?? ''}\n\n_${SAY_IT_BACK}_`.trim()
}

/** After an explanation: the offer to say it back (the thread and the Check view say the same words). */
export const SAY_IT_BACK = 'Got it? Say it back in one sentence (optional).'
/** A retry's feedback, opening with "Not quite." (unless the grader's words already do). */
export function retryText(feedback: string | undefined): string {
  return `${/^not quite/i.test(feedback ?? '') ? '' : 'Not quite. '}${feedback ?? ''}`
}

/** The words of a row's state (the icon says the rest). */
export const STATE_WORD: Record<QState, string> = { todo: '', ungraded: 'not graded', pass: '', retry: 'try again', explained: 'explained · say it back', restated: 'in your words' }

/**
 * A question's concern: the one stored on it (found while grading), else the question's own "may be a bug", shown
 * only once it has been answered (before, it would give the answer away).
 */
export function concernOf(q: Question): { text: string; flagged: boolean; suspect: boolean; by?: string } | undefined {
  // Dismissed (with a reason) or marked fixed: done with; nothing more to do about it.
  if (q.concern?.dismissed || q.concern?.fixed) return undefined
  if (q.concern?.text) return { text: q.concern.text, flagged: !!q.concern.flagged, suspect: !!q.suspect && SUSPECTS.includes(q.concern.text), ...(q.concern.by ? { by: q.concern.by.name ?? q.concern.by.email } : {}) }
  return q.suspect && (q.attempts ?? []).some((a) => a.verdict) ? { text: SUSPECT, flagged: false, suspect: true } : undefined
}
export const SUSPECT = 'May be a bug.'
/** Its words in files written before (kept as a concern's text when flagged). */
const SUSPECTS = [SUSPECT, 'May be a bug: fix it or explain.']

export interface CheckRow { id: string; n: number; kind: string; text: string; where: string; also: string[]; state: QState; word: string; flag?: string; step?: number }
export interface CheckView {
  branch: string; file: string
  tone: Words['tone']; title: string; line: string
  rows: CheckRow[]
  /** The one button, when there is one. */
  action?: { id: 'start' | 'topUp' | 'commitPush' | 'scm' | 'openFile' | 'merge' | 'pull'; label: string }
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

/** A question's state that still asks for an answer. */
export const notDone = (s: string | undefined): boolean => s === 'todo' || s === 'retry' || s === 'ungraded'

/** "Writing questions · 0:42": what is being done, and for how long. */
export const busyLabel = (what: string, started: number, now = Date.now()): string => `${what} · ${clock(now - started)}`

/** One person's identity as stored in the check file: only the fields git has. */
export function whoOf(me: Who): Who {
  return definedOnly({ name: me.name || undefined, email: me.email || undefined })
}
/** The same person: by email when both have one, else by name. */
export function samePerson(a: Who, b: Who): boolean {
  return a.email && b.email ? a.email === b.email : a.name === b.name
}

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
const baseName = (f: string) => f.split('/').pop()!

export interface CheckViewOptions {
  busy?: string
  tourBusy?: string
  tourFailed?: boolean
  grading?: Set<string>
  unpushed?: boolean
  pushed?: string
  mr?: string
  me?: Who
  notice?: string
  commit?: CommitPlan
  selected?: string
  draft?: string
  said?: string
  failed?: { text: string; setting?: boolean; path?: boolean }
  error?: string
  uncommitted?: boolean
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

/**
 * The view's one button and the line above it (`line`: the CLI's words, replaced where the button needs its own).
 * Check my understanding (the command) decides with runAction, next to this.
 */
function actionOf(st: Status, line: string, o: CheckViewOptions): { action?: CheckView['action']; line: string } {
  const p = st.state.phase
  // Nothing of the change committed yet: said before any Claude call; Commit… (the check starts once it is in).
  if (p === 'none' && o.uncommitted) {
    return { action: { id: 'scm', label: 'Commit…' }, line: "Your change isn't committed yet: the questions are about committed code. Commit it and the check starts." }
  }
  if (p === 'none') return { action: { id: 'start', label: 'Start' }, line }
  // A file that can't be read: open it (at the first conflict); a conflict whose sides both read: keep both answers.
  if (p === 'invalid') {
    const action = st.state.conflict?.mergeable ? { id: 'merge' as const, label: 'Keep both answers' } : { id: 'openFile' as const, label: 'Open' }
    // Where the file stops being JSON ("Line 3: expected double-quoted property name."): Open goes there.
    return { action, line: o.invalidAt && !st.state.conflict ? o.invalidAt : line }
  }
  if (p === 'drift') return { action: st.state.commitFirst ? { id: 'scm', label: 'Commit…' } : { id: 'topUp', label: 'Add questions' }, line }
  if (p === 'done') return doneAction(st, line, o)
  return { line }
}
/** Done: whatever is left to commit or push, the button is there (the check file, an applied fix, the push itself). */
function doneAction(st: Status, line: string, o: CheckViewOptions): { action?: CheckView['action']; line: string } {
  let action: CheckView['action']
  const fixes = o.commit?.fixes ?? []
  if (st.dirty || fixes.length || o.unpushed !== false) {
    action = { id: 'commitPush', label: st.dirty || fixes.length || o.commit?.todos.length ? 'Commit & push' : 'Push' }
    if (!st.dirty) line = fixes.length ? 'Your fix is not committed yet.' : 'Not pushed yet.'
    // Only the tour is new (the answers are committed): no need for a push of its own.
    else if (o.commit?.tourOnly) line = 'Only the tour is new: it can go with your next push.'
  } else line = 'Pushed.'
  if (o.pushed && o.pushed !== 'Pushed.') line = o.pushed
  // Rejected: origin has newer commits. Pull is the way on (a conflict in the check file is then offered to merge).
  if (o.pushed && /rejected/.test(o.pushed)) action = { id: 'pull', label: 'Pull' }
  return { action, line }
}

/**
 * What Check my understanding (the command, the status bar item) does. Mostly the view's button (actionOf, above),
 * with these differences: a file that can't be read is opened (the view may offer Keep both answers); no check yet
 * starts writing (the view says Commit… first when nothing is committed); done, a change of the tour alone is no reason
 * to commit; and where the view has no button the command still shows something: the view (nothing to check, a stash),
 * else the tour or the next question (`walk`).
 */
export type RunStep = 'openFile' | 'show' | 'start' | 'scm' | 'topUp' | 'commitPush' | 'walk'
export function runAction(st: Status, o: { commit?: Pick<CommitPlan, 'fixes' | 'tourOnly'>; unpushed?: boolean }): RunStep {
  const p = st.state.phase
  if (p === 'invalid') return 'openFile'
  if (p === 'nothing' || p === 'stashed') return 'show'
  if (p === 'none') return 'start'
  if (p === 'drift') return st.state.commitFirst ? 'scm' : 'topUp'
  // Done but not committed or pushed. Only the tour is new: no commit and pipeline of its own (it goes with the next push).
  if (p === 'done' && ((st.dirty && !o.commit?.tourOnly) || o.commit?.fixes?.length || o.unpushed !== false)) return 'commitPush'
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

/**
 * A TODO comment with the whole concern (never cut): lines of at most `max` characters after `indent`, wrapped at
 * words; the first says "TODO:", the others line up under its text.
 */
export function todoLines(mark: [string, string], text: string, max = 100): string[] {
  const head = `${mark[0]} TODO: `, more = `${mark[0]}${' '.repeat(head.length - mark[0].length)}`, room = Math.max(20, max - head.length - mark[1].length)
  const out: string[] = []
  let cur = ''
  for (const w of text.replace(/\s+/g, ' ').trim().split(' ')) {
    if (cur && cur.length + 1 + w.length > room) { out.push(cur); cur = w } else cur = cur ? `${cur} ${w}` : w
  }
  if (cur) out.push(cur)
  // A block comment: one opening and one closing mark around all its lines.
  if (mark[1]) return out.map((l, i) => `${i ? ' '.repeat(head.length) : head}${l}${i === out.length - 1 ? mark[1] : ''}`)
  return out.map((l, i) => `${i ? more : head}${l}`)
}

/**
 * Where a TODO about a line goes: above it, at its indentation; a line that closes a block and opens the next ("} catch
 * (err) {", "} else {") is about the block it opens, so the TODO goes inside, at the next line's indentation.
 */
export function todoPlace(lines: string[], at: number): { line: number; indent: string } {
  const ind = (l: string | undefined) => (l ?? '').match(/^\s*/)![0]
  const t = (lines[at] ?? '').trim()
  if (/^[}\])]/.test(t) && /[{:]\s*$/.test(t) && at + 1 < lines.length) return { line: at + 1, indent: ind(lines[at + 1]) || `${ind(lines[at])}  ` }
  return { line: at, indent: ind(lines[at]) }
}

const HASH: [string, string] = ['#', '']
const DASHES: [string, string] = ['--', '']
const HTML: [string, string] = ['<!--', ' -->']
const BLOCK: [string, string] = ['/*', ' */']
/** A comment's [open, close] by file extension (todoLines); any other file: `//`. */
const COMMENT_MARKS: Record<string, [string, string]> = {
  '.py': HASH, '.rb': HASH, '.sh': HASH, '.bash': HASH, '.yaml': HASH, '.yml': HASH, '.toml': HASH, '.r': HASH,
  '.pl': HASH, '.ex': HASH, '.exs': HASH, '.tf': HASH,
  '.sql': DASHES, '.lua': DASHES, '.hs': DASHES,
  '.html': HTML, '.xml': HTML, '.vue': HTML, '.svelte': HTML, '.md': HTML,
  '.css': BLOCK, '.scss': BLOCK,
}
/** Files known by name, not extension. */
const HASH_FILES = /(^|\/)(Dockerfile|Makefile)$/

/** A comment for a file's language: [open, close] (a line comment closes with ''). */
export function commentMark(file: string): [string, string] {
  if (HASH_FILES.test(file)) return HASH
  const ext = path.extname(file).toLowerCase()
  return Object.hasOwn(COMMENT_MARKS, ext) ? COMMENT_MARKS[ext] : ['//', '']
}

/** A hunk header of a unified diff: "@@ -a,b +c,d @@" (c, d: the new side's first line and count). */
const HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/
/** The new side's lines of each hunk of a unified diff (a deletion: the line it happened at). */
export function hunksOf(diff: string): { start: number; end: number }[] {
  return diff.split('\n').flatMap((h) => {
    const m = HUNK.exec(h)
    if (!m) return []
    const start = Number(m[1])
    return [{ start, end: start + Math.max(0, Number(m[2] ?? 1) - 1) }]
  })
}

/** Where the engine's JSON error is, when it says so: "… (line 3 column 5)" (newer V8) or "… at position 42". */
const JSON_LINE_COL = /line (\d+) column (\d+)/
const JSON_POSITION = /position (\d+)/
/**
 * The engine's words without the place and the quoted text: "Expected ':' after property name in JSON at position 6
 * (line 2 column 5)" → "Expected ':' after property name"; "Unexpected token '}', "{"a":}" is not valid JSON" →
 * "Unexpected token '}'".
 */
const JSON_WHAT = /^(Unexpected token[^,]*|[^(]*?)(?:,.*| in JSON.*| at position.*|\(.*)$/s

/** A JSON.parse error of `text` as a line for the Check view ("Line 3: expected double-quoted property name."). */
export function jsonErrorAt(message: string, text: string | undefined): { line: number; col: number; text: string } | undefined {
  let lc = JSON_LINE_COL.exec(message)?.slice(1).map(Number)
  const pos = JSON_POSITION.exec(message)?.[1]
  if (!lc && pos !== undefined && typeof text === 'string') lc = lineColAt(text, Number(pos))
  if (!lc) return undefined
  const what = message.replace(JSON_WHAT, '$1').trim().replace(/\.$/, '')
  return { line: lc[0], col: lc[1], text: `Line ${lc[0]}: ${what ? `${what[0].toLowerCase()}${what.slice(1)}` : 'not valid JSON'}.` }
}
/** 1-based line and column of offset `pos` in `text`. */
function lineColAt(text: string, pos: number): [number, number] {
  const before = text.slice(0, pos).split('\n')
  return [before.length, before.at(-1)!.length + 1]
}

/**
 * The messages of `want` that a thread (`have`) doesn't hold yet. Append-only: the thread may hold more (a remark
 * after the question was done), never less; its first k human (agent) messages stand for want's first k.
 */
export function missingMessages<M extends { role?: string }>(have: M[], want: M[]): M[] {
  const seen = { human: have.filter((m) => m.role === 'human').length, agent: have.filter((m) => m.role === 'agent').length }
  return want.filter((m) => {
    const role = m.role === 'human' ? 'human' : 'agent'
    if (seen[role] > 0) { seen[role]--; return false }
    return true
  })
}

/** Why grading failed, in the same plain words as writing (the answer is kept either way). */
export function gradeFailure(error: string, kind?: AskErrorKind): string {
  const cause = causeOf(error, kind)
  const why = cause === 'no-cli' ? "Claude Code wasn't found"
    : cause === 'busy' || cause === 'auth' ? CAUSE_TEXT[cause].replace(/\.$/, '')
    : "Claude couldn't check it"
  return `${why}; your answer is saved.`
}

/** The status bar, from the CLI's words: hidden when no check is needed; an icon by tone; amber for a top-up. */
export function statusText(st: Status | undefined, w: Words | undefined): { text: string; tip: string; warn: boolean } | undefined {
  if (!st || !w || !w.bar) return undefined
  const p = st.state.phase
  const icon = p === 'done' ? '$(pass)' : w.tone === 'warn' ? '$(warning)' : '$(checklist)'
  return { text: `${icon} ${w.bar.replace(/^✓\s*/, '')}`, tip: [w.title, w.line].filter(Boolean).join(' · '), warn: p === 'drift' }
}

/** A failed call to Claude, by cause: from the extension's own `kind`, else from Claude's or the system's words. */
type Cause = 'no-cli' | 'model' | 'busy' | 'auth' | 'other'
function causeOf(error: string, kind?: AskErrorKind): Cause {
  // Not installed, or not where the setting says (the extension couldn't start it; or the system said ENOENT).
  if (kind === 'no-cli' || /ENOENT/i.test(error)) return 'no-cli'
  if (/model/i.test(error)) return 'model'
  if (/rate.?limit|overloaded|429|529/i.test(error)) return 'busy'
  if (/auth|log ?in|api key|401|403/i.test(error)) return 'auth'
  return 'other'
}
const CAUSE_TEXT = { 'no-cli': "Claude Code wasn't found.", busy: 'Claude is busy right now.', auth: "Claude Code isn't signed in." }

/**
 * Why writing the questions failed, in plain words for the Check view (never the script's or the CLI's own advice):
 * `error` from Claude (`errorKind`: what the extension knows about it), or `text`, the writer's reply when it wrote
 * nothing.
 */
export function writeFailure(o: { error?: string; errorKind?: AskErrorKind; text?: string; model?: string }): { text: string; setting?: boolean; path?: boolean } {
  const e = String(o.error ?? '')
  if (e) {
    const cause = causeOf(e, o.errorKind)
    // Install it, or set its path (and a reviewer's approval waives the check).
    if (cause === 'no-cli') return { text: CAUSE_TEXT['no-cli'], path: true }
    if (cause === 'model') return { text: `Claude couldn't use the model${o.model ? ` "${o.model}"` : ''}.`, setting: true }
    if (cause === 'busy' || cause === 'auth') return { text: CAUSE_TEXT[cause] }
    return { text: `Claude couldn't write the questions: ${e.split(/(?<=[.!?])\s/)[0].replace(/\s*Run --?\S+.*$/i, '').slice(0, 120)}` }
  }
  const t = String(o.text ?? '')
  if (/UNCOMMITTED/.test(t)) return { text: 'Commit your change first: questions are about committed code.' }
  if (/NOTHING/.test(t)) return { text: 'No code lines changed: nothing to ask.' }
  return { text: "Claude couldn't write questions for this change." }
}
