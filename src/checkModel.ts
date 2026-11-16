// Understanding check in the editor: the prompt that writes the questions, the plain phase shown while it works, the
// grader's reply as a thread message, the panel's view. No vscode API here (unit-tested in test/checkModel.test.ts).
// The rules (file format, grading prompt, thresholds) live in cli/understanding.mjs; its shapes are typed here.
import type { ToolCall } from './claude'

export type Kind = 'how' | 'why' | 'failure' | 'edge' | 'change'
export type Verdict = 'pass' | 'retry' | 'explained'
export type QState = 'todo' | 'ungraded' | 'pass' | 'retry' | 'explained'
export interface Who { name?: string; email?: string }
export interface Attempt { answer: string; at?: string; by?: Who; verdict?: Verdict; feedback?: string; hint?: string; hash?: string; gradedAt?: string }
export interface Question { id: string; kind: Kind; text: string; file: string; start?: number; end?: number; target?: 'file'; anchor?: { v: 3; head: string; tail: string; lines: number; hash: string; before: string; after: string }; attempts?: Attempt[]; round?: number }
export interface Check { version: 1; branch: string; base?: string; head: string; answeredBy?: Who; diffStat?: { files: number; added: number; removed: number }; model?: string; createdAt?: string; questions: Question[] }
export interface Summary { total: number; passed: number; explained: number; retry: number; todo: number; ungraded: number; open: number; needed: number; met: boolean; states: QState[] }
export interface Status {
  branch: string; file: string; base?: string; baseRef?: string; head?: string; changed: number; small: boolean; exists: boolean
  errors?: string[]; check?: Check; summary?: Summary; drift?: { lines: number; approx: boolean }; dirty?: boolean; next: string
}
export interface Config { questions: { min: number; max: number }; minChangedLines: number; passRatio: number; maxDrift: number; model: string | null }

/** The functions of cli/understanding.mjs the extension uses (it is loaded with import() at run time). */
export interface Cli {
  localStatus(repo: string, o?: { base?: string }): Status
  loadConfig(repo: string): Config
  readCheck(file: string): Check
  writeCheck(file: string, c: Check): void
  validateCheck(c: unknown, o?: { repo?: string }): string[]
  stateOf(q: Question): QState
  summarize(c: Check, cfg: Config): Summary
  addAttempt(c: Check, q: Question, answer: string, who?: Who): Attempt
  gitIdentity(repo: string): Who | undefined
  attemptHash(q: Question, a: Attempt): string
  graderPrompt(o: { q: Question; answer: string; attempt: number; diff: string; code: string; canRead: boolean }): string
  parseVerdict(text: string, attempt: number): { verdict: Verdict; feedback: string; hint: string }
  diffText(repo: string, from: string, to?: string): string
  diffForGrader(diff: string, file: string): string
  codeWindow(repo: string, q: Question): string
  stamp(c: Check, cfg: Config): Check
  fileFor(branch: string): string
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

/** The question as the first message of its thread (its kind is in the panel; "Why: Why …" reads badly). */
export function questionBody(q: Question): string {
  return q.text
}

/** The grader's reply in the thread: pass → a short confirmation; retry → feedback + hint; explained → the explanation. */
export function gradeBody(a: Attempt): string {
  if (a.verdict === 'pass') return `✓ ${a.feedback || 'Right.'}`
  if (a.verdict === 'retry') return `${/^not quite/i.test(a.feedback ?? '') ? '' : 'Not quite. '}${a.feedback ?? ''}${a.hint ? `\n\n**Hint:** ${a.hint}` : ''}`.trim()
  return `${a.feedback ?? ''}\n\n_Counted as missed. On to the next one._`.trim()
}

export const STATE_WORD: Record<QState, string> = { todo: 'to answer', ungraded: 'not graded', pass: '✓', retry: 'try again', explained: 'explained' }

export interface CheckRow { id: string; n: number; kind: string; text: string; where: string; state: QState; word: string }
export interface CheckView {
  branch: string; file: string
  /** "2 of 4 passed · 3 needed" */
  progress: string
  rows: CheckRow[]
  met: boolean
  /** The one next step, when there is one: commit (with a Stage button), or top up. */
  next?: { text: string; action?: 'stage' | 'topUp'; button?: string }
  /** Writing questions now: "Writing questions · 0:42 · reading the change". */
  busy?: string
}

const where = (q: Question) => (q.target === 'file' || !q.start ? q.file : `${q.file}:${q.start}`)

export function checkView(st: Status, o: { maxDrift: number; staged: boolean; busy?: string; grading?: Set<string> }): CheckView | undefined {
  if (!st.check || !st.summary) return o.busy ? { branch: st.branch, file: st.file, progress: '', rows: [], met: false, busy: o.busy } : undefined
  const s = st.summary
  const rows = st.check.questions.map((q, i) => {
    const state: QState = o.grading?.has(q.id) ? 'ungraded' : s.states[i]
    return { id: q.id, n: i + 1, kind: KIND_LABEL[q.kind] ?? q.kind, text: q.text, where: where(q), state, word: o.grading?.has(q.id) ? 'checking…' : STATE_WORD[state] }
  })
  const drift = st.drift && st.drift.lines > o.maxDrift
  const done = s.todo === 0 && s.ungraded === 0
  const next = drift ? { text: `The change grew by ${st.drift!.lines} lines since these questions.`, action: 'topUp' as const, button: 'Add questions' }
    : s.met && done ? (o.staged ? { text: `Staged. Commit and push.` } : st.dirty ? { text: `Commit ${st.file} and push.`, action: 'stage' as const, button: 'Stage it' } : { text: 'Committed. Push if you haven\'t.' })
    : undefined
  return {
    branch: st.branch, file: st.file, rows, met: s.met && done, next, ...(o.busy ? { busy: o.busy } : {}),
    progress: s.met && done ? `Passed · ${s.passed} of ${s.total}` : `${s.passed} of ${s.total} passed · ${s.needed} needed`,
  }
}

/** The status bar: hidden (nothing to check), "Check" (none yet), "2/4 ✓" (a check), with an icon for passed or out of date. */
export function statusText(st: Status | undefined, maxDrift: number): { text: string; tip: string } | undefined {
  if (!st) return undefined
  if (!st.exists) return st.small ? undefined : { text: '$(checklist) Check', tip: `Check my understanding: ${st.changed} lines changed on ${st.branch}` }
  if (!st.summary) return { text: '$(warning) Check', tip: st.next }
  const s = st.summary
  const icon = st.drift && st.drift.lines > maxDrift ? '$(warning)' : s.met && !s.todo && !s.ungraded ? '$(pass)' : '$(checklist)'
  return { text: `${icon} ${s.passed}/${s.total} ✓`, tip: st.next }
}
