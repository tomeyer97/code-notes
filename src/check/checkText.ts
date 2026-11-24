// A check file's text read as a check (a conflict's side, the version committed at HEAD), what changed between two
// versions of it, and a conflict's flags kept. No vscode here: unit-tested (test/checkText.test.ts).
import { validateCheck } from '../../cli/understanding/validate'
import type { Check, Question } from './types'

/** A check file's text as a check, by the CLI's rules (validateCheck); undefined: not JSON, or not a check. */
export function checkOfText(text: string): Check | undefined {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return undefined // not JSON: the caller says what that means
  }
  return validateCheck(value).length ? undefined : (value as Check)
}

/**
 * The fields of a check that change without a new answer: its tour, its result, and when it was written (older files
 * have `updatedAt`).
 */
const TOUR_AND_STAMP: readonly string[] = ['journey', 'result', 'updatedAt']

/** `a` and `b` say the same, apart from their tour, result and time (key order and undefined fields aside). */
export function sameExceptTour(a: Check, b: Check): boolean {
  const bare = (c: Check) => canonical({ ...c, ...Object.fromEntries(TOUR_AND_STAMP.map((k) => [k, undefined])) })
  return bare(a) === bare(b)
}

/** `now`'s only change from `was` is its tour (a tour that is new or different; the answers as committed). */
export function onlyTourChanged(was: Check, now: Check): boolean {
  if (!now.journey || canonical(was.journey ?? null) === canonical(now.journey)) return false
  return sameExceptTour(was, now)
}

/** JSON with every object's keys sorted: two values that are equal as JSON give the same text. */
function canonical(v: unknown): string {
  return JSON.stringify(v, (_k, x: unknown) => {
    if (!x || typeof x !== 'object' || Array.isArray(x)) return x
    return Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
  })
}

/** What the view says after Keep both (`kept`: the numbers of the questions whose flag was kept). */
export function keptBothLine(kept: number[]): string {
  if (!kept.length) return 'Both answers kept.'
  return `Both answers kept. Question ${kept.join(', ')}: its concern stays flagged (one side flagged it).`
}

/**
 * A concern flagged on either side of a conflict stays flagged in the merge (a flag is a request to a reviewer; a
 * dismissal can be redone). Returns the numbers of the questions whose flag was kept that way.
 */
export function keepFlags(merged: Check, sides: (Check | undefined)[]): number[] {
  const flagged = new Map<string, NonNullable<Question['concern']>>()
  for (const side of sides) {
    for (const q of side?.questions ?? []) if (q.concern?.flagged) flagged.set(q.id, q.concern)
  }
  const kept: number[] = []
  merged.questions.forEach((q, i) => {
    const f = flagged.get(q.id)
    if (!f || q.concern?.flagged) return
    q.concern = f
    kept.push(i + 1)
  })
  return kept
}
