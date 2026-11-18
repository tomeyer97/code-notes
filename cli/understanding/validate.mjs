// What is wrong with a check file: its format, its tour's, and answers changed after grading.
import fs from 'node:fs'
import path from 'node:path'
import { KINDS, MAX_QUESTIONS, MAX_TOUR_STEPS, VERDICTS } from './constants.mjs'
import { attemptHash } from './checkFile.mjs'

const isHex = (s, min = 7) => typeof s === 'string' && new RegExp(`^[0-9a-f]{${min},64}$`).test(s)

/** Optional code links in a question's or a reply's text: `[{ phrase, file, start, end }]`, checked lightly. */
function linksBad(links, at, errs) {
  if (links === undefined) return
  const ok = Array.isArray(links) && links.every((l) => l && typeof l === 'object' && typeof l.phrase === 'string' && typeof l.file === 'string'
    && Number.isInteger(l.start) && Number.isInteger(l.end) && l.start > 0 && l.end > 0)
  if (!ok) errs.push(`${at} must be a list of { "phrase", "file", "start", "end" }`)
}

/** What is wrong with a check file (an empty list: nothing). `repo`: also check that each question's file exists. */
export function validateCheck(c, { repo } = {}) {
  const errs = []
  if (!c || typeof c !== 'object' || Array.isArray(c)) return ['not a JSON object']
  if (c.version !== 1) errs.push(`"version" is ${JSON.stringify(c.version)}: expected 1`)
  if (typeof c.branch !== 'string' || !c.branch) errs.push('"branch" is missing')
  if (!isHex(c.head)) errs.push('"head" must be a commit sha')
  if (c.base !== undefined && !isHex(c.base)) errs.push('"base" must be a commit sha')
  const whoBad = (w) => !w || typeof w !== 'object' || Array.isArray(w) || (w.name !== undefined && typeof w.name !== 'string') || (w.email !== undefined && typeof w.email !== 'string') || (!w.name && !w.email)
  if (c.answeredBy !== undefined && whoBad(c.answeredBy)) errs.push('"answeredBy" must be { "name": …, "email": … }')
  if (!Array.isArray(c.questions) || !c.questions.length) return [...errs, '"questions" must be a non-empty array']
  if (c.questions.length > MAX_QUESTIONS) errs.push(`${c.questions.length} questions: at most ${MAX_QUESTIONS}`)
  // Optional: older files have no journey, and CI never needs one.
  if (c.journey !== undefined) for (const e of tourProblems(c.journey)) errs.push(`journey: ${e}`)
  // The change's text describes no code: no tour, on purpose.
  if (c.noTour !== undefined && c.noTour !== true) errs.push('"noTour" must be true or left out')
  const tourSteps = Array.isArray(c.journey?.steps) ? c.journey.steps.length : 0
  const ids = new Set()
  c.questions.forEach((q, i) => {
    const at = `question ${i + 1}${q && typeof q.id === 'string' ? ` (${q.id})` : ''}`
    if (!q || typeof q !== 'object') { errs.push(`${at}: not an object`); return }
    if (typeof q.id !== 'string' || !/^q\d+$/.test(q.id)) errs.push(`${at}: "id" must look like q1`)
    else if (ids.has(q.id)) errs.push(`${at}: id used twice`)
    ids.add(q.id)
    if (!KINDS.includes(q.kind)) errs.push(`${at}: "kind" must be one of ${KINDS.join(', ')}`)
    if (typeof q.text !== 'string' || q.text.trim().length < 10) errs.push(`${at}: "text" is missing or too short`)
    else if (q.text.length > 400) errs.push(`${at}: "text" is longer than 400 characters`)
    if (typeof q.file !== 'string' || !q.file || path.isAbsolute(q.file) || q.file.split(/[\\/]/).includes('..')) errs.push(`${at}: "file" must be a path inside the repository`)
    else if (repo && !fs.existsSync(path.join(repo, q.file))) errs.push(`${at}: ${q.file} doesn't exist`)
    if (q.target === 'file') { /* a design question: no lines */ }
    else if (q.target !== undefined) errs.push(`${at}: "target" must be "file" or left out`)
    else if (!Number.isInteger(q.start) || !Number.isInteger(q.end) || q.start < 1 || q.end < q.start) errs.push(`${at}: "start"/"end" must be 1-based lines (or "target": "file")`)
    if (q.anchor !== undefined && (typeof q.anchor !== 'object' || q.anchor === null || q.anchor.v !== 3 || typeof q.anchor.head !== 'string')) errs.push(`${at}: "anchor" must be a compact anchor ({ "v": 3, "head": … })`)
    // The question writer thinks the honest answer is "this is a bug".
    if (q.suspect !== undefined && typeof q.suspect !== 'boolean') errs.push(`${at}: "suspect" must be true or false`)
    // A concern about the code found during the check; `flagged`: the author put it on the merge request.
    if (q.concern !== undefined && (!q.concern || typeof q.concern !== 'object' || typeof q.concern.text !== 'string' || (q.concern.flagged !== undefined && typeof q.concern.flagged !== 'boolean'))) errs.push(`${at}: "concern" must be { "text": …, "flagged": true | false }`)
    // Unchanged code the answer depends on (shown beside the question).
    if (q.also !== undefined) {
      const okPath = (f) => typeof f === 'string' && !!f && !path.isAbsolute(f) && !f.split(/[\\/]/).includes('..')
      if (!Array.isArray(q.also) || q.also.length > 3) errs.push(`${at}: "also" must be a list of at most 3 { "file", "start", "end" }`)
      else if (q.also.some((x) => !x || !okPath(x.file) || !Number.isInteger(x.start) || !Number.isInteger(x.end) || x.start < 1 || x.end < x.start)) errs.push(`${at}: each "also" needs a file inside the repository and 1-based start/end`)
      else if (repo) for (const x of q.also) if (!fs.existsSync(path.join(repo, x.file))) errs.push(`${at}: ${x.file} doesn't exist`)
    }
    linksBad(q.links, `${at}: "links"`, errs)
    // The tour step after which its answer is visible.
    if (q.step !== undefined) {
      if (!Number.isInteger(q.step) || q.step < 1) errs.push(`${at}: "step" must be a step number of the journey`)
      else if (!tourSteps) errs.push(`${at}: "step" ${q.step}, but the check has no journey`)
      else if (q.step > tourSteps) errs.push(`${at}: "step" ${q.step}, but the journey has ${tourSteps} steps`)
    }
    if (q.attempts !== undefined && !Array.isArray(q.attempts)) errs.push(`${at}: "attempts" must be an array`)
    for (const [k, a] of (Array.isArray(q.attempts) ? q.attempts : []).entries()) {
      // Only the last attempt must keep its answer (earlier ones may have had it pruned; older files still have it).
      const last = k === q.attempts.length - 1
      if (!a || typeof a !== 'object' || (last ? typeof a.answer !== 'string' : a.answer !== undefined && typeof a.answer !== 'string')) { errs.push(`${at}, attempt ${k + 1}: "answer" must be a string`); continue }
      linksBad(a.links, `${at}, attempt ${k + 1}: "links"`, errs)
      if (a.by !== undefined && whoBad(a.by)) errs.push(`${at}, attempt ${k + 1}: "by" must be { "name": …, "email": … }`)
      if (a.verdict !== undefined && !VERDICTS.includes(a.verdict)) errs.push(`${at}, attempt ${k + 1}: "verdict" must be one of ${VERDICTS.join(', ')}`)
    }
  })
  return errs
}

/**
 * What is wrong with a check's journey (the tour of the change, in the journey file format v2; docs/journey-format.md),
 * checked lightly: the shape the extension needs to walk it. `journey.py check` holds the writing rules. A step whose
 * file is gone later is not a problem here (the extension shows it as stale): CI never fails over the tour's code.
 */
export function tourProblems(j) {
  if (!j || typeof j !== 'object' || Array.isArray(j)) return ['not an object']
  const errs = []
  if (j.version !== 2 && j.version !== 3) errs.push(`"version" is ${JSON.stringify(j.version)}: expected 2`)
  if (typeof j.title !== 'string' || !j.title.trim()) errs.push('"title" is missing')
  const ids = new Set(Array.isArray(j.nodes) ? j.nodes.filter((n) => n && typeof n.id === 'string').map((n) => n.id) : [])
  if (!ids.size) errs.push('"nodes" must be a non-empty array of boxes with ids')
  if (!Array.isArray(j.steps) || !j.steps.length) return [...errs, '"steps" must be a non-empty array']
  if (j.steps.length > MAX_TOUR_STEPS) errs.push(`${j.steps.length} steps: at most ${MAX_TOUR_STEPS}`)
  const okPath = (f) => typeof f === 'string' && !!f && !path.isAbsolute(f) && !f.split(/[\\/]/).includes('..')
  j.steps.forEach((s, i) => {
    const at = `step ${i + 1}`
    if (!s || typeof s !== 'object') { errs.push(`${at}: not an object`); return }
    if (typeof s.title !== 'string' || !s.title.trim()) errs.push(`${at}: "title" is missing`)
    if (!ids.has(s.node)) errs.push(`${at}: "node" ${JSON.stringify(s.node)} is not a box of the map`)
    if (!okPath(s.file)) errs.push(`${at}: "file" must be a path inside the repository`)
    if (!s.range || !Number.isInteger(s.range.start) || !Number.isInteger(s.range.end) || s.range.start < 1 || s.range.end < s.range.start) errs.push(`${at}: "range" must be { "start", "end" } (1-based lines)`)
  })
  return errs
}


/** Graded attempts whose hash doesn't match (or is missing): "q2 attempt 1". */
export function hashProblems(check) {
  // Only each question's last attempt keeps its answer, so only it can be verified; earlier hashes are not checked.
  const out = []
  for (const q of check.questions) {
    const as = q.attempts ?? []
    const a = as[as.length - 1]
    if (a?.verdict && a.hash !== attemptHash(q, a)) out.push(`${q.id} attempt ${as.length}`)
  }
  return out
}

export { isHex }
