// What a question and journey.py's check say, read without VS Code (unit-tested in test/writing.test.ts).

/** Fewer words than this is too vague to write a journey for. */
const MIN_WORDS = 3

/** Why `q` is too vague to send to Claude, or undefined when it is not (the question box's validation). */
export function vagueQuestion(q: string): string | undefined {
  const words = q.trim().split(/\s+/).filter(Boolean).length
  return words && words < MIN_WORDS ? 'Ask how something works, e.g. How does a note get saved?' : undefined
}

/** The question a job is listed by once you answered Claude's question about it. */
export const clarified = (question: string, reply: string) => `${question.trim()}: ${reply.trim().replace(/\s+/g, ' ')}`

/** journey.py check's PROBLEM lines, numbers masked (a moved line is not a new problem). */
export function problemsIn(out: string): Set<string> {
  return new Set(out.split('\n').filter((l) => l.startsWith('PROBLEM')).map((l) => l.replace(/\d+/g, '#')))
}

/** A PROBLEM line saying something points at code that is no longer there (a link, a value, a beat, the step). */
const CODE_GONE = /no longer (reads|exists)|its code changed/

/** journey.py check's PROBLEM lines saying the steps `steps` (1-based) point at code that is gone, as printed. Their
 *  other rule breaks (a title's wording, …) are the journey's own, older than the refresh. */
export function stepProblems(out: string, steps: readonly number[]): string[] {
  return out.split('\n').filter((l) => {
    const m = /^PROBLEM: step (\d+)[: ]/.exec(l)
    return !!m && steps.includes(Number(m[1])) && CODE_GONE.test(l)
  })
}

/** The steps of `lines` (stepProblems' lines), in order, once each. */
export const stepsOf = (lines: readonly string[]) =>
  [...new Set(lines.map((l) => Number(/^PROBLEM: step (\d+)/.exec(l)?.[1])))].sort((a, b) => a - b)
