// The Check view's states shoot.mjs draws, each made by the extension's own view model (out/src/check/viewModel.js
// checkView, after `npm run build`) from a status, the CLI's words and what the extension knows besides: so the panel
// is checked on what the extension sends, and a renamed field or changed wording shows up here. One per thing the
// view can show. The files are the example shop's (examples/shop; its refunds are test/fixtures/grader-cases').
import { createRequire } from 'node:module'

const VM = createRequire(import.meta.url)('../../out/src/check/viewModel.js')

/** A question this long wraps over three lines at the narrowest width. */
const LONG_QUESTION = 'What happens to an already-charged order\'s result when the API answers the report with a 4xx other than 409, such as 401 for a wrong WORKER_KEY, while replayUnreportedResultsFromTheLocalFile is still running?'
/** A path longer than any of the shop's: the row must wrap it, not stick out. */
const LONG_PATH = 'payments/a-very-long-folder-name/with-more-levels/client-with-a-long-name.js'
const SAVED_RESULTS = 'What happens to the saved results if replayUnreported throws?'
const SAFE_RETRY = 'Why is it safe for chargeOrder to retry after a timeout when the first attempt may already have charged the card?'
const SECOND_CHARGE = (i) => `Question ${i}: how does the worker stop a second charge for the same job?`
const LONG_BRANCH = 'feat/a-branch-with-a-rather-long-name-for-testing'
/** Its check file's name. */
const LONG_SLUG = 'feat-a-branch-with-a-rather-long-name-for-testing'
/** The file a TODO or a fix went to. */
const REFUNDS = 'api/refunds.js'

const ADA = { name: 'Ada', email: 'ada@example.com' }
const BOB = { name: 'Bob', email: 'bob@example.com' }

/** Question `id` of kind `kind` at `file`:`start`. */
const q = (id, kind, text, file, start, extra = {}) => ({ id, kind, text, file, start, end: start, ...extra })
/** Its concern: the question's own "may be a bug", one flagged for review, or one found while grading. */
const suspect = { suspect: true, concern: { text: 'May be a bug.' } }
const flagged = { concern: { text: 'The retry charges again.', flagged: true } }
const concern = (text) => ({ concern: { text } })

/**
 * Where branch `branch` stands: its check (`questions`, their `states`) in phase `phase`. Its check has no tour and
 * offers none (`noTour`), unless `tour` (a tour being written) or a journey is given: the tour's own states show it.
 */
function status(branch, phase, { questions, states, tour = false, ...over } = {}) {
  const file = `understanding/${branch.replace(/\//g, '-')}.json`
  const check = questions && { version: 1, branch, head: 'abcdef1', answeredBy: ADA, questions, ...(tour ? {} : { noTour: true }) }
  return { branch, file, changed: 28, exists: !!check, check, summary: states && { states }, state: { phase }, ...over }
}
/** The CLI's words for it. */
const words = (tone, title, line) => ({ tone, bar: title, title, line, rule: line })
/** "Answer all 3 · 2 must pass." with its title. */
const answering = (title, all = 3) => words('todo', title, `Answer all ${all} · 2 must pass.`)

/** The three questions of feat/x being answered: the first passed, the second to retry, the third to do. */
const featX = (second = {}, third = {}) => [
  q('q1', 'failure', SAVED_RESULTS, 'worker/worker.js', 42),
  q('q2', 'why', SAFE_RETRY, 'worker/charge.js', 19, second),
  q('q3', 'edge', 'What does `takeJob` return when two workers take the same job?', 'api/queue.js', 7, third),
]

/** A graded attempt: `verdict`, its feedback and hint, the code links their phrases name. */
const attempt = (verdict, feedback, links = [], hint) => ({ answer: 'An answer.', verdict, feedback, hint, links: links.map((phrase) => ({ phrase, file: 'worker/charge.js', start: 19, end: 19 })) })

const STATES = {
  answering: [
    status('feat/retry-charges', 'answering', {
      questions: [
        q('q1', 'failure', 'What happens to the saved results if replayUnreported throws or the worker dies halfway through the loop?', 'worker/worker.js', 42),
        q('q2', 'why', SAFE_RETRY, 'worker/charge.js', 19, { also: [{ file: 'api/queue.js', start: 84, end: 96 }] }),
        q('q3', 'edge', LONG_QUESTION, LONG_PATH, 32, suspect),
      ],
      states: ['pass', 'retry', 'todo'],
    }),
    answering('1 of 3 done'),
    { notice: 'Not asked about (uncommitted): README.md, allowlist.js' },
  ],
  done: [
    status(LONG_BRANCH, 'done', {
      questions: [1, 2, 3, 4].map((i) => q(`q${i}`, 'how', SECOND_CHARGE(i), 'api/orders.js', 12, i === 3 ? flagged : {})),
      states: ['pass', 'restated', 'explained', 'pass'],
      dirty: true,
    }),
    words('ok', '✓ Done', 'Commit and push.'),
    { me: BOB, commit: { files: [`understanding/${LONG_SLUG}.json`], todos: [REFUNDS], include: new Set(), fold: true } },
  ],
  // The answer box under the selected question: a miss with a hint and a code link, a draft in the box.
  answer: [
    status('feat/x', 'answering', {
      questions: featX({ attempts: [attempt('retry', 'right about the key; re-check when it is written.', ['the INSERT after the charge'], 'What does the INSERT after the charge do on a retry?')] }),
      states: ['pass', 'retry', 'todo'],
    }),
    answering('1 of 3 done'),
    { selected: 'q2', draft: 'It checks the idempotency key first, so' },
  ],
  // A pass: the box is gone, the grade and "Next question ›".
  passed: [
    status('feat/x', 'answering', {
      questions: featX({
        text: 'Why is the charge retried?',
        attempts: [attempt('pass', 'Right: the unique key turns the second charge into an error, not a double charge.', ['the unique key'])],
        ...concern('The retry after a timeout charges again when the first attempt went through: no idempotency key is sent.'),
      }, { text: 'What happens when two workers take the same job?' }),
      states: ['pass', 'pass', 'todo'],
    }),
    answering('2 of 3 done'),
    { selected: 'q2' },
  ],
  drift: [
    status('feat/x', 'drift', { questions: [q('q1', 'how', 'How does it work?', 'api/orders.js', 1), q('q2', 'why', 'Why so?', 'api/orders.js', 9)], states: ['pass', 'pass'] }),
    words('warn', 'Needs top-up: +46 lines', 'Add 1–2 questions about the new lines.'),
  ],
  // Done after an applied fix and a push of a branch without a merge request: said, the fix offered, the link.
  doneFix: [
    status('feat/x', 'done', {
      questions: [1, 2, 3].map((i) => q(`q${i}`, 'how', SECOND_CHARGE(i), 'api/orders.js', 12, i === 3 ? concern('The refund is not checked.') : {})),
      states: ['pass', 'pass', 'pass'],
      dirty: false,
    }),
    words('ok', '✓ Done', 'Commit and push.'),
    {
      said: 'Both answers kept.', unpushed: false,
      mr: 'https://git.example.com/shop/-/merge_requests/new?merge_request%5Bsource_branch%5D=feat%2Fa-branch-with-a-rather-long-name',
      commit: { files: [], todos: [], include: new Set(), fixes: [REFUNDS], exclude: new Set([REFUNDS]), applied: ['q3'] },
    },
  ],
  // Claude Code not found: the ways on, in one line.
  notFound: [status('feat/x', 'none'), words('todo', 'No check yet for feat/x', '28 code lines changed.'), { failed: { text: "Claude Code wasn't found.", path: true } }],
  // Grading failed: said under the box with Try again.
  gradeError: [
    status('feat/x', 'answering', { questions: featX().slice(0, 2).map((x, i) => (i ? { ...x, text: 'Why is the charge retried?' } : x)), states: ['ungraded', 'todo'] }),
    answering('0 of 2 done', 2),
    { selected: 'q1', error: 'Claude is busy right now; your answer is saved.' },
  ],
  conflict: [
    status('feat/x', 'invalid', { state: { phase: 'invalid', conflict: { line: 3, mergeable: true } } }),
    words('warn', 'The check file has a merge conflict', 'Both sides of the conflict can be kept.'),
  ],
  none: [status('feat/x', 'none'), words('todo', `No check yet for ${LONG_BRANCH}`, '28 code lines changed.')],
  // The tour of the change: the rows say their step; one link walks it (or one muted line while it is written).
  tour: [
    status('feat/refunds', 'answering', {
      tour: true,
      questions: [
        q('q1', 'failure', 'What happens to an order in refund_pending if the API restarts before the worker takes its refund job?', 'api/orders.js', 44, { step: 4 }),
        q('q2', 'edge', 'After a failed refund, what happens when the customer asks again for a different amount, given the idempotency key?', 'worker/refund.js', 7, { step: 9, ...suspect }),
        q('q3', 'why', 'Why does startRefund check the status inside its UPDATE instead of relying on the status read in refundOrder?', 'api/store.js', 44, { step: 2 }),
      ],
      states: ['todo', 'retry', 'pass'],
    }),
    answering('1 of 3 done'),
  ],
  tourWriting: [
    status('feat/refunds', 'answering', {
      tour: true,
      questions: [
        q('q1', 'failure', 'What happens to an order in refund_pending if the API restarts?', 'api/orders.js', 44),
        q('q2', 'why', 'Why is the status checked in the UPDATE?', 'api/store.js', 44),
      ],
      states: ['todo', 'todo'],
    }),
    answering('0 of 3 done'),
    { tourBusy: 'Writing the tour · 1:20' },
  ],
  writing: [status('feat/x', 'none'), words('todo', 'No check yet for feat/x', '28 code lines changed.'), { busy: 'Writing questions · 0:42 · reading the change' }],
}
// The tour's check has a tour of nine steps (only their number shows in the view).
STATES.tour[0].check.journey = { title: 'Refunds', steps: Array.from({ length: 9 }, (_, i) => ({ title: `Step ${i + 1}`, file: 'api/orders.js', range: { start: 1, end: 2 } })) }

/** Each state's view, as the extension sends it. */
export const views = Object.fromEntries(Object.entries(STATES).map(([name, [st, w, o]]) => [name, VM.checkView(st, w, o)]))
