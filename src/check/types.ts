// The understanding check's shapes: the check file (Check, Question, Attempt), where it stands (Status, State, Words: the
// CLI's), and Cli, the functions of cli/understanding.mjs the extension calls. No code here but the two QState tests
// below: the rules live in the CLI.

export type Kind = 'how' | 'why' | 'failure' | 'edge' | 'change'
export type Verdict = 'pass' | 'retry' | 'explained' | 'restated'
export type QState = 'todo' | 'ungraded' | 'pass' | 'retry' | 'explained' | 'restated'
/** A question's state that still asks for an answer. */
export const notDone = (s: string | undefined): boolean => s === 'todo' || s === 'retry' || s === 'ungraded'
/**
 * A question that needs no more answers: passed, explained, or said back in your own words. For every QState it is
 * the opposite of notDone ('' and other strings: neither); viewModel's answerBox counts only pass and restated as passed.
 */
export const questionDone = (state: QState | string) => state === 'pass' || state === 'explained' || state === 'restated'
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
  /**
   * Verdict `v` recorded on attempt `a` of `q` (in place) at `at`: links to lines that are there, the time, the hash; a
   * concern kept on the question. The same record as the CLI's own grades.
   */
  recordGrade(repo: string, q: Question, a: Attempt, v: ReturnType<Cli['parseVerdict']>, at: string): Attempt
  /** The new side's lines of each hunk of a unified diff (a deletion: the line it happened at). */
  hunksOf(diff: string): { start: number; end: number }[]
  /** Where a branch's check waits while another branch is checked out (git-ignored): `.code-notes/.cache/checks`. */
  CACHE: string
  /** The usual names of a default branch: main, master. */
  DEFAULT_BRANCHES: string[]
}
