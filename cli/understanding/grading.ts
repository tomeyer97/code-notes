// Grading an answer (local only): what the grader sees, its prompt, reading its reply, recording the grade.
import fs from 'node:fs'
import path from 'node:path'
import { STATE, VERDICTS } from './constants'
import { diffOrEmpty, diffText } from './diff'
import { addAttempt, attemptHash } from './checkFile'
import { isDone, stateOf } from './state'
import { graderPrompt } from './graderPrompt'
import { runGrader } from './graderBackends'
import type { Attempt, Check, Link, ParsedVerdict, Question, Verdict } from './types'

const MAX_DIFF = 60_000

/** The lines around a question with their numbers (the anthropic backend can't read files). */
export function codeWindow(repo: string, q: Question, pad = 30): string {
  let lines: string[]
  try { lines = fs.readFileSync(path.join(repo, q.file), 'utf8').split('\n') } catch { return '' }
  const [s, e] = q.target === 'file' || !q.start ? [1, Math.min(lines.length, 200)] : [Math.max(1, q.start - pad), Math.min(lines.length, q.end! + pad)]
  const own = lines.slice(s - 1, e).map((l, i) => `${String(s + i).padStart(5)}  ${l}`).join('\n')
  // The unchanged code the question depends on, each with its file's name.
  const also = (q.also ?? []).map((x) => { const w = codeWindow(repo, { file: x.file, start: x.start, end: x.end } as Question, 3); return w && `\n${x.file}:\n${w}` }).filter(Boolean)
  return [own, ...also].join('\n')
}

/** The diff a grader sees: the question's file first, the rest after, cut at MAX_DIFF characters (and it says so). */
export function diffForGrader(diff: string, file: string): string {
  const parts = diff.split(/(?=^diff --git )/m)
  const mine = parts.filter((p) => p.includes(` b/${file}\n`))
  const rest = parts.filter((p) => !mine.includes(p))
  let out = [...mine, ...rest].join('')
  if (out.length > MAX_DIFF) out = `${out.slice(0, MAX_DIFF)}\n… (the rest of the diff is cut here; read the files if you need them)`
  return out
}

/** The texts of the check's other questions not done yet (the grader must not answer them). */
export const openOthers = (check: Check, q: Question): string[] => (check.questions ?? []).filter((x) => x.id !== q.id && !isDone(stateOf(x))).map((x) => x.text)

/** The grader's courtesy opener ("Right.", "Mostly right:", "Correct!", "Yes,"): the feedback without it. */
export const stripCourtesy = (t: unknown): string => String(t ?? '').replace(/^\s*(right|mostly right|correct|yes)\b[.!:,]?\s*/i, '')

/**
 * Whether a concern only repeats the feedback: the same words as the feedback, or a part of it (letters and digits
 * compared, case and punctuation ignored, the courtesy opener left out).
 */
export function repeats(concern: string, feedback: string): boolean {
  const norm = (t: string | undefined): string => stripCourtesy(t).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
  const c = norm(concern), f = norm(feedback)
  return !c || f.includes(c)
}

/**
 * The verdict that counts, from the grader's (`raw`) and the attempt: the attempt number decides between "retry" and
 * "explained" (the prompt asks for the right one, graderPrompt's replyFormat; this holds when the model slips).
 *
 *   raw         first try   later try   restatement
 *   pass        pass        pass        restated
 *   restated    pass        pass        restated
 *   retry       retry       explained   explained
 *   explained   retry       explained   explained
 */
export function normalizeVerdict(raw: Verdict, { attempt, restate }: { attempt: number; restate: boolean }): Verdict {
  const passed = raw === STATE.pass || raw === STATE.restated
  if (restate) return passed ? STATE.restated : STATE.explained
  if (passed) return STATE.pass
  return attempt >= 2 ? STATE.explained : STATE.retry
}

/**
 * The grader's reply as `{ verdict, feedback, hint, note?, topic?, concern? }` (throws when there is none). The
 * verdict is normalizeVerdict's: a first try is never "explained", a later one never "retry"; a restatement is
 * "restated" or "explained".
 */
export function parseVerdict(text: string, attempt = 1, { restate = false }: { restate?: boolean } = {}): ParsedVerdict {
  const s = String(text ?? '')
  const cands = [...s.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((m) => m[1])
  const a = s.indexOf('{'), b = s.lastIndexOf('}')
  if (a >= 0 && b > a) cands.push(s.slice(a, b + 1))
  for (const c of cands) {
    let v: any
    try { v = JSON.parse(c) } catch { continue }
    if (!v || !VERDICTS.includes(v.verdict)) continue
    const verdict = normalizeVerdict(v.verdict, { attempt, restate })
    const str = (x: unknown): string => String(x ?? '').trim()
    const out: ParsedVerdict = { verdict, feedback: str(v.feedback), hint: verdict === STATE.retry ? str(v.hint) : '' }
    if (str(v.note) && verdict !== STATE.retry) out.note = str(v.note)
    // A pass that corrects something: worth discussing on the merge request.
    if (verdict === STATE.pass && v.partial === true) out.partial = true
    if (str(v.topic) && (verdict === STATE.explained || out.partial)) out.topic = str(v.topic)
    // A concern is about the code; one that only repeats the feedback (a confirmation, a reassurance) is dropped.
    if (str(v.concern) && !repeats(str(v.concern), out.feedback)) out.concern = str(v.concern)
    // Links whose phrase is in the text (verbatim); their lines are checked against the files by codeLinksIn().
    const said = [out.feedback, out.hint, out.concern ?? ''].join('\n')
    const links = (Array.isArray(v.links) ? v.links : []).filter((l: any) => l && typeof l.phrase === 'string' && l.phrase.trim() && said.includes(l.phrase.trim()) && typeof l.file === 'string' && Number.isInteger(l.start) && l.start >= 1)
      .slice(0, 3).map((l: any): Link => ({ phrase: l.phrase.trim(), file: l.file.replace(/^\.\//, ''), start: l.start, end: Number.isInteger(l.end) && l.end >= l.start ? l.end : l.start }))
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
export function codeLinksIn(repo: string, links: unknown, read = (f: string): string[] => fs.readFileSync(path.join(repo, f), 'utf8').split(/\r?\n/)): Link[] {
  const out: Link[] = []
  for (const l of Array.isArray(links) ? links : []) {
    if (!l || typeof l.file !== 'string' || path.isAbsolute(l.file) || l.file.split(/[\\/]/).includes('..')) continue
    let lines: string[]
    try { lines = read(l.file) } catch { continue }
    if (!Number.isInteger(l.start) || l.start < 1 || l.end > lines.length || l.end < l.start) continue
    out.push({ phrase: l.phrase, file: l.file, start: l.start, end: l.end, text: lines[l.start - 1] })
  }
  return out
}

/** How to grade a question's latest answer: its attempt number, and the explanation when it is a restatement. */
export function gradeMode(q: Question): { attempt: number; explanation?: string } {
  const as = q.attempts ?? []
  const last = as[as.length - 1]
  const before = as.filter((x) => x !== last && x.verdict)
  const ex = before.find((x) => x.verdict === STATE.explained)
  return { attempt: before.length + 1, ...(ex ? { explanation: ex.feedback ?? '' } : {}) }
}


/** The tour as numbered lines for the grader: "3. The API refuses a used code (api/discounts.ts:40-52)". */
export function tourText(check: Check): string {
  const steps = Array.isArray(check?.journey?.steps) ? check.journey.steps : []
  return steps.map((s, i) => `${i + 1}. ${s.title} (${s.file}:${s.range?.start}-${s.range?.end})`).join('\n')
}


/** Grades the latest attempt of `q` in place (verdict, feedback, hint, hash). */
export async function gradeQuestion(repo: string, check: Check, q: Question, { backend, model, env, diff }: { backend?: string; model?: string | null; env?: NodeJS.ProcessEnv; diff?: string } = {}): Promise<Attempt> {
  const as = q.attempts ?? []
  const a = as[as.length - 1]
  if (!a) throw new Error(`${q.id} has no answer`)
  const d = diff ?? diffText(repo, check.base ?? check.head, undefined)
  const mode = gradeMode(q)
  const prompt = graderPrompt({ q, answer: a.answer!, ...mode, diff: diffForGrader(d, q.file), code: codeWindow(repo, q), canRead: backend === 'claude', tour: tourText(check), others: openOthers(check, q) })
  const text = await runGrader(backend, { prompt, repo, model, env })
  return applyGrade(repo, q, a, text)
}

/**
 * The grader's reply (`text`) recorded on attempt `a` of `q`, as the extension records it: the verdict fixed by the
 * attempt (parseVerdict), links to lines that are there, the time, the hash; a concern kept on the question (its flag
 * survives a later grade).
 */
export function applyGrade(repo: string, q: Question, a: Attempt, text: string): Attempt {
  const mode = gradeMode(q)
  const v = parseVerdict(text, mode.attempt, { restate: mode.explanation !== undefined })
  return recordGrade(repo, q, a, v, new Date().toISOString())
}

/** The grade's fields an attempt keeps (recordGrade copies these and nothing else), in the file's order. */
const GRADE_FIELDS = ['verdict', 'feedback', 'hint', 'note', 'partial', 'topic', 'concern', 'links'] as const satisfies readonly (keyof ParsedVerdict)[]

/**
 * Verdict `v` (parseVerdict's) recorded on attempt `a` of `q` at time `at`: its links to lines that are there, the
 * time, the hash; a concern kept on the question (its flag survives a later grade). The one implementation: the
 * extension records its grades with it too (src/check/cliApi.ts), after checking the attempt is still the one it graded.
 */
export function recordGrade(repo: string, q: Question, a: Attempt, v: ParsedVerdict, at: string): Attempt {
  if (v.links) {
    v.links = codeLinksIn(repo, v.links)
    if (!v.links.length) delete v.links
  }
  const grade = a as Pick<Attempt, (typeof GRADE_FIELDS)[number]>
  for (const k of GRADE_FIELDS) if (Object.hasOwn(v, k)) (grade as Record<string, unknown>)[k] = v[k]
  a.gradedAt = at
  a.hash = attemptHash(q, a)
  if (v.concern) q.concern = { text: v.concern, flagged: q.concern?.flagged ?? false, at: a.gradedAt }
  return a
}

/** The grader's prompt for an answer to `q` (not recorded): what Claude Code follows when it grades in a chat. */
export function promptFor(repo: string, check: Check, q: Question, answer: string): string {
  const c = structuredClone(check)
  const cq = c.questions.find((x) => x.id === q.id)!
  addAttempt(c, cq, answer)
  const diff = diffOrEmpty(repo, check.base ?? check.head)
  return graderPrompt({ q: cq, answer, ...gradeMode(cq), diff: diffForGrader(diff, cq.file), code: codeWindow(repo, cq), canRead: true, tour: tourText(c), others: openOthers(c, cq) })
}
