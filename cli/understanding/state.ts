// Where the check stands: each question's state, the pass rule, the branch's status (localStatus), the one
// state every surface shows (checkState) and its words (stateWords).
import fs from 'node:fs'
import path from 'node:path'
import { DEFAULTS, DIR, STATE } from './constants'
import { baseRefFiles, currentBranch, defaultBase, gitOk, hasCommit, isDefaultBranch, mergeBase, stackBase, stashedIn } from './git'
import { codeStat, freshLines, linesOf } from './diff'
import { changeKind, questionsFor, questionsForChange } from './size'
import { cachedFor, conflictOf, fileFor, loadConfig, readCheck } from './checkFile'
import { validateCheck } from './validate'
import { relocate } from './anchors'
import { PHASE } from './phases'
import type { BranchStatus, Check, CheckPosition, CodeStat, Config, Drift, QState, Question, RefreshInputs, Summary, Words } from './types'

/**
 * What checkState decides from. localStatus gathers all of it; CI builds `{ exists: true, summary, drift }`. Which
 * fields go together:
 *   no file      `exists` false: `changed` and `change` (the change's size), `stashed` when a git stash holds the file
 *   unreadable   `exists` true, `errors` (and `conflict` for conflict markers), no `summary`
 *   read         `exists` true, `summary`, `drift` (committed lines since the questions), `pending` (with uncommitted ones)
 */
export interface StateFacts {
  exists?: boolean
  stashed?: string
  /** The caller judged the change too small to check (no check needed). */
  small?: boolean
  changed?: number
  change?: CodeStat
  errors?: string[]
  conflict?: { line: number; mergeable: boolean }
  summary?: Summary
  drift?: Drift
  pending?: Drift
}
/** The check file as read (readOrExplain, notInTree): the check, or why there is none. */
type ReadResult = Pick<BranchStatus, 'check' | 'errors' | 'conflict' | 'stashed'>
/** A branch's facts, before its position is decided (gatherStatus). */
type Gathered = Omit<BranchStatus, 'state' | 'next'>

/**
 * One question's state, from its attempts: todo (no answer), ungraded, retry (try again), pass, explained (answered
 * by the grader), restated (explained, then said back rightly). Done: pass, explained or restated.
 */
export function stateOf(q: Question): QState {
  const as = Array.isArray(q.attempts) ? q.attempts : []
  if (!as.length) return STATE.todo
  if (as.some((a) => a.verdict === STATE.pass)) return STATE.pass
  if (as.some((a) => a.verdict === STATE.restated)) return STATE.restated
  if (as.some((a) => a.verdict === STATE.explained)) return STATE.explained
  const last = as[as.length - 1]
  return last.verdict === STATE.retry ? STATE.retry : STATE.ungraded
}

/** Passed questions needed out of `total`. */
export const needed = (total: number, ratio: number): number => Math.max(1, Math.ceil(total * ratio - 1e-9))

export const isDone = (state: QState | string): boolean => state === STATE.pass || state === STATE.explained || state === STATE.restated
export const isPassed = (state: QState | string): boolean => state === STATE.pass || state === STATE.restated

/**
 * The rule: every question done (pass, explained or restated; a "try again" is not done) AND ceil(passRatio × total)
 * passed (pass or restated). `met` is that rule; checkState says it in one word.
 */
export function summarize(check: Check, cfg: Config = DEFAULTS): Summary {
  const states = check.questions.map(stateOf)
  const count = (s: QState): number => states.filter((x) => x === s).length
  const total = states.length
  const need = needed(total, cfg.passRatio)
  const passed = states.filter(isPassed).length
  const done = states.filter(isDone).length
  return { total, passed, done, explained: count(STATE.explained), restated: count(STATE.restated), retry: count(STATE.retry), todo: count(STATE.todo), ungraded: count(STATE.ungraded),
    open: total - done, needed: need, met: done === total && passed >= need, states }
}

/** The rule in one phrase, the same everywhere. */
export const ruleText = (s: { total?: number; needed?: number }): string => `Answer all ${s.total} · ${s.needed} must pass`


/**
 * What localStatus reads besides git's own state (HEAD, the refs, the working tree): the branch, the files of the
 * check (its file, the settings, the copy the extension parks while another branch is out) and the ref files its base
 * branch is chosen from. The extension hashes them to skip a refresh when nothing changed: a new input goes here.
 */
export function refreshInputs(repo: string, env: NodeJS.ProcessEnv = process.env): RefreshInputs {
  const branch = currentBranch(repo, env)
  return { branch, files: [fileFor(branch), `${DIR}/config.json`, cachedFor(branch)], refs: baseRefFiles() }
}

/**
 * Where the branch stands: what changed, the check file, whether it is still valid, where it stands (checkState) and
 * the next step. Two steps: gatherStatus (git and the files), then statusOf (pure: the position and its words).
 */
export function localStatus(repo: string, { base, cfg = loadConfig(repo), env = process.env }: { base?: string; cfg?: Config; env?: NodeJS.ProcessEnv } = {}): BranchStatus {
  return statusOf(gatherStatus(repo, { base, cfg, env }), cfg)
}

/** A branch's facts with its position (checkState) and the next step (stateWords' line): no git, no files. */
export function statusOf(facts: Gathered, cfg: Config = DEFAULTS): BranchStatus {
  const state = checkState(facts, cfg)
  return { ...facts, state, next: stateWords(state, facts).line }
}

/**
 * A branch's facts from git and the files: the change (branchStatus), the check file as read, and with a check its
 * summary, drift and whether the file is committed. The check's lines are moved to where their code is today
 * (relocate, in memory: the file is rewritten only when it is saved anyway).
 */
function gatherStatus(repo: string, { base, cfg, env }: { base?: string; cfg: Config; env: NodeJS.ProcessEnv }): Gathered {
  const st = branchStatus(repo, { base, cfg, env })
  const read: ReadResult = st.exists ? readOrExplain(repo, st.file) : notInTree(repo, st.file)
  if (!read.check) return { ...st, ...read }
  const check = read.check
  relocate(repo, check)
  const drift = driftOf(repo, check, 'HEAD', st.change, cfg.exempt, st.base)
  // With uncommitted edits too: the drift CI will see once they are pushed.
  const pending = driftOf(repo, check, undefined, st.change, cfg.exempt, st.base)
  const porcelain = gitOk(repo, ['status', '--porcelain', '--', st.file]) ?? ''
  const dirty = !!porcelain
  // A new file: `git commit -a` leaves it out (the reason a finished check never reached CI).
  const untracked = porcelain.startsWith('??')
  return { ...st, check, summary: summarize(check, cfg), drift, pending, dirty, ...(untracked ? { untracked } : {}) }
}

/** The branch, its check file's name, the change: from the merge base with `base`, or a stack's parent's check. */
function branchStatus(repo: string, { base, cfg, env }: { base?: string; cfg: Config; env: NodeJS.ProcessEnv }): Gathered {
  const branch = currentBranch(repo, env)
  const rel = fileFor(branch)
  const baseRef = base ?? defaultBase(repo)
  const head = gitOk(repo, ['rev-parse', 'HEAD'])
  const mb0 = baseRef && head ? mergeBase(repo, baseRef, head) : undefined
  // Stacked on a branch whose check is committed here: the change starts after that check's code.
  const stack = stackBase(repo, mb0, head, rel)
  const mb = stack?.base ?? mb0
  // Code lines, committed and uncommitted.
  const change: CodeStat = mb ? codeStat(repo, mb, undefined, cfg.exempt) : { files: 0, added: 0, removed: 0, exempt: [], exemptOnly: false }
  return {
    branch, file: rel, base: mb, baseRef, head, change, changed: linesOf(change), exists: fs.existsSync(path.join(repo, rel)),
    ...(stack ? { stackedOn: stack.branch } : {}),
    ...(isDefaultBranch(repo, branch, baseRef) ? { onBase: true } : {}),
  }
}

/** No check file in the tree: `{ stashed }` when a git stash holds it (`git stash -u`; said, never "Start": a new check would clash with the pop). */
function notInTree(repo: string, rel: string): ReadResult {
  const stash = stashedIn(repo, rel)
  return stash ? { stashed: stash } : {}
}

/**
 * The check file, `{ check }`, or why it can't be used, as the status says it: `{ errors, conflict }` for git conflict
 * markers (a merge, two people answering on one branch: where, and whether both sides merge), `{ errors }` when it
 * isn't JSON or isn't valid.
 */
function readOrExplain(repo: string, rel: string): ReadResult {
  const abs = path.join(repo, rel)
  const conflict = conflictOf(fs.readFileSync(abs, 'utf8'))
  if (conflict) return { errors: [`${rel} has a merge conflict`], conflict: { line: conflict.line, mergeable: !!conflict.merged } }
  let check: Check
  try {
    check = readCheck(abs)
  } catch (e) {
    return { errors: [`${rel} is not valid JSON (${(e as Error).message})`] }
  }
  const errors = validateCheck(check, { repo })
  return errors.length ? { errors: [`${rel}: ${errors[0]}`] } : { check }
}

/**
 * Where the check stands, in one word: what the status bar, the Check view, `status` and CI all show.
 *   nothing   no check needed (`exemptOnly`: only exempt files changed)
 *   none      no check yet (`changed` lines)
 *   invalid   the file can't be read or is not valid (`why`)
 *   drift     the change grew past maxDrift by `grew` lines (`commitFirst`: only uncommitted lines put it over)
 *   answering a question is not done yet
 *   short     every question done, too few passed
 *   done      the rule is met: every question done (pass, explained, restated) and `needed` passed
 * With a check: `passed`, `done`, `total`, `needed`, `maxDrift`, `grew`. `st`: the facts (StateFacts).
 */
export function checkState(st: StateFacts | undefined, cfg: Config = DEFAULTS): CheckPosition {
  if (!st) return { phase: 'none', changed: 0 }
  if (!st.exists) return noFileState(st, cfg)
  if (st.errors?.length || !st.summary) return { phase: 'invalid', why: st.errors?.[0] ?? 'the file is not valid', ...(st.conflict ? { conflict: st.conflict } : {}) }
  const s = st.summary
  const committed = st.drift?.lines ?? 0
  const pending = st.pending?.lines ?? 0
  const base = { passed: s.passed, done: s.done, total: s.total, needed: s.needed, maxDrift: cfg.maxDrift, grew: Math.max(committed, pending) }
  if (committed > cfg.maxDrift) return { ...base, phase: 'drift', commitFirst: false }
  if (pending > cfg.maxDrift) return { ...base, phase: 'drift', commitFirst: true }
  return { ...base, phase: s.done < s.total ? 'answering' : s.met ? 'done' : 'short' }
}

/** No check file in the tree: in a stash, no check needed (nothing changed), or none yet (with its size). */
function noFileState(st: StateFacts, cfg: Config): CheckPosition {
  if (st.stashed) return { phase: 'stashed', stash: st.stashed }
  const renamed = !!st.change?.renamed?.length
  if (st.small || (!st.changed && !renamed)) return { phase: 'nothing', changed: st.changed ?? 0, exemptOnly: !!st.change?.exemptOnly }
  const kind = changeKind(st.change)
  return {
    phase: 'none',
    changed: st.changed,
    want: st.change ? questionsForChange(st.change, cfg) : questionsFor(st.changed!, cfg),
    ...(kind === 'docs' ? { docs: true } : kind === 'removal' ? { removal: true } : {}),
  }
}

/**
 * The words for a state, short and the same on every surface: `bar` (status bar), `title` (the Check view's header),
 * `line` (the next step: `status`, the view, the status bar's tooltip), `rule` ("Answer all 5 · 3 must pass").
 * `tone`: ok | warn | todo. `st`: for the branch name and whether the file has uncommitted changes.
 */
export function stateWords(state: CheckPosition, st: Partial<BranchStatus> = {}): Words {
  const rule = state.total ? ruleText(state) : ''
  const words: Omit<Words, 'rule'> = Object.hasOwn(PHASE, state.phase) ? PHASE[state.phase].words(state, st, st.branch ?? 'this branch', rule) : { tone: 'todo', bar: '', title: '', line: '' }
  return { ...words, rule }
}

/**
 * Code lines the change gained since the questions were written. `base`: the branch's merge base now; the branch's
 * own change is compared (freshLines), so merging the target branch in counts nothing. `to`: a commit, or undefined
 * for the working tree. Without `base` or the check's commits: lines changed since `check.head`, or (`approx`) the
 * change's size now (`nowStat`) against the size recorded in the file.
 */
export function driftOf(repo: string, check: Check, to: string | undefined, nowStat: CodeStat | undefined, exempt: string[] = [], base?: string): Drift {
  const fresh = freshLines(repo, check, base, to, exempt)
  if (fresh) return { lines: fresh.length, approx: false }
  if (!base && hasCommit(repo, check.head)) return { lines: linesOf(codeStat(repo, check.head, to, exempt)), approx: false }
  const was = check.diffStat ? linesOf(check.diffStat) : 0
  return { lines: nowStat ? Math.abs(linesOf(nowStat) - was) : 0, approx: true }
}


/**
 * The question to answer next: the first one not done (to answer, try again, or not graded yet). An explained one is
 * done; saying it back is optional.
 */
export const nextQuestion = (check: Check): Question | undefined => (check.questions ?? []).find((q) => !isDone(stateOf(q)))


/** Records the informational result in the file. */
export function stamp(check: Check, cfg?: Config): Check {
  const s = summarize(check, cfg)
  check.result = { done: s.done, passed: s.passed, total: s.total, needed: s.needed, verdict: s.met ? 'pass' : 'fail', at: new Date().toISOString() }
  return check
}
