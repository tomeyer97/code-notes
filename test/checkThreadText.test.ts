// A question's thread as text (src/check/threadText.ts): the question, the grader's replies, each message's code links,
// the messages a thread is missing. The replies' exact words are in one golden (golden-check.test.ts, thread-text).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { gradeBody, gradeMessageAt, gradeMessages, gradeReply, linksAt, missingMessages, questionBody, retryText } from '../src/check/threadText'
import { asQuestion, questionOf } from './checkFixtures'

test('the question alone, when it reads no other code', () => {
  assert.equal(questionBody(questionOf('q1', 'failure')), 'Question q1?')
})

test('the code a question also reads is named by file, a second range of it numbered', () => {
  const q = { ...questionOf('q1', 'failure'), also: [{ file: 'worker/queue.js', start: 84, end: 96 }, { file: 'worker/queue.js', start: 120, end: 124 }] }
  assert.equal(questionBody(q), 'Question q1?\n\nAlso read: queue.js, queue.js (2)')
  // Named by file and linked to their lines: no line numbers in the text.
  assert.deepEqual(linksAt(q, ['agent'], 0).map((l) => [l.phrase, l.start]), [['queue.js', 84], ['queue.js (2)', 120]])
})

for (const [name, attempt, o, reply] of [
  ['a pass: its feedback', { answer: 'a', verdict: 'pass', feedback: 'Fine.' }, {}, { tone: 'pass', feedback: 'Fine.' }],
  ['a pass without feedback: the grader\'s word for right', { answer: 'a', verdict: 'pass' }, {}, { tone: 'pass', feedback: 'Right.' }],
  ['a restatement that passed', { answer: 'a', verdict: 'restated', feedback: 'Fine.' }, {}, { tone: 'pass', feedback: 'Fine.' }],
  ['a retry with a hint', { answer: 'a', verdict: 'retry', feedback: 'Close.', hint: 'Look at report().' }, {}, { tone: 'retry', feedback: 'Not quite. Close.', hint: 'Look at report().' }],
  ['a retry with no hint', { answer: 'a', verdict: 'retry', feedback: 'Close.', hint: '' }, {}, { tone: 'retry', feedback: 'Not quite. Close.' }],
  ['an explanation: the offer to say it back', { answer: 'a', verdict: 'explained', feedback: 'It keeps it.' }, {}, { tone: 'explained', feedback: 'It keeps it.', offer: 'sayItBack' }],
  ['a restatement that missed: done anyway', { answer: 'a', verdict: 'explained', feedback: 'The lock.' }, { restatement: true }, { tone: 'explained', feedback: 'The lock.', offer: 'tryOnceMore' }],
] as const) {
  test(`the grader's reply: ${name}`, () => assert.deepEqual(gradeReply({ ...attempt }, o), reply))
}

test('a retry opens with "Not quite." once, also when the grader\'s words already do', () => {
  assert.equal(retryText('not quite: what then?'), 'not quite: what then?')
  assert.equal(retryText('Close.'), 'Not quite. Close.')
  assert.equal(gradeBody({ answer: 'a', verdict: 'retry', feedback: 'Not quite: what then?' }), 'Not quite: what then?')
})

test('the grades of a thread: the agent replies after the question, in order', () => {
  const roles = ['agent', 'human', 'agent', 'human', 'human', 'agent']
  assert.deepEqual(gradeMessages(roles), [2, 5])
  assert.equal(gradeMessageAt(roles, 2), 5)
  assert.equal(gradeMessageAt(roles, 3), -1)
})

const linked = () => {
  const ql = { phrase: 'the reset function', file: 'api/limits.js', start: 11, end: 13 }
  const gl = { phrase: 'the window check', file: 'api/limits.js', start: 6, end: 6 }
  const q = asQuestion({
    ...questionOf('q1', 'failure'), links: [ql], also: [{ file: 'api/limits.js', start: 11, end: 13 }, { file: 'api/store.js', start: 2, end: 4 }],
    attempts: [{ answer: 'a', verdict: 'retry', links: [gl] }, { answer: 'b' }],
  })
  return { q, ql, gl, roles: ['agent', 'human', 'agent', 'human'] }
}

test('code links: the question\'s on the first message, with the "also" code it doesn\'t link already', () => {
  const { q, ql, roles } = linked()
  assert.deepEqual(linksAt(q, roles, 0), [ql, { phrase: 'store.js', file: 'api/store.js', start: 2, end: 4 }])
  assert.equal(questionBody(q), 'Question q1?\n\nAlso read: store.js')
})

test('code links: each grade\'s own; answers have none', () => {
  const { q, gl, roles } = linked()
  assert.deepEqual(linksAt(q, roles, 2), [gl])
  assert.deepEqual([linksAt(q, roles, 1), linksAt(q, roles, 3)], [[], []])
})

test('missingMessages: the file\'s thread messages the note does not have yet', () => {
  const m = (role: string, body: string) => ({ role, body })
  const inNote = [m('agent', 'Q'), m('human', 'a1'), m('human', 'remark')]
  const inFile = [m('agent', 'Q'), m('human', 'a1'), m('agent', 'g1')]
  assert.deepEqual(missingMessages(inNote, inFile), [m('agent', 'g1')])
})
