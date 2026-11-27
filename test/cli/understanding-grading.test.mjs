// Grading (cli/understanding/grading.ts): the grader's reply read into a verdict, restatements, the other open
// questions, concerns about the code. The prompt's wording is in understanding-graderPrompt.test.mjs and its golden.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cliModule } from './helpers/source.mjs'

const { gradeMode, openOthers, parseVerdict } = await cliModule('grading')

test('the grader\'s reply: JSON found in text', () => {
  assert.deepEqual(parseVerdict('Sure:\n```json\n{"verdict":"pass","feedback":"Yes.","hint":"x"}\n```'), { verdict: 'pass', feedback: 'Yes.', hint: '' })
  assert.throws(() => parseVerdict('I think it passes'), /didn't reply with a verdict/)
})

test('the grader\'s reply: the verdict is fixed by the attempt (a first miss is "retry", a second "explained")', () => {
  assert.equal(parseVerdict('{"verdict":"retry","feedback":"No","hint":"Look"}', 2).verdict, 'explained')
  assert.equal(parseVerdict('{"verdict":"explained","feedback":"It is…"}', 1).verdict, 'retry')
  assert.equal(parseVerdict('{"verdict":"restated","feedback":"Right."}', 1).verdict, 'pass')
})

test('a restatement: graded against the explanation; only "restated" or "explained"', () => {
  const ex = { attempts: [{ answer: 'a', verdict: 'retry' }, { answer: 'a', verdict: 'explained', feedback: 'Both miss the lookup; the second fails on the UNIQUE key.' }, { answer: 'a' }] }
  assert.deepEqual(gradeMode(ex), { attempt: 3, explanation: 'Both miss the lookup; the second fails on the UNIQUE key.' })
  assert.equal(parseVerdict('{"verdict":"pass","feedback":"Right."}', 3, { restate: true }).verdict, 'restated')
  assert.equal(parseVerdict('{"verdict":"retry","feedback":"No."}', 3, { restate: true }).verdict, 'explained')
})

test('the note for the reviewer, the topic of an explanation, a concern about the code: kept when they apply', () => {
  assert.deepEqual(parseVerdict('{"verdict":"explained","feedback":"It…","note":"The second fails on UNIQUE.","topic":"same-key refunds","concern":"api/refunds.js:11 looks up before the lock."}', 2),
    { verdict: 'explained', feedback: 'It…', hint: '', note: 'The second fails on UNIQUE.', topic: 'same-key refunds', concern: 'api/refunds.js:11 looks up before the lock.' })
  assert.deepEqual(parseVerdict('{"verdict":"retry","feedback":"Re-check.","hint":"Look.","note":"x","concern":""}', 1), { verdict: 'retry', feedback: 'Re-check.', hint: 'Look.' })
})

test('a partial pass: only a pass is partial; a full pass has no topic', () => {
  const v = parseVerdict(JSON.stringify({ verdict: 'pass', partial: true, feedback: 'Mostly right.', topic: 'capped email retries' }), 1)
  assert.deepEqual([v.verdict, v.partial, v.topic], ['pass', true, 'capped email retries'])
  assert.equal(parseVerdict(JSON.stringify({ verdict: 'retry', partial: true, feedback: 'x', topic: 't' }), 1).partial, undefined)
  assert.equal(parseVerdict(JSON.stringify({ verdict: 'pass', partial: false, feedback: 'Right.', topic: 't' }), 1).topic, undefined)
})

test('the other open questions of the check (the grader must never answer them)', () => {
  const qs = [
    { id: 'q1', text: 'What does shippingFor return for a negative discount?', attempts: [{ answer: 'x' }] },
    { id: 'q2', text: 'What does it return when subtotal minus discount is exactly 5000?' },
    { id: 'q3', text: 'Why is the threshold checked after the discount?', attempts: [{ answer: 'y', verdict: 'pass' }] },
  ]
  assert.deepEqual(openOthers({ questions: qs }, qs[0]), ['What does it return when subtotal minus discount is exactly 5000?'])
})

test('a concern is about the code: never a copy of the feedback', () => {
  const pv = (o, n = 1) => parseVerdict(JSON.stringify({ verdict: 'pass', feedback: '', hint: '', ...o }), n)
  // A confirmation or a reassurance repeated as a concern: dropped (same text, or a part of the feedback).
  assert.equal(pv({ feedback: 'Right: the static import of the renamed file fails to resolve, so the process dies at startup.', concern: 'The static import of the renamed file fails to resolve, so the process dies at startup.' }).concern, undefined)
  assert.equal(pv({ feedback: 'Right: nothing in the repo references refundReport, so removing it breaks no caller.', concern: 'nothing in the repo references refundReport' }).concern, undefined)
  assert.equal(pv({ feedback: 'Right.', concern: 'right' }).concern, undefined)
  // The grade itself is never turned into a concern.
  assert.equal(pv({ feedback: 'Right. NOTES-x.txt is rendered as a manifest, so helm install errors out.', concern: '' }).concern, undefined)
  // A real concern in its own words stays.
  assert.equal(pv({ feedback: 'Right: the top-level loop starts on import and never ends.', concern: 'Exporting jitter from worker.js hangs any module that imports it.' }).concern, 'Exporting jitter from worker.js hangs any module that imports it.')
  assert.equal(parseVerdict(JSON.stringify({ verdict: 'retry', feedback: 'Not quite: what fails here?', hint: 'h', concern: '' }), 1).concern, undefined)
})
