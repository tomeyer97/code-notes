// The check's threads brought in line with its file (src/check/threadSync.ts): the plan, without the notes store.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Message } from '../src/core/format/noteModel'
import type { Note } from '../src/notes/store'
import { messagesOf, planSync, threadNoteData, withoutSuperseded, type SyncContext } from '../src/check/threadSync'
import { textHash } from '../src/check/threadLink'
import { stateOf } from '../cli/understanding/state'
import type { Check, Question } from '../src/check/types'
import { checkIn, questionOf } from './checkFixtures'

const ctx: SyncContext = { stateOf, me: 'Me', author: 'Understanding check', now: 'NOW' }
const FILE = 'understanding/feat-x.json'
const threadOf = (q: Question, messages: Message[], o: { h?: string; status?: 'open' | 'resolved' } = {}) => ({
  data: { id: `n-${q.id}`, status: o.status ?? 'open', messages, extra: { check: { file: FILE, q: q.id, h: o.h ?? textHash(q) } } },
}) as unknown as Note
const agent = (body: string): Message => ({ author: 'Understanding check', role: 'agent', body })
const human = (body: string): Message => ({ author: 'Ada', role: 'human', body })

test('every question without a thread gets one, starting with its messages', () => {
  const check = checkIn(['todo', 'todo', 'todo'])
  const plan = planSync(check, [], ctx)
  assert.deepEqual(plan.create.map((c) => c.q.id), ['q1', 'q2', 'q3'])
  assert.deepEqual(plan.create[0].messages, [{ author: 'Understanding check', role: 'agent', body: 'Question q1?' }])
})

test('a thread whose question went or changed goes; a second thread of one question is left alone', () => {
  const check = checkIn(['todo', 'todo', 'todo'])
  const [q1, q2] = check.questions
  const gone = threadOf(questionOf('q9', 'how'), [agent('Question q9?')])
  const changed = threadOf(q1, [agent('Question q1?')], { h: 'other' })
  const first = threadOf(q2, [agent('Question q2?\n\nAlso read: queue.js')]), second = threadOf(q2, [agent('x')])
  const plan = planSync(check, [gone, changed, first, second], ctx)
  assert.deepEqual(plan.trash, [gone, changed])
  assert.deepEqual(plan.create.map((c) => c.q.id), ['q1', 'q3'])
  assert.deepEqual(plan.update, [])
})

test('a grade written elsewhere is added; the question done: the thread resolved', () => {
  const check = checkIn(['pass', 'todo', 'todo'])
  const q1 = check.questions[0]
  const plan = planSync(check, [threadOf(q1, [agent('Question q1?'), human('a')])], ctx)
  assert.equal(plan.update.length, 1)
  assert.deepEqual(plan.update[0].messages.at(-1), { author: 'Understanding check', role: 'agent', body: '✓ Right.', at: 'NOW' })
  assert.equal(plan.update[0].status, 'resolved')
})

test('a thread that has every message: nothing to do', () => {
  const check = checkIn(['todo', 'todo', 'todo'])
  const q1 = check.questions[0]
  assert.deepEqual(planSync(check, [threadOf(q1, [agent('Question q1?'), human('a remark')])], ctx).update, [])
})

test('messagesOf: an answer by its author, else the check\'s, else the person here', () => {
  const check: Check = { ...checkIn(), answeredBy: undefined }
  const q = { ...questionOf('q1', 'how'), attempts: [{ answer: 'a' }, { answer: 'b', by: { name: 'Bob' } }] }
  assert.deepEqual(messagesOf(q, check, ctx).slice(1).map((m) => m.author), ['Me', 'Bob'])
})

test('withoutSuperseded: an older answer the file no longer keeps goes, with its grade', () => {
  const q = { ...questionOf('q1', 'how'), attempts: [{ verdict: 'retry' as const }, { answer: 'second', verdict: 'pass' as const }] }
  const thread = [agent('Q'), human('first'), agent('Not quite.'), human('second'), agent('✓ Right.')]
  assert.deepEqual(withoutSuperseded(thread, q)?.map((m) => m.body), ['Q', 'second', '✓ Right.'])
})

test('withoutSuperseded: an explanation stays (the lesson), its answer goes', () => {
  const q = { ...questionOf('q1', 'how'), attempts: [{ verdict: 'explained' as const }, { answer: 'second', verdict: 'restated' as const }] }
  const thread = [agent('Q'), human('first'), agent('It retries.'), human('second'), agent('✓ Right.')]
  assert.deepEqual(withoutSuperseded(thread, q)?.map((m) => m.body), ['Q', 'It retries.', 'second', '✓ Right.'])
})

test('withoutSuperseded: nothing superseded, nothing dropped', () => {
  const q = { ...questionOf('q1', 'how'), attempts: [{ answer: 'a', verdict: 'pass' as const }] }
  assert.equal(withoutSuperseded([agent('Q'), human('a'), agent('✓ Right.')], q), undefined)
})

test('threadNoteData: on the question\'s lines, clamped to the file, linked to the question', () => {
  const q = { ...questionOf('q1', 'how'), start: 2, end: 9 }
  const d = threadNoteData(q, ['a', 'b', 'c'], { id: 'n1', at: 'T', checkFile: FILE, session: 'Check · feat/x', done: false, messages: [agent('Q')] })
  assert.deepEqual([d.range, d.status, d.session, d.extra], [{ start: 2, end: 3 }, 'open', 'Check · feat/x', { check: { file: FILE, q: 'q1', h: textHash(q) } }])
  assert.deepEqual(d.messages, [{ ...agent('Q'), at: 'T' }])
})

test('threadNoteData: a question about the whole file has no lines to anchor', () => {
  const d = threadNoteData({ ...questionOf('q3', 'how'), target: 'file' }, ['a'], { id: 'n', at: 'T', checkFile: FILE, session: 's', done: true, messages: [] })
  assert.deepEqual([d.target, d.anchor, d.status], ['file', { text: '', before: '', after: '' }, 'resolved'])
})
