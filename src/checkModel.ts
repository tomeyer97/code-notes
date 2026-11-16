// Understanding check in the editor: the prompt that writes the questions, the plain phase shown while it works, the
// grader's reply as a thread message, the Check view's model, the status bar. No vscode API here (unit-tested in
// test/checkModel.test.ts). The rules (file format, grading prompt, the pass rule and the one state every surface
// shows: checkState / stateWords) live in cli/understanding.mjs; its shapes are typed here.
import type { ToolCall } from './claude'

export type Kind = 'how' | 'why' | 'failure' | 'edge' | 'change'
export type Verdict = 'pass' | 'retry' | 'explained' | 'restated'
export type QState = 'todo' | 'ungraded' | 'pass' | 'retry' | 'explained' | 'restated'
export interface Who { name?: string; email?: string }
export interface Attempt {
  answer: string; at?: string; by?: Who; verdict?: Verdict; feedback?: string; hint?: string; hash?: string; gradedAt?: string
  note?: string; topic?: string; concern?: string; flagged?: boolean
}
export interface Range { file: string; start: number; end: number }
export interface Question {
  id: string; kind: Kind; text: string; file: string; start?: number; end?: number; target?: 'file'
  anchor?: { v: 3; head: string; tail: string; lines: number; hash: string; before: string; after: string }
  attempts?: Attempt[]; round?: number; also?: Range[]; suspect?: boolean
  /** A concern about the code found while grading; `flagged`: the author put it on the merge request. */
  concern?: { text: string; flagged?: boolean; at?: string }
}
export interface Check { version: 1; branch: string; base?: string; head: string; answeredBy?: Who; diffStat?: { files: number; added: number; removed: number }; model?: string; createdAt?: string; questions: Question[] }
export interface Summary { total: number; passed: number; done: number; explained: number; restated: number; retry: number; todo: number; ungraded: number; open: number; needed: number; met: boolean; states: QState[] }
export type Phase = 'nothing' | 'none' | 'invalid' | 'drift' | 'answering' | 'short' | 'done'
export interface State { phase: Phase; passed?: number; done?: number; total?: number; needed?: number; maxDrift?: number; grew?: number; commitFirst?: boolean; changed?: number; exemptOnly?: boolean; why?: string }
export interface Words { tone: 'ok' | 'warn' | 'todo'; bar: string; title: string; line: string; rule: string }
export interface Status {
  branch: string; file: string; base?: string; baseRef?: string; head?: string; changed: number; exists: boolean
  errors?: string[]; check?: Check; summary?: Summary; drift?: { lines: number; approx: boolean }; pending?: { lines: number; approx: boolean }; dirty?: boolean
  state: State; next: string
}
export interface Config { questions: { min: number; max: number }; passRatio: number; maxDrift: number; model: string | null }
export interface PushResult { ok: boolean; committed: boolean; pushed: boolean; line: string }

/** The functions of cli/understanding.mjs the extension uses (it is loaded with import() at run time). */
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
  graderPrompt(o: { q: Question; answer: string; attempt: number; explanation?: string; diff: string; code: string; canRead: boolean }): string
  parseVerdict(text: string, attempt: number, o?: { restate?: boolean }): { verdict: Verdict; feedback: string; hint: string; note?: string; topic?: string; concern?: string }
  diffText(repo: string, from: string, to?: string): string
  diffForGrader(diff: string, file: string): string
  codeWindow(repo: string, q: Question): string
  stamp(c: Check, cfg: Config): Check
  fileFor(branch: string): string
  slugOf(branch: string): string
  commitAndPush(repo: string, files: string[], message: string): Promise<PushResult>
}

/** The prompt for `claude -p` that writes (or tops up) the questions with the understanding-check skill. */
export function checkPrompt(o: { skill: string; branch: string; baseRef: string; base: string; topUp: boolean; bundled: boolean }): string {
  const how = o.bundled
    ? `Read ${o.skill}/SKILL.md and follow it exactly (it is the understanding-check skill; it is not installed, so do not look for it with the Skill tool)`
    : 'Use the understanding-check skill'
  const start = `${o.skill}/scripts/questions.mjs start ${o.topUp ? '--top-up' : `--base ${o.base}`}`
  return [
    `${how} to ${o.topUp ? 'add 1-2 questions about what changed since the understanding check of' : 'write the questions of an understanding check for'} this branch (${o.branch}, compared with ${o.baseRef}).`,
    `Start with: ${start}`,
    `Run the script by its full path (${o.skill}/scripts/…), one command per call: no shell variables, no && or pipes. Do not modify any other file.`,
    'When done, reply with one line per question you wrote.',
  ].join('\n\n')
}

/** What Claude is doing while it writes the questions, in plain words, from its last tool call. */
export function checkPhase(tool: ToolCall | undefined, prev: string): string {
  if (!tool) return prev
  if (tool.name !== 'Bash') return ['Read', 'Grep', 'Glob'].includes(tool.name) && prev !== 'writing questions' ? 'reading the code' : prev
  const m = /questions\.mjs\s+([a-z-]+)/.exec(String(tool.input?.command ?? ''))
  if (!m) return prev
  return m[1] === 'start' ? 'reading the change' : m[1] === 'add' || m[1] === 'remove' ? 'writing questions' : m[1] === 'finish' ? 'checking' : prev
}

export const KIND_LABEL: Record<Kind, string> = { how: 'How', why: 'Why', failure: 'Failure', edge: 'Edge case', change: 'Change' }

const range = (r: Range) => `${r.file}:${r.start}${r.end > r.start ? `-${r.end}` : ''}`

/** The question as the first message of its thread; the unchanged code it depends on as links below it. */
export function questionBody(q: Question): string {
  return q.also?.length ? `${q.text}\n\nAlso read: ${q.also.map(range).join(', ')}` : q.text
}

/**
 * The grader's reply in the thread: pass → a short confirmation; retry → feedback + hint; explained → the
 * explanation and an offer to say it back; a restatement → ✓, or what is still off.
 */
export function gradeBody(a: Attempt, o: { restatement?: boolean } = {}): string {
  if (a.verdict === 'pass' || a.verdict === 'restated') return `✓ ${a.feedback || 'Right.'}`
  if (a.verdict === 'retry') return `${/^not quite/i.test(a.feedback ?? '') ? '' : 'Not quite. '}${a.feedback ?? ''}${a.hint ? `\n\n**Hint:** ${a.hint}` : ''}`.trim()
  if (o.restatement) return `${a.feedback ?? ''}\n\n_Try once more, or leave it: it is done._`.trim()
  return `${a.feedback ?? ''}\n\n_Got it? Say it back in one sentence (optional)._`.trim()
}

/** The words of a row's state (the icon says the rest). */
export const STATE_WORD: Record<QState, string> = { todo: '', ungraded: 'not graded', pass: '', retry: 'try again', explained: 'explained · say it back', restated: 'in your words' }

/** A question's concern: the one stored on it (found while grading), else the question's own "may be a bug". */
export function concernOf(q: Question): { text: string; flagged: boolean; suspect: boolean } | undefined {
  if (q.concern?.text) return { text: q.concern.text, flagged: !!q.concern.flagged, suspect: !!q.suspect && q.concern.text === SUSPECT }
  return q.suspect ? { text: SUSPECT, flagged: false, suspect: true } : undefined
}
const SUSPECT = 'May be a bug: fix it or explain.'

export interface CheckRow { id: string; n: number; kind: string; text: string; where: string; also: string[]; state: QState; word: string; flag?: string }
export interface CheckView {
  branch: string; file: string
  tone: Words['tone']; title: string; line: string
  rows: CheckRow[]
  /** The one button, when there is one. */
  action?: { id: 'start' | 'topUp' | 'commitPush' | 'scm'; label: string }
  /** Someone else's check: whose, in one line. */
  who?: string
  /** Writing questions now: "Writing questions · 0:42 · reading the change". */
  busy?: string
}

const where = (q: Question) => (q.target === 'file' || !q.start ? q.file : `${q.file}:${q.start}`)

/**
 * The Check view: where the check stands (the CLI's words), the questions, one button. `unpushed`: the branch has
 * commits its remote doesn't (undefined: no upstream). `pushed`: what Commit & push said last.
 */
export function checkView(st: Status, w: Words, o: { busy?: string; grading?: Set<string>; unpushed?: boolean; pushed?: string; me?: Who } = {}): CheckView {
  const s = st.summary
  const rows: CheckRow[] = (st.check?.questions ?? []).map((q, i) => {
    const grading = o.grading?.has(q.id)
    const state: QState = grading ? 'ungraded' : s?.states[i] ?? 'todo'
    const c = concernOf(q)
    return { id: q.id, n: i + 1, kind: KIND_LABEL[q.kind] ?? q.kind, text: q.text, where: where(q), also: (q.also ?? []).map(range), state, word: grading ? 'checking…' : STATE_WORD[state],
      ...(c ? { flag: c.suspect ? 'may be a bug' : c.flagged ? 'flagged for review' : 'concern' } : {}) }
  })
  const p = st.state.phase
  let line = w.line
  let action: CheckView['action']
  if (p === 'none') action = { id: 'start', label: 'Start' }
  else if (p === 'drift') action = st.state.commitFirst ? { id: 'scm', label: 'Commit…' } : { id: 'topUp', label: 'Add questions' }
  else if (p === 'done') {
    if (st.dirty || o.unpushed !== false) { action = { id: 'commitPush', label: 'Commit & push' }; if (!st.dirty) line = 'Not pushed yet.' }
    else line = 'Pushed.'
    if (o.pushed && o.pushed !== 'Pushed.') line = o.pushed
  }
  const by = st.check?.answeredBy
  const sameWho = !by || !o.me || (by.email && o.me.email ? by.email === o.me.email : by.name === o.me.name)
  return {
    branch: st.branch, file: st.file, tone: w.tone, title: w.title, line, rows,
    ...(action && !o.busy ? { action } : {}), ...(o.busy ? { busy: o.busy } : {}),
    ...(!sameWho ? { who: `${by!.name ?? by!.email}'s check: your answers are recorded as yours.` } : {}),
  }
}

/** The status bar, from the CLI's words: hidden when no check is needed; an icon by tone; amber for a top-up. */
export function statusText(st: Status | undefined, w: Words | undefined): { text: string; tip: string; warn: boolean } | undefined {
  if (!st || !w || !w.bar) return undefined
  const p = st.state.phase
  const icon = p === 'done' ? '$(pass)' : w.tone === 'warn' ? '$(warning)' : '$(checklist)'
  return { text: `${icon} ${w.bar.replace(/^✓\s*/, '')}`, tip: [w.title, w.line].filter(Boolean).join(' · '), warn: p === 'drift' }
}
