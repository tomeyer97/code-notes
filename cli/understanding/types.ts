// The check's shapes: the check file (Check, Question, Attempt), its settings (Config), and where a branch stands
// (BranchStatus, CheckPosition, Words). The extension imports them from here (src/check/types.ts), so both sides
// read one definition. Types only: nothing here is in the built file.
import type { JStep, Journey } from '../../src/core/format/journeyModel'
import type { CompactAnchor } from '../../src/core/anchors/kinds'

export type Kind = 'how' | 'why' | 'failure' | 'edge' | 'change'
export type Verdict = 'pass' | 'retry' | 'explained' | 'restated'
/** A question's state (stateOf): todo, ungraded, retry, or one of the done ones: pass, explained, restated. */
export type QState = 'todo' | 'ungraded' | Verdict

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
  /** The grader found it mostly right (a pass with a gap). */
  partial?: boolean
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

/** Where a question's lines are, to find them again after the code moved: a compact anchor, the same as a journey
 *  step's (src/core/anchors/compact.ts; anchors.ts compactOf/findAnchor). */
export type QuestionAnchor = CompactAnchor

/** A concern about the code found while grading; `flagged`: the author put it on the merge request. */
export interface Concern {
  text: string
  flagged?: boolean
  at?: string
  by?: Who
  dismissed?: { reason: string; by?: Who; at?: string }
  fixed?: { by?: Who; at?: string }
}

export interface Question {
  id: string
  kind: Kind
  text: string
  file: string
  start?: number
  end?: number
  target?: 'file'
  anchor?: QuestionAnchor
  attempts?: Attempt[]
  round?: number
  /** Unchanged code the question also depends on. */
  also?: (Range & { anchor?: QuestionAnchor; target?: 'file' })[]
  /** The question's own "may be a bug" (see concernOf). */
  suspect?: boolean
  links?: Link[]
  /** The step of the check's tour after which its answer is visible. */
  step?: number
  concern?: Concern
}

/**
 * The check's tour: a journey of the change in the journey file format (docs/journey-format.md), as written in the
 * check file. Its steps need a title, a file and lines; the rest is the journey's (parseJourney fills what is missing).
 */
export type CheckTour = Pick<Journey, 'title'> & Partial<Omit<Journey, 'title' | 'steps'>> & {
  steps: (Pick<JStep, 'title' | 'file' | 'range'> & Partial<Omit<JStep, 'title' | 'file' | 'range'>>)[]
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
  journey?: CheckTour
  /** Documentation that describes no code: no tour, on purpose. */
  noTour?: true
  /** The informational result (stamp): what CI found when it last looked. */
  result?: { done: number; passed: number; total: number; needed: number; verdict: 'pass' | 'fail'; at: string }
}

/** understanding/config.json, with the defaults filled in (loadConfig). */
export interface Config {
  questions: { min: number; max: number }
  passRatio: number
  maxDrift: number
  exempt: string[]
  mode: string
  skipLabel: string
  model: string | null
  backend: string | null
  mrComment: boolean
}

/** A file of `git diff --numstat` (numstat). `from`: its old name, when git saw a rename. */
export interface NumstatFile { file: string; from?: string; added: number; removed: number; binary: boolean }

/** What changed in code lines (codeStat): counted files only, exempt files listed apart. */
export interface CodeStat {
  files: number
  added: number
  removed: number
  /** Exempt files that changed. */
  exempt: string[]
  /** Only exempt files changed. */
  exemptOnly: boolean
  /** Only documentation changed (README, docs/). */
  docsOnly?: boolean
  /** Moved or renamed files (a move is a change even when no line changed). */
  renamed?: { from: string; to: string }[]
}

/** How many questions a change asks for (size.ts). */
export interface Want { min: number; max: number }

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

/**
 * Where the check stands, in one word (`phase`, checkState), with the numbers its words need. The counts are the
 * summary's (BranchStatus.summary is the source; they are copied here so the words need nothing else).
 */
export interface CheckPosition {
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
  /** No check yet: how many questions the change asks for (questionsForChange). */
  want?: number
  docs?: boolean
  removal?: boolean
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

/** Code lines the change gained since the questions were written (`approx`: estimated from the sizes). */
export interface Drift { lines: number; approx: boolean }

/** Where a branch stands (localStatus): what changed, its check file and check, and its position (`state`). */
export interface BranchStatus {
  branch: string
  file: string
  base?: string
  baseRef?: string
  head?: string
  change?: CodeStat
  /** On a default branch (isDefaultBranch): no check there, no questions in the background. */
  onBase?: boolean
  /** Stacked on this branch, whose check is committed here. */
  stackedOn?: string
  /** The check file is in this git stash. */
  stashed?: string
  changed: number
  exists: boolean
  errors?: string[]
  /** The file's merge conflict (its position says it too). */
  conflict?: { line: number; mergeable: boolean }
  check?: Check
  summary?: Summary
  drift?: Drift
  pending?: Drift
  dirty?: boolean
  untracked?: boolean
  state: CheckPosition
  next: string
}

export interface PushResult {
  ok: boolean
  committed: boolean
  pushed: boolean
  line: string
  /** The host's "create a merge request" link from the push's output. */
  mr?: string
}

/** commitCheck's result: the push's (or only the commit's), with the files committed. */
export interface CommitResult {
  ok: boolean
  line: string
  committed?: boolean
  pushed?: boolean
  mr?: string
  files?: string[]
}

/** A grader's answer (parseVerdict). */
export interface ParsedVerdict {
  verdict: Verdict
  feedback: string
  hint: string
  partial?: boolean
  note?: string
  topic?: string
  concern?: string
  links?: Link[]
}

/** Everything a refresh of the branch's status reads (refreshInputs): files (relative to the repository) and refs. */
export interface RefreshInputs {
  /** The branch (currentBranch). */
  branch: string
  /** Files whose content the status depends on: the check file, its settings, its cached copy. */
  files: string[]
  /** Ref files (relative to the git common dir) the base branch is chosen from. */
  refs: string[]
}
