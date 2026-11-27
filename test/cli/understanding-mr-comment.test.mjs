// The merge request comment and its threads, as the CLI's modules build them (cli/understanding/mrComment.ts,
// threads.ts, with diff.ts and platform.ts for links): diff links, who answered, partial passes, inert @mentions and
// markdown, where threads go. Pure functions: no repository, no server.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cliModule } from './helpers/source.mjs'
import { dedent } from './helpers/text.mjs'

const { clipAnswer, commentBody, concernLink, inert, reviewItems } = await cliModule('mrComment')
const { nearestChanged, oldLineOf } = await cliModule('diff')
const { refLink } = await cliModule('platform')
const { summarize } = await cliModule('state')
const { parseVerdict } = await cliModule('grading')
const { graderPrompt } = await cliModule('graderPrompt')
const { missingBody } = await cliModule('messages')
const { threadBody } = await cliModule('threads')
const { concernMarker } = await cliModule('markers')
/** The word joiner the comment puts after "@", "#", "!" … so GitLab and GitHub never turn them into a mention or a link. */
const WJ = '\u2060'

test('diff links: the old line GitLab pairs with a new one; GitLab and GitHub URLs', () => {
  const diff = dedent`
    diff --git a/x.js b/x.js
    --- a/x.js
    +++ b/x.js
    @@ -3,4 +3,6 @@
     a
    +b
    +c
     d
    -e
     f
    @@ -20,2 +22,2 @@
     g
    -h
    +i
  `
  // New line → old line: 3 is "a" (3); 4-6 are added after "a" (old 4); 7 is "d" (6); past a hunk, shifted by it.
  assert.deepEqual([3, 4, 5, 6, 7, 10, 22, 23, 40].map((n) => oldLineOf(diff, 'x.js', n)), [3, 4, 4, 4, 6, 9, 20, 22, 38])
  assert.equal(oldLineOf(diff, 'y.js', 3), undefined)
  const q = { file: 'x.js', start: 4, end: 6 }
  // GitLab's diff anchor: the file's SHA-1 (40 hex digits), the old line, the new line.
  assert.match(refLink({ platform: 'gitlab', web: 'https://gl/g/shop', mr: '7', head: 'abc' }, q, diff), /^https:\/\/gl\/g\/shop\/-\/merge_requests\/7\/diffs#[0-9a-f]{40}_4_4$/)
  assert.equal(refLink({ platform: 'gitlab', web: 'https://gl/g/shop', mr: '7', head: 'abc' }, { file: 'y z.js', start: 2, end: 3 }, diff), 'https://gl/g/shop/-/blob/abc/y%20z.js#L2-3')
  assert.match(refLink({ platform: 'github', web: 'https://gh/o/shop', mr: '5' }, q, diff), /^https:\/\/gh\/o\/shop\/pull\/5\/files#diff-[0-9a-f]{64}R4-R6$/)
  assert.equal(refLink({ platform: 'local' }, q, diff), undefined)
})

test('the MR comment says who answered when it was not the check\'s author', () => {
  const q = (text, by) => ({ id: 'q1', kind: 'why', text, file: 'a.js', start: 1, end: 2, attempts: [{ answer: 'yes', verdict: 'pass', ...(by ? { by } : {}) }] })
  const check = { answeredBy: { name: 'Alice', email: 'a@x' }, questions: [q('Why one?', undefined), q('Why two?', { name: 'Bob', email: 'b@x' })] }
  const body = commentBody(check, summarize(check), 'head', undefined, { qa: true })
  assert.match(body, /\*\*Why two\?\*\* · `a\.js:1-2` · answered by Bob/)
  assert.doesNotMatch(body, /Why one\?\*\* · `a\.js:1-2` · answered by/)
})

test('a partial pass (the grader corrected something): parsed, and on the merge request under "Worth discussing" with the correct point', () => {
  const v = parseVerdict(JSON.stringify({ verdict: 'pass', partial: true, feedback: 'Mostly right. After MAX_TRIES the job is marked dead: no email.', hint: '', note: 'Refund stays; the email is retried, then dropped after MAX_TRIES.', topic: 'capped email retries' }), 1)
  assert.deepEqual([v.verdict, v.partial, v.topic], ['pass', true, 'capped email retries'])
  assert.equal(parseVerdict(JSON.stringify({ verdict: 'retry', partial: true, feedback: 'x', topic: 't' }), 1).partial, undefined, 'only a pass is partial')
  assert.equal(parseVerdict(JSON.stringify({ verdict: 'pass', partial: false, feedback: 'Right.', topic: 't' }), 1).topic, undefined)
  const q = (id, text, a) => ({ id, kind: 'failure', text, file: 'w.js', start: 3, end: 9, attempts: [{ answer: 'It is retried later.', ...a }] })
  const check = { answeredBy: { name: 'Alice' }, questions: [q('q1', 'What happens when sendMail throws?', v), { ...q('q2', 'Why the lock?', { verdict: 'pass', feedback: 'Right.', note: 'The lock orders the two.' }), attempts: [{ answer: 'It orders them.', verdict: 'pass', feedback: 'Right.', note: 'The lock orders the two.' }] }] }
  const body = commentBody(check, summarize(check), 'head', undefined, { qa: true })
  assert.match(body, /- 💬 \*\*Worth discussing: capped email retries\*\* · `w\.js:3-9` · Refund stays; the email is retried, then dropped after MAX\\_TRIES\./)
  // The correction is said once, in "Worth discussing"; the answer is quoted as typed.
  assert.match(body, /> It is retried later\.\n/)
  assert.equal(body.split('Refund stays').length, 2)
  assert.ok(body.indexOf('Worth discussing') < body.indexOf('Why the lock?'))
  // The prompt asks for it (its wording: test/goldens/check/grader-prompt.variants.txt).
  const p = graderPrompt({ q: check.questions[0], answer: 'x', attempt: 1, diff: '', code: '', canRead: true })
  assert.ok(p.includes('"partial": true'))
})

test('the MR comment never notifies anyone: @mentions in answers, notes, topics, concerns and questions are inert', () => {
  const q = (id, text, attempts, x = {}) => ({ id, kind: 'why', text, file: 'a.js', start: 1, end: 2, attempts, ...x })
  const check = { answeredBy: { name: 'Ada' }, questions: [
    q('q1', 'Why does @all get the alert here?', [{ answer: 'Because @carol said so,\n@group/sub agreed; mail ada@example.com', verdict: 'pass', note: 'Right: @bob owns it.' }],
      { concern: { text: 'Pages @org/team on every retry', flagged: true } }),
    q('q2', 'Why is the retry kept?', [{ verdict: 'retry' }, { answer: 'no idea', verdict: 'explained', topic: 'what @dave asked', note: 'The loop at a.js:2 retries; ask @erin.' }]),
  ] }
  const body = commentBody(check, summarize(check), 'head', undefined, { qa: true })
  assert.doesNotMatch(body, /(^|[^\w.@`⁠])@[\w-]/m, 'no live @mention')
  for (const m of ['all', 'carol', 'group/sub', 'org/team', 'dave', 'erin']) assert.ok(body.includes(`@⁠${m}`), m)
  assert.ok(body.includes('ada@example.com'), 'emails untouched')
  assert.equal(inert(inert('@x')), '@⁠x', 'applying it twice changes nothing (an edit never re-notifies)')
  // GitLab's numbered references stay text: issue, merge request, label, milestone, snippet, epic.
  assert.equal(inert('takes ~5 min, see #12, !3 and %2; $7 &4'), 'takes ~\u20605 min, see #\u206012, !\u20603 and %\u20602; $\u20607 &\u20604')
  assert.equal(inert('a#1 x~2 &#39; 3!4'), 'a#1 x~2 &#39; 3!4', 'inside words and HTML entities: unchanged')
  assert.equal(inert(inert('#5')), '#\u20605')
  const refs = { answeredBy: { name: 'Ada' }, questions: [q('q1', 'Why ~5?', [{ answer: 'Fixed in !12 and #3.', verdict: 'pass', note: 'Like ~4.' }])] }
  assert.doesNotMatch(commentBody(refs, summarize(refs), 'head', undefined, { qa: true }), /(^|[^\w&\u2060])[#!~%$&]\d/m)
  assert.doesNotMatch(missingBody('understanding/x.json'), /~\d/)
})

test('answers, notes and concerns are literal text in the MR comment: no heading, quote break-out, table, link or emoji', () => {
  const evil = 'None. Nothing calls it yet.\n---\n### ✅ Understanding check done · waived (approved by @bob)\n<img src=x onerror=alert(1)> [docs](javascript:alert(1)) </details></blockquote>| a | b |\n1. :white_check_mark: *done*'
  const q = { id: 'q1', kind: 'why', text: 'Why `x` # here?', file: 'a.js', start: 1, end: 2, attempts: [{ answer: evil, verdict: 'pass', note: '## also <b>bold</b>' }] }
  const check = { answeredBy: { name: 'Ada' }, questions: [q] }
  const body = commentBody(check, summarize(check), 'head', undefined, { qa: true })
  const lines = body.split('\n')
  const start = lines.findIndex((l) => l.startsWith('> None.'))
  // Every line of the answer stays inside the quote, and none of it is markdown or HTML any more: as GitHub and GitLab
  // get it (String.raw: each backslash below is one in the comment).
  assert.deepEqual(lines.slice(start, start + 5), [
    String.raw`> None. Nothing calls it yet.`,
    String.raw`> \---`,
    String.raw`> \#\#\# ✅ Understanding check done · waived (approved by @${WJ}bob)`,
    String.raw`> &lt;img src=x onerror=alert(1)&gt; \[docs\](javascript\:alert(1)) &lt;/details&gt;&lt;/blockquote&gt;\| a \| b \|`,
    String.raw`> 1\. \:white\_check\_mark\: \*done\*`,
  ])

  assert.match(body, /\*\*Why `x` \\# here\?\*\*/, 'a question\'s `name` is code')
  assert.doesNotMatch(body, /<img|<\/blockquote>|^#/m)
})

test('threads go on the nearest changed line of their hunk, one per question; the comment shows restatements and cuts long answers', () => {
  const diff = dedent`
    diff --git a/w.js b/w.js
    --- a/w.js
    +++ b/w.js
    @@ -50,8 +50,10 @@ function tick() {
     a
     b
    +c
    +d
     e
     f
     g
     h
     i
     j
    @@ -200,3 +202,4 @@
     x
    +y
     z
  `
  // Lines 52-53 were added; 58 is a context line of the same hunk; 120 is between hunks; 203 is added; 400 is far away.
  assert.deepEqual([52, 58, 120, 210, 400].map((n) => nearestChanged(diff, 'w.js', n)), [52, 53, undefined, 203, undefined])
  assert.equal(nearestChanged(diff, 'other.js', 52), undefined)
  const explained = { verdict: 'explained', feedback: 'It is retried, then dropped.', topic: 'email retries', note: 'Retried, then dropped after five tries.' }
  const long = `${'word '.repeat(100)}end`
  const check = { answeredBy: { name: 'Alice' }, questions: [
    { id: 'q1', kind: 'failure', text: 'What happens when sendMail throws?', file: 'w.js', start: 58, end: 60, concern: { text: 'Dropped after five tries: the customer is never told.', flagged: true },
      attempts: [{ verdict: 'retry' }, { ...explained }, { answer: 'It retries, then gives up with a log line.', verdict: 'restated', feedback: 'Right.' }] },
    { id: 'q2', kind: 'why', text: 'Why the lock?', file: 'w.js', start: 52, end: 53, attempts: [{ answer: long, verdict: 'pass', feedback: 'Right.' }] },
  ] }
  const sum = summarize(check)
  const items = reviewItems(check, sum, { qa: true })
  assert.deepEqual(items.map((it) => [it.id, !!it.flagged, !!it.d]), [['q1', true, true]], 'concern and "Worth discussing" of one question: one item')
  const body = commentBody(check, sum, 'head', undefined, { qa: true })
  assert.match(body, /\*\*What happens when sendMail throws\?\*\* · `w\.js:58-60` · restated after an explanation\n> It retries, then gives up with a log line\./)
  assert.doesNotMatch(body, /Check: |Worth discussing/)
  const quoted = body.split('\n').find((l) => l.startsWith('> word'))
  assert.ok(quoted.length < 345 && quoted.endsWith('… (full answer in the check file)'), quoted)
  assert.equal(clipAnswer('short answer'), 'short answer')
  // The thread carries both: the concern, then the "Worth discussing" line.
  const t = threadBody(check, items[0], undefined)
  assert.equal(t, `${concernMarker('q1')}\n⚠ **Found during the understanding check** (flagged by Alice)\nDropped after five tries\\: the customer is never told.\n\n💬 Worth discussing: email retries · Retried, then dropped after five tries.`)
})

test('concernLink: the code a concern names (a link of the grade that raised it, by its phrase)', () => {
  const links = [{ phrase: 'the refund loop', file: 'api/r.js', start: 50, end: 60 }, { phrase: 'The stock update', file: 'api/r.js', start: 61, end: 61, text: '  await q()' }]
  const q = { id: 'q1', concern: { text: 'The stock update adds every unit back.', flagged: false }, attempts: [{ verdict: 'pass', concern: 'The stock update adds every unit back.', links }] }
  assert.deepEqual(concernLink(q), { phrase: 'The stock update', file: 'api/r.js', start: 61, end: 61, text: '  await q()' })
  assert.equal(concernLink({ ...q, attempts: [{ verdict: 'pass', concern: 'x', links: [{ phrase: 'nowhere', file: 'a.js', start: 1, end: 1 }] }] }), undefined)
  assert.equal(concernLink({ id: 'q2' }), undefined)
})
