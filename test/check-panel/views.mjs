// The Check view's states shoot.mjs draws, as the extension sends them (src/checkModel.ts checkView): one per thing
// the view can show. Most are on feat/x (`onFeatX`) and differ in a few fields.

/** A question this long wraps over three lines at the narrowest width. */
export const LONG_QUESTION = 'What happens to an already-charged order\'s result when the API answers the report with a 4xx other than 409, such as 401 for a wrong WORKER_KEY, while replayUnreportedResultsFromTheLocalFile is still running?'
const SAVED_RESULTS = 'What happens to the saved results if replayUnreported throws?'
const SAFE_RETRY = 'Why is it safe for chargeOrder to retry after a timeout when the first attempt may already have charged the card?'
const SECOND_CHARGE = (i) => `Question ${i}: how does the worker stop a second charge for the same job?`
const LONG_BRANCH = 'feat/a-branch-with-a-rather-long-name-for-testing'
/** Its check file's name. */
const LONG_SLUG = 'feat-a-branch-with-a-rather-long-name-for-testing'

/** A row of the view: question `id`, number `n`, its kind, text and place, its state and the word for it. */
const row = (id, n, kind, text, where, state, word, extra = {}) => ({ id, n, kind, text, where, also: [], state, word, ...extra })

/** The check of feat/x, being answered. */
const onFeatX = { branch: 'feat/x', file: 'understanding/feat-x.json', tone: 'todo' }
/** "Answer all 3 · 2 must pass." with its title. */
const answering = (title) => ({ title, line: 'Answer all 3 · 2 must pass.' })

export const views = {
  answering: {
    branch: 'feat/retry-charges', file: 'understanding/feat-retry-charges.json', tone: 'todo', ...answering('1 of 3 done'),
    notice: 'Not asked about (uncommitted): README.md, allowlist.js',
    rows: [
      row('q1', 1, 'Failure', 'What happens to the saved results if replayUnreported throws or the worker dies halfway through the loop?', 'worker/worker.js:42', 'pass', ''),
      row('q2', 2, 'Why', SAFE_RETRY, 'worker/charge.js:19', 'retry', 'try again', { also: ['worker/queue.js:84-96'] }),
      row('q3', 3, 'Edge case', LONG_QUESTION, 'payments/a-very-long-folder-name/with-more-levels/client-with-a-long-name.js:32', 'todo', '', { flag: 'may be a bug' }),
    ],
  },
  done: {
    branch: LONG_BRANCH, file: `understanding/${LONG_SLUG}.json`, tone: 'ok', title: '✓ Done', line: 'Commit and push.',
    rows: ['pass', 'restated', 'explained', 'pass'].map((s, i) => {
      const word = s === 'explained' ? 'explained · say it back' : s === 'restated' ? 'in your words' : ''
      return row(`q${i + 1}`, i + 1, 'How', SECOND_CHARGE(i + 1), 'api/orders.js:12', s, word, i === 2 ? { flag: 'flagged for review' } : {})
    }),
    action: { id: 'commitPush', label: 'Commit & push' },
    who: "Ada's check: your answers are recorded as yours.",
    commits: `Commits ${LONG_SLUG}.json, also folds check files in diffs (.gitattributes)`,
    also: [{ file: 'services/api/src/refunds.js', label: 'also refunds.js (TODO added)', on: false }],
  },
  // The answer box under the selected question: a miss with a hint and a code link, a draft in the box.
  answer: {
    ...onFeatX, ...answering('1 of 3 done'),
    rows: [
      row('q1', 1, 'Failure', SAVED_RESULTS, 'worker/worker.js:42', 'pass', ''),
      row('q2', 2, 'Why', SAFE_RETRY, 'worker/charge.js:19', 'retry', 'try again'),
      row('q3', 3, 'Edge case', 'What does `takeJob` return when two workers take the same job?', 'worker/queue.js:7', 'todo', ''),
    ],
    answer: {
      id: 'q2', n: 2, open: true, draft: 'It checks the idempotency key first, so',
      grade: {
        pass: false,
        feedback: [{ text: 'Not quite: right about the key; re-check when it is written.' }],
        hint: [{ text: 'What does ' }, { text: 'the INSERT after the charge', link: 0 }, { text: ' do on a retry?' }],
      },
    },
  },
  // A pass: the box is gone, the grade and "Next question ›".
  passed: {
    ...onFeatX, ...answering('2 of 3 done'),
    rows: [
      row('q1', 1, 'Failure', SAVED_RESULTS, 'worker/worker.js:42', 'pass', ''),
      row('q2', 2, 'Why', 'Why is the charge retried?', 'worker/charge.js:19', 'pass', ''),
      row('q3', 3, 'Edge case', 'What happens when two workers take the same job?', 'worker/queue.js:7', 'todo', ''),
    ],
    answer: {
      id: 'q2', n: 2, open: false, draft: '',
      grade: { pass: true, feedback: [{ text: 'Right: ' }, { text: 'the unique key', link: 0 }, { text: ' turns the second charge into an error, not a double charge.' }] },
      next: true,
      concern: { text: 'The retry after a timeout charges again when the first attempt went through: no idempotency key is sent.', flagged: false },
    },
  },
  drift: {
    ...onFeatX, tone: 'warn', title: 'Needs top-up: +46 lines', line: 'Add 1–2 questions about the new lines.',
    rows: [row('q1', 1, 'How', 'How does it work?', 'a.js:1', 'pass', ''), row('q2', 2, 'Why', 'Why so?', 'a.js:9', 'pass', '')],
    action: { id: 'topUp', label: 'Add questions' },
  },
  // Done after an applied fix and a push of a branch without a merge request: said, the fix offered, the link.
  doneFix: {
    ...onFeatX, tone: 'ok', title: '✓ Done', line: 'Your fix is not committed yet.', said: 'Both answers kept.',
    mr: 'https://git.example.com/shop/-/merge_requests/new?merge_request%5Bsource_branch%5D=feat%2Fa-branch-with-a-rather-long-name',
    rows: ['pass', 'pass', 'pass'].map((s, i) => row(`q${i + 1}`, i + 1, 'How', SECOND_CHARGE(i + 1), 'api/orders.js:12', s, '', i === 2 ? { flag: 'fix applied · not committed' } : {})),
    action: { id: 'commitPush', label: 'Commit & push' },
    also: [{ file: 'services/api/src/refunds.js', label: 'refunds.js (your fix)', on: false }],
  },
  // Claude Code not found: the ways on, in one line.
  notFound: { ...onFeatX, title: 'No check yet for feat/x', line: '28 code lines changed.', rows: [], failed: { text: "Claude Code wasn't found.", path: true } },
  // Grading failed: said under the box with Try again.
  gradeError: {
    ...onFeatX, title: '0 of 2 done', line: 'Answer all 2 · 2 must pass.',
    rows: [
      row('q1', 1, 'Failure', SAVED_RESULTS, 'worker/worker.js:42', 'ungraded', 'not graded'),
      row('q2', 2, 'Why', 'Why is the charge retried?', 'worker/charge.js:19', 'todo', ''),
    ],
    answer: { id: 'q1', n: 1, open: true, draft: '', error: 'Claude is busy right now; your answer is saved.' },
  },
  conflict: { ...onFeatX, tone: 'warn', title: 'The check file has a merge conflict', line: 'Both sides of the conflict can be kept.', rows: [], action: { id: 'merge', label: 'Keep both answers' } },
  none: { ...onFeatX, title: `No check yet for ${LONG_BRANCH}`, line: '28 code lines changed.', rows: [], action: { id: 'start', label: 'Start' } },
  // The tour of the change: the rows say their step; one link walks it (or one muted line while it is written).
  tour: {
    branch: 'feat/refunds', file: 'understanding/feat-refunds.json', tone: 'todo', ...answering('1 of 3 done'),
    tour: { label: 'Walk the tour · 9 steps', action: 'walk' },
    rows: [
      row('q1', 1, 'Failure', 'What happens to an order in refund_pending if the API restarts before the worker takes its refund job?', 'api/orders.js:44', 'todo', '', { step: 4 }),
      row('q2', 2, 'Edge case', 'After a failed refund, what happens when the customer asks again for a different amount, given the idempotency key?', 'worker/refund.js:7', 'retry', 'try again', { step: 9, flag: 'may be a bug' }),
      row('q3', 3, 'Why', 'Why does startRefund check the status inside its UPDATE instead of relying on the status read in refundOrder?', 'api/store.js:44', 'pass', '', { step: 2 }),
    ],
  },
  tourWriting: {
    branch: 'feat/refunds', file: 'understanding/feat-refunds.json', tone: 'todo', ...answering('0 of 3 done'),
    tour: { label: 'Writing the tour · 1:20' },
    rows: [
      row('q1', 1, 'Failure', 'What happens to an order in refund_pending if the API restarts?', 'api/orders.js:44', 'todo', ''),
      row('q2', 2, 'Why', 'Why is the status checked in the UPDATE?', 'api/store.js:44', 'todo', ''),
    ],
  },
  writing: { ...onFeatX, title: 'No check yet for feat/x', line: '28 code lines changed.', rows: [], busy: 'Writing questions · 0:42 · reading the change' },
}
