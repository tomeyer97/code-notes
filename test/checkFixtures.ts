// The understanding check's test data: questions in a given state, a check of them, and where a branch stands with
// it. The summary is the CLI's own (summarize), so its rule is written once.
import { summarize } from '../cli/understanding/state'
import type { Attempt, BranchStatus, Check, QState, Question, Words } from '../src/check/types'

/** Attempts that put a question in each state (the CLI's stateOf reads them). */
export const ATTEMPTS_IN: Record<QState, Attempt[]> = {
  todo: [],
  ungraded: [{ answer: 'a' }],
  pass: [{ answer: 'a', verdict: 'pass', feedback: 'Right.' }],
  retry: [{ answer: 'a', verdict: 'retry', feedback: 'Close.' }],
  explained: [{ answer: 'a', verdict: 'explained', feedback: 'It retries.' }],
  restated: [{ answer: 'a', verdict: 'explained', feedback: 'It retries.' }, { answer: 'b', verdict: 'restated', feedback: 'Right.' }],
}

/** A question on api/orders.js lines 10-12. */
export const questionOf = (id: string, kind: Question['kind'], attempts: Attempt[] = []): Question => ({
  id, kind, text: `Question ${id}?`, file: 'api/orders.js', start: 10, end: 12, attempts,
})
/**
 * A question built in a test from only the fields it reads (and literal verdicts TypeScript widens to string): the one
 * cast is here.
 */
export const asQuestion = (q: object) => q as Question

/** Three questions (a failure; a why that also reads the queue; a how about the whole file) in `states`. */
export function checkIn(states: [QState, QState, QState] = ['pass', 'pass', 'todo']): Check {
  const [s1, s2, s3] = states.map((s) => structuredClone(ATTEMPTS_IN[s]))
  return {
    version: 1,
    branch: 'feat/x',
    head: 'abcdef1',
    answeredBy: { name: 'Ada', email: 'ada@example.com' },
    questions: [
      questionOf('q1', 'failure', s1),
      { ...questionOf('q2', 'why', s2), also: [{ file: 'worker/queue.js', start: 84, end: 96 }] },
      { ...questionOf('q3', 'how', s3), target: 'file' },
    ],
  }
}

/** Where feat/x stands with `check` (default: answering, two passed, one to do): its summary is the CLI's. */
export function statusOf(over: Partial<BranchStatus> = {}, check: Check | undefined = checkIn()): BranchStatus {
  return {
    branch: 'feat/x',
    file: 'understanding/feat-x.json',
    changed: 120,
    exists: true,
    next: '',
    check,
    summary: check && summarize(check),
    state: { phase: 'answering', done: 2, total: 3, passed: 2, needed: 2 },
    drift: { lines: 0, approx: false },
    dirty: true,
    ...over,
  }
}

/** What the status bar and the view say: answering, 2 of 3 done. */
export const wordsOf = (over: Partial<Words> = {}): Words => ({
  tone: 'todo',
  bar: 'Understanding 2/3',
  title: '2 of 3 done',
  line: 'Answer all 3 · 2 must pass.',
  rule: 'Answer all 3 · 2 must pass',
  ...over,
})
