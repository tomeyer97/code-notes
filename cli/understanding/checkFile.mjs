// The check file (understanding/<branch>.json): where it is, its settings, reading and writing it, a conflict in
// it, and what an answer or a flag adds to it.
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { DEFAULTS, DIR } from './constants.mjs'
import { git, gitOk } from './git.mjs'

/** `feat/discount-codes` -> `feat-discount-codes` (the file name). */
export function slugOf(branch) {
  return String(branch).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/-{2,}/g, '-').replace(/^[-.]+|[-.]+$/g, '') || 'branch'
}
export const fileFor = (branch) => `${DIR}/${slugOf(branch)}.json`
/** Where a branch's check waits while another branch is checked out (git-ignored): put in place on its return. */
export const CACHE = '.code-notes/.cache/checks'
export const cachedFor = (branch) => `${CACHE}/${slugOf(branch)}.json`

/**
 * The two sides of a text with git conflict markers (`<<<<<<<`, `=======`, `>>>>>>>`): [ours, theirs], each the text
 * outside the conflicts plus that side's lines.
 */
export function conflictSides(text) {
  const lines = String(text).split('\n')
  const side = (keep) => {
    let at = 'both'
    const out = []
    for (const l of lines) {
      if (/^<{7}( |$)/.test(l)) at = 'ours'
      else if (/^={7}$/.test(l) && at === 'ours') at = 'theirs'
      else if (/^>{7}( |$)/.test(l)) at = 'both'
      else if (at === 'both' || at === keep) out.push(l)
    }
    return out.join('\n')
  }
  return [side('ours'), side('theirs')]
}

/**
 * Git conflict markers in a check file: the first marker's line, and (when both sides read as checks) the two merged:
 * every question once, each with the side that has more graded attempts (the newer one when even). Else undefined.
 */
export function conflictOf(text) {
  const first = String(text).split('\n').findIndex((l) => /^<{7}( |$)/.test(l))
  if (first < 0) return undefined
  const [oursText, theirsText] = conflictSides(text)
  let ours, theirs
  try { ours = JSON.parse(oursText); theirs = JSON.parse(theirsText) } catch { return { line: first + 1 } }
  const graded = (q) => (q?.attempts ?? []).filter((a) => a.verdict).length
  const last = (q) => String((q?.attempts ?? []).at(-1)?.gradedAt ?? (q?.attempts ?? []).at(-1)?.at ?? '')
  const byId = new Map((theirs.questions ?? []).map((q) => [q.id, q]))
  const questions = (ours.questions ?? []).map((q) => { const t = byId.get(q.id); byId.delete(q.id); return !t || graded(q) > graded(t) || (graded(q) === graded(t) && last(q) >= last(t)) ? q : t })
  return { line: first + 1, merged: { ...ours, questions: [...questions, ...byId.values()] } }
}

/**
 * The check's settings: understanding/config.json in the working tree, or (`at`) as committed there (CI judges a merge
 * request by its target branch's settings, never by the ones it brings). Missing or broken: the defaults.
 */
export function loadConfig(repo, { at } = {}) {
  let c = {}
  try { c = JSON.parse(at ? git(repo, ['show', `${at}:${DIR}/config.json`]) : fs.readFileSync(path.join(repo, DIR, 'config.json'), 'utf8')) } catch { /* none: defaults */ }
  if (!c || typeof c !== 'object' || Array.isArray(c)) c = {}
  const qs = typeof c.questions === 'number' ? { min: c.questions, max: c.questions } : c.questions ?? {}
  return { ...DEFAULTS, ...c, questions: { ...DEFAULTS.questions, ...qs }, exempt: Array.isArray(c.exempt) ? c.exempt.filter((g) => typeof g === 'string' && g) : [] }
}

/** Keys of understanding/config.json that are not settings (a typo, or one an older version had): ignored, and said. */
export function unknownSettings(repo) {
  let c
  try { c = JSON.parse(fs.readFileSync(path.join(repo, DIR, 'config.json'), 'utf8')) } catch { return [] }
  return c && typeof c === 'object' && !Array.isArray(c) ? Object.keys(c).filter((k) => !(k in DEFAULTS)) : []
}
const unknownLine = (keys) => `  ${DIR}/config.json: ${keys.map((k) => `"${k}"`).join(', ')} ${keys.length === 1 ? 'is not a setting' : 'are not settings'} (ignored).`

export function readCheck(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}
/** Writes in one step (a temp file, then a rename): a reader never sees half a file. */
export function writeCheck(file, check) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`)
  fs.writeFileSync(tmp, JSON.stringify(check, null, 2) + '\n')
  fs.renameSync(tmp, file)
}

/** Who is answering: git's user.name and user.email (either may be missing). */
export function gitIdentity(repo) {
  const name = gitOk(repo, ['config', 'user.name']), email = gitOk(repo, ['config', 'user.email'])
  return name || email ? { ...(name ? { name } : {}), ...(email ? { email } : {}) } : undefined
}
const sameWho = (a, b) => !!a && !!b && (a.email && b.email ? a.email === b.email : a.name === b.name)

/**
 * Adds an answer to a question; `by` only when someone other than the check's `answeredBy` answers. The earlier
 * attempts lose their answer text (pruneAttempts): only the final answer stays in the file.
 */
export function addAttempt(check, q, answer, who) {
  const a = { answer, at: new Date().toISOString() }
  if (who && !sameWho(who, check.answeredBy)) { if (!check.answeredBy) check.answeredBy = who; else a.by = who }
  ;(q.attempts ??= []).push(a)
  pruneAttempts(q)
  return a
}

/**
 * Only the final answer's text stays in the file: every attempt but the last loses `answer` and `hash` (a wrong guess
 * is never kept); its verdict, times, `by` and the grader's feedback, note, topic and concern stay. Call it whenever a
 * new attempt is added. Returns the question.
 */
export function pruneAttempts(q) {
  const as = Array.isArray(q?.attempts) ? q.attempts : []
  for (const a of as.slice(0, -1)) { if (a && typeof a === 'object') { delete a.answer; delete a.hash } }
  return q
}

/** The short hash a graded attempt carries: CI notices an answer or verdict changed after grading (a bad merge). */
export function attemptHash(question, attempt) {
  return createHash('sha256').update(`${question.text}\0${attempt.answer}\0${attempt.verdict}`, 'utf8').digest('hex').slice(0, 12)
}


/**
 * Flags a question's concern for the reviewer (the merge request lists it), as Flag for reviewer does in VS Code. A
 * question asked as "may be a bug" can be flagged once answered. Returns false when there is nothing to flag.
 */
export function flagConcern(check, q, who) {
  const answered = (q.attempts ?? []).some((a) => a.verdict)
  const text = q.concern?.text ?? (q.suspect && answered ? q.text : undefined)
  if (!text || q.concern?.dismissed || q.concern?.fixed) return false
  q.concern = { ...(q.concern ?? {}), text, flagged: true }
  if (who && check.answeredBy && !sameWho(who, check.answeredBy)) q.concern.by = who
  else delete q.concern.by
  return true
}

export { sameWho, unknownLine }
