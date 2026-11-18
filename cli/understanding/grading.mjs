// Grading an answer (local only): what the grader sees, its prompt, reading its reply, recording the grade.
import fs from 'node:fs'
import path from 'node:path'
import { VERDICTS } from './constants.mjs'
import { diffText } from './diff.mjs'
import { addAttempt, attemptHash } from './checkFile.mjs'
import { isDone, stateOf } from './state.mjs'
import { graderPrompt } from './graderPrompt.mjs'
import { runGrader } from './graderBackends.mjs'

const MAX_DIFF = 60_000

/** The lines around a question with their numbers (the anthropic backend can't read files). */
export function codeWindow(repo, q, pad = 30) {
  let lines
  try { lines = fs.readFileSync(path.join(repo, q.file), 'utf8').split('\n') } catch { return '' }
  const [s, e] = q.target === 'file' || !q.start ? [1, Math.min(lines.length, 200)] : [Math.max(1, q.start - pad), Math.min(lines.length, q.end + pad)]
  const own = lines.slice(s - 1, e).map((l, i) => `${String(s + i).padStart(5)}  ${l}`).join('\n')
  // The unchanged code the question depends on, each with its file's name.
  const also = (q.also ?? []).map((x) => { const w = codeWindow(repo, { file: x.file, start: x.start, end: x.end }, 3); return w && `\n${x.file}:\n${w}` }).filter(Boolean)
  return [own, ...also].join('\n')
}

/** The diff a grader sees: the question's file first, the rest after, cut at MAX_DIFF characters (and it says so). */
export function diffForGrader(diff, file) {
  const parts = diff.split(/(?=^diff --git )/m)
  const mine = parts.filter((p) => p.includes(` b/${file}\n`))
  const rest = parts.filter((p) => !mine.includes(p))
  let out = [...mine, ...rest].join('')
  if (out.length > MAX_DIFF) out = `${out.slice(0, MAX_DIFF)}\n… (the rest of the diff is cut here; read the files if you need them)`
  return out
}

/** The texts of the check's other questions not done yet (the grader must not answer them). */
export const openOthers = (check, q) => (check.questions ?? []).filter((x) => x.id !== q.id && !isDone(stateOf(x))).map((x) => x.text)

/**
 * Whether a concern only repeats the feedback: the same words as the feedback, or a part of it (letters and digits
 * compared, case and punctuation ignored, "Right:" / "Mostly right." left out).
 */
export function repeats(concern, feedback) {
  const norm = (t) => String(t ?? '').replace(/^\s*(right|mostly right|correct|yes)\b[.!:,]?\s*/i, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
  const c = norm(concern), f = norm(feedback)
  return !c || f.includes(c)
}

/**
 * The grader's reply as `{ verdict, feedback, hint, note?, topic?, concern? }` (throws when there is none). A first try
 * is never "explained", a later one never "retry"; a restatement is "restated" or "explained".
 */
export function parseVerdict(text, attempt = 1, { restate = false } = {}) {
  const s = String(text ?? '')
  const cands = [...s.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((m) => m[1])
  const a = s.indexOf('{'), b = s.lastIndexOf('}')
  if (a >= 0 && b > a) cands.push(s.slice(a, b + 1))
  for (const c of cands) {
    let v
    try { v = JSON.parse(c) } catch { continue }
    if (!v || !VERDICTS.includes(v.verdict)) continue
    let verdict = v.verdict
    if (restate) verdict = verdict === 'pass' || verdict === 'restated' ? 'restated' : 'explained'
    else {
      if (verdict === 'restated') verdict = 'pass'
      if (attempt >= 2 && verdict === 'retry') verdict = 'explained'
      if (attempt < 2 && verdict === 'explained') verdict = 'retry'
    }
    const str = (x) => String(x ?? '').trim()
    const out = { verdict, feedback: str(v.feedback), hint: verdict === 'retry' ? str(v.hint) : '' }
    if (str(v.note) && verdict !== 'retry') out.note = str(v.note)
    // A pass that corrects something: worth discussing on the merge request.
    if (verdict === 'pass' && v.partial === true) out.partial = true
    if (str(v.topic) && (verdict === 'explained' || out.partial)) out.topic = str(v.topic)
    // A concern is about the code; one that only repeats the feedback (a confirmation, a reassurance) is dropped.
    if (str(v.concern) && !repeats(str(v.concern), out.feedback)) out.concern = str(v.concern)
    // Links whose phrase is in the text (verbatim); their lines are checked against the files by codeLinksIn().
    const said = [out.feedback, out.hint, out.concern ?? ''].join('\n')
    const links = (Array.isArray(v.links) ? v.links : []).filter((l) => l && typeof l.phrase === 'string' && l.phrase.trim() && said.includes(l.phrase.trim()) && typeof l.file === 'string' && Number.isInteger(l.start) && l.start >= 1)
      .slice(0, 3).map((l) => ({ phrase: l.phrase.trim(), file: l.file.replace(/^\.\//, ''), start: l.start, end: Number.isInteger(l.end) && l.end >= l.start ? l.end : l.start }))
    if (links.length) out.links = links
    return out
  }
  throw new Error(`the grader didn't reply with a verdict: ${s.trim().slice(0, 200) || '(nothing)'}`)
}

/**
 * Code links whose lines are in the repository (`read(file)`: its lines, the working tree's by default):
 * `{ phrase, file, start, end, text }` (`text`: the first line, to find
 * them again after edits, as journey links do). Links to a missing file or past its end are dropped; the words stay.
 */
export function codeLinksIn(repo, links, read = (f) => fs.readFileSync(path.join(repo, f), 'utf8').split(/\r?\n/)) {
  const out = []
  for (const l of Array.isArray(links) ? links : []) {
    if (!l || typeof l.file !== 'string' || path.isAbsolute(l.file) || l.file.split(/[\\/]/).includes('..')) continue
    let lines
    try { lines = read(l.file) } catch { continue }
    if (!Number.isInteger(l.start) || l.start < 1 || l.end > lines.length || l.end < l.start) continue
    out.push({ phrase: l.phrase, file: l.file, start: l.start, end: l.end, text: lines[l.start - 1] })
  }
  return out
}

/** How to grade a question's latest answer: its attempt number, and the explanation when it is a restatement. */
export function gradeMode(q) {
  const as = q.attempts ?? []
  const last = as[as.length - 1]
  const before = as.filter((x) => x !== last && x.verdict)
  const ex = before.find((x) => x.verdict === 'explained')
  return { attempt: before.length + 1, ...(ex ? { explanation: ex.feedback ?? '' } : {}) }
}


/** The tour as numbered lines for the grader: "3. The API refuses a used code (api/discounts.ts:40-52)". */
export function tourText(check) {
  const steps = Array.isArray(check?.journey?.steps) ? check.journey.steps : []
  return steps.map((s, i) => `${i + 1}. ${s.title} (${s.file}:${s.range?.start}-${s.range?.end})`).join('\n')
}


/** Grades the latest attempt of `q` in place (verdict, feedback, hint, hash). */
export async function gradeQuestion(repo, check, q, { backend, model, env, diff } = {}) {
  const as = q.attempts ?? []
  const a = as[as.length - 1]
  if (!a) throw new Error(`${q.id} has no answer`)
  const d = diff ?? diffText(repo, check.base ?? check.head, undefined)
  const mode = gradeMode(q)
  const prompt = graderPrompt({ q, answer: a.answer, ...mode, diff: diffForGrader(d, q.file), code: codeWindow(repo, q), canRead: backend === 'claude', tour: tourText(check), others: openOthers(check, q) })
  const text = await runGrader(backend, { prompt, repo, model, env })
  return applyGrade(repo, q, a, text)
}

/**
 * The grader's reply (`text`) recorded on attempt `a` of `q`, as the extension records it: the verdict fixed by the
 * attempt (parseVerdict), links to lines that are there, the time, the hash; a concern kept on the question (its flag
 * survives a later grade).
 */
export function applyGrade(repo, q, a, text) {
  const mode = gradeMode(q)
  const v = parseVerdict(text, mode.attempt, { restate: mode.explanation !== undefined })
  if (v.links) { v.links = codeLinksIn(repo, v.links); if (!v.links.length) delete v.links }
  Object.assign(a, v, { gradedAt: new Date().toISOString() })
  a.hash = attemptHash(q, a)
  if (v.concern) q.concern = { text: v.concern, flagged: q.concern?.flagged ?? false, at: a.gradedAt }
  return a
}

/** The grader's prompt for an answer to `q` (not recorded): what Claude Code follows when it grades in a chat. */
export function promptFor(repo, check, q, answer) {
  const c = structuredClone(check)
  const cq = c.questions.find((x) => x.id === q.id)
  addAttempt(c, cq, answer)
  let diff = ''
  try { diff = diffText(repo, check.base ?? check.head, undefined) } catch { /* the grader reads the code */ }
  return graderPrompt({ q: cq, answer, ...gradeMode(cq), diff: diffForGrader(diff, cq.file), code: codeWindow(repo, cq), canRead: true, tour: tourText(c), others: openOthers(c, cq) })
}
