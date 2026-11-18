// Where the check stands: each question's state, the pass rule, the branch's status (localStatus), the one
// state every surface shows (checkState) and its words (stateWords).
import fs from 'node:fs'
import path from 'node:path'
import { DEFAULTS } from './constants.mjs'
import { currentBranch, defaultBase, gitOk, hasCommit, isDefaultBranch, mergeBase, stackBase, stashedIn } from './git.mjs'
import { codeStat, freshLines, linesOf } from './diff.mjs'
import { changeKind, minutesFor, questionsFor, questionsForChange, sizeText } from './size.mjs'
import { conflictOf, fileFor, loadConfig, readCheck } from './checkFile.mjs'
import { validateCheck } from './validate.mjs'
import { relocate } from './anchors.mjs'

/**
 * One question's state, from its attempts: todo (no answer), ungraded, retry (try again), pass, explained (answered
 * by the grader), restated (explained, then said back rightly). Done: pass, explained or restated.
 */
export function stateOf(q) {
  const as = Array.isArray(q.attempts) ? q.attempts : []
  if (!as.length) return 'todo'
  if (as.some((a) => a.verdict === 'pass')) return 'pass'
  if (as.some((a) => a.verdict === 'restated')) return 'restated'
  if (as.some((a) => a.verdict === 'explained')) return 'explained'
  const last = as[as.length - 1]
  return last.verdict === 'retry' ? 'retry' : 'ungraded'
}

/** Passed questions needed out of `total`. */
export const needed = (total, ratio) => Math.max(1, Math.ceil(total * ratio - 1e-9))

export const isDone = (state) => state === 'pass' || state === 'explained' || state === 'restated'
export const isPassed = (state) => state === 'pass' || state === 'restated'

/**
 * The rule: every question done (pass, explained or restated; a "try again" is not done) AND ceil(passRatio × total)
 * passed (pass or restated). `met` is that rule; checkState says it in one word.
 */
export function summarize(check, cfg = DEFAULTS) {
  const states = check.questions.map(stateOf)
  const count = (s) => states.filter((x) => x === s).length
  const total = states.length
  const need = needed(total, cfg.passRatio)
  const passed = states.filter(isPassed).length
  const done = states.filter(isDone).length
  return { total, passed, done, explained: count('explained'), restated: count('restated'), retry: count('retry'), todo: count('todo'), ungraded: count('ungraded'),
    open: total - done, needed: need, met: done === total && passed >= need, states }
}

/** The rule in one phrase, the same everywhere. */
export const ruleText = (s) => `Answer all ${s.total} · ${s.needed} must pass`


/** Where the branch stands: what changed, the check file, whether it is still valid, where it stands (checkState). */
export function localStatus(repo, { base, cfg = loadConfig(repo), env = process.env } = {}) {
  const branch = currentBranch(repo, env)
  const rel = fileFor(branch)
  const abs = path.join(repo, rel)
  const baseRef = base ?? defaultBase(repo)
  const head = gitOk(repo, ['rev-parse', 'HEAD'])
  const mb0 = baseRef && head ? mergeBase(repo, baseRef, head) : undefined
  // Stacked on a branch whose check is committed here: the change starts after that check's code.
  const stack = stackBase(repo, mb0, head, rel)
  const mb = stack?.base ?? mb0
  // Code lines, committed and uncommitted.
  const change = mb ? codeStat(repo, mb, undefined, cfg.exempt) : { files: 0, added: 0, removed: 0, exempt: [], exemptOnly: false }
  const st = { branch, file: rel, base: mb, baseRef, head, change, changed: linesOf(change), exists: fs.existsSync(abs), ...(stack ? { stackedOn: stack.branch } : {}), ...(isDefaultBranch(repo, branch) ? { onBase: true } : {}) }
  const done = (x) => { const state = checkState(x, cfg); return { ...x, state, next: stateWords(state, x).line } }
  // Not in the tree, but in a git stash (`git stash -u`): said, never "Start" (a new check would clash with the pop).
  if (!st.exists) { const stash = stashedIn(repo, rel); return done(stash ? { ...st, stashed: stash } : st) }
  // Git conflict markers (a merge, two people answering on one branch): said so, with where, and whether both sides merge.
  const conflict = conflictOf(fs.readFileSync(abs, 'utf8'))
  if (conflict) return done({ ...st, errors: [`${rel} has a merge conflict`], conflict: { line: conflict.line, mergeable: !!conflict.merged } })
  let check
  try { check = readCheck(abs) } catch (e) { return done({ ...st, errors: [`${rel} is not valid JSON (${e.message})`] }) }
  const errors = validateCheck(check, { repo })
  if (errors.length) return done({ ...st, errors: [`${rel}: ${errors[0]}`] })
  relocate(repo, check) // today's line numbers (in memory: the file is rewritten only when it is saved anyway)
  const drift = driftOf(repo, check, 'HEAD', change, cfg.exempt, mb)
  // With uncommitted edits too: the drift CI will see once they are pushed.
  const pending = driftOf(repo, check, undefined, change, cfg.exempt, mb)
  const porcelain = gitOk(repo, ['status', '--porcelain', '--', rel]) ?? ''
  const dirty = !!porcelain
  // A new file: `git commit -a` leaves it out (the reason a finished check never reached CI).
  const untracked = porcelain.startsWith('??')
  return done({ ...st, check, summary: summarize(check, cfg), drift, pending, dirty, ...(untracked ? { untracked } : {}) })
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
 * With a check: `passed`, `done`, `total`, `needed`, `maxDrift`, `grew`. `st`: localStatus's shape (or for CI:
 * `{ exists: true, summary, drift }`).
 */
export function checkState(st, cfg = DEFAULTS) {
  if (!st) return { phase: 'none', changed: 0 }
  if (!st.exists && st.stashed) return { phase: 'stashed', stash: st.stashed }
  if (!st.exists) return st.small || (!st.changed && !st.change?.renamed?.length) ? { phase: 'nothing', changed: st.changed ?? 0, exemptOnly: !!st.change?.exemptOnly } : { phase: 'none', changed: st.changed, want: st.change ? questionsForChange(st.change, cfg) : questionsFor(st.changed, cfg), ...(changeKind(st.change) === 'docs' ? { docs: true } : changeKind(st.change) === 'removal' ? { removal: true } : {}) }
  if (st.errors?.length || !st.summary) return { phase: 'invalid', why: st.errors?.[0] ?? 'the file is not valid', ...(st.conflict ? { conflict: st.conflict } : {}) }
  const s = st.summary
  const base = { passed: s.passed, done: s.done, total: s.total, needed: s.needed, maxDrift: cfg.maxDrift, grew: Math.max(st.drift?.lines ?? 0, st.pending?.lines ?? 0) }
  if ((st.drift?.lines ?? 0) > cfg.maxDrift) return { ...base, phase: 'drift', commitFirst: false }
  if ((st.pending?.lines ?? 0) > cfg.maxDrift) return { ...base, phase: 'drift', commitFirst: true }
  return { ...base, phase: s.done < s.total ? 'answering' : s.met ? 'done' : 'short' }
}

/**
 * The words for a state, short and the same on every surface: `bar` (status bar), `title` (the Check view's header),
 * `line` (the next step: `status`, the view, the status bar's tooltip), `rule` ("Answer all 5 · 3 must pass").
 * `tone`: ok | warn | todo. `st`: for the branch name and whether the file has uncommitted changes.
 */
export function stateWords(state, st = {}) {
  const rule = state.total ? ruleText(state) : ''
  const branch = st.branch ?? 'this branch'
  switch (state.phase) {
    // The default branch: one line, no change to speak of.
    case 'nothing': if (st.onBase) return { tone: 'ok', bar: '', title: `${branch}: no check here`, line: '', rule }
      return { tone: 'ok', bar: '', title: 'No check needed', line: st.stackedOn ? `Covered by ${st.stackedOn}'s check.` : state.exemptOnly ? 'Only exempt files changed.' : 'No code lines changed.', rule }
    case 'stashed': return { tone: 'warn', bar: 'Understanding: in a stash', title: 'Your check is in a git stash', line: `Run git stash pop (${state.stash}).`, rule }
    case 'none': return { tone: 'todo', bar: 'Understanding: start', title: `No check yet for ${branch}`, line: `${!state.changed && st.change?.renamed?.length ? `Renamed, 0 lines changed (${st.change.renamed.map((r) => r.to.split('/').pop()).join(', ')})` : `${state.changed} ${state.docs ? 'line' : 'code line'}${state.changed === 1 ? '' : 's'} ${state.removal ? 'removed' : 'changed'}${state.docs ? ' (docs)' : ''}${st.stackedOn ? ` since ${st.stackedOn}'s check` : ''}`}${state.want ? ` · ${sizeText(state.want)}` : ''}.`, rule }
    case 'invalid': return state.conflict
      ? { tone: 'warn', bar: 'Understanding: merge conflict', title: 'The check file has a merge conflict', line: state.conflict.mergeable ? 'Both sides of the conflict can be kept.' : 'Open it at the conflict.', rule }
      : { tone: 'warn', bar: 'Understanding: fix the file', title: 'The check file is not valid', line: / is not valid JSON/.test(state.why) ? "It isn't valid JSON: open it." : `${state.why.replace(/^\S+\.json:\s*/, '')}.`, rule }
    case 'drift': return { tone: 'warn', bar: `Needs top-up: +${state.grew} lines`, title: `Needs top-up: +${state.grew} lines`,
      line: state.commitFirst ? 'Commit, then add 1–2 questions about the new lines.' : 'Add 1–2 questions about the new lines.', rule }
    case 'answering': return { tone: 'todo', bar: `Understanding ${state.done}/${state.total}`, title: `${state.done} of ${state.total} done`, line: `${rule} · ~${minutesFor(state.total - state.done)} min left.`, rule }
    case 'short': return { tone: 'warn', bar: `Understanding ${state.passed}/${state.needed} passed`, title: `${state.passed} passed, ${state.needed} must pass`,
      line: 'Say an explained answer back in your own words.', rule }
    case 'done': return { tone: 'ok', bar: '✓ Understanding', title: '✓ Done', line: st.untracked ? 'A new file: not committed yet.' : st.dirty ? 'Not committed yet.' : 'Committed.', rule }
    default: return { tone: 'todo', bar: '', title: '', line: '', rule }
  }
}

/**
 * Code lines the change gained since the questions were written. `base`: the branch's merge base now; the branch's
 * own change is compared (freshLines), so merging the target branch in counts nothing. `to`: a commit, or undefined
 * for the working tree. Without `base` or the check's commits: lines changed since `check.head`, or (`approx`) the
 * change's size now (`nowStat`) against the size recorded in the file.
 */
export function driftOf(repo, check, to, nowStat, exempt = [], base) {
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
export const nextQuestion = (check) => (check.questions ?? []).find((q) => !isDone(stateOf(q)))


/** Records the informational result in the file. */
export function stamp(check, cfg) {
  const s = summarize(check, cfg)
  check.result = { done: s.done, passed: s.passed, total: s.total, needed: s.needed, verdict: s.met ? 'pass' : 'fail', at: new Date().toISOString() }
  return check
}
