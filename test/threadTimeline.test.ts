import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hiddenReplies, timeline, type TimelineEntry } from '../src/threads/timeline'
import type { NoteEvent } from '../src/core/format/noteModel'

const at = (min: number) => new Date(Date.UTC(2026, 0, 1, 0, min)).toISOString()
const now = Date.UTC(2026, 0, 2)
const short = (e: TimelineEntry) =>
  e.kind === 'message' ? `m${e.index}${e.dated ? '?' : ''}` : e.kind === 'event' ? e.event.type : e.kind === 'showEarlier' ? `+${e.count}` : 'fewer'

test('status changes go where they happened among the messages; undated messages take none; the rest at the end', () => {
  const messages = [{ at: at(0) }, { at: at(10) }, {}, { at: at(30) }]
  const ev = (type: NoteEvent['type'], m: number): NoteEvent => ({ type, by: 'ann', at: at(m) })
  const events = [ev('resolved', 5), ev('reopened', 20), ev('resolved', 40)]
  const none = hiddenReplies(messages.length, 0, false)
  assert.deepEqual(timeline(messages, events, none, false, now).map(short), ['m0', 'resolved', 'm1', 'm2', 'reopened', 'm3', 'resolved'])
})

test('a long thread hides its read replies between the first and the last few, or none when it would hide one', () => {
  assert.deepEqual(hiddenReplies(10, 10, false), { from: 1, to: 7 })
  assert.deepEqual(hiddenReplies(10, 4, false), { from: 1, to: 4 }, 'the unread ones stay')
  assert.deepEqual(hiddenReplies(10, 2, false), { from: 1, to: 1 }, 'fewer than two: none')
  assert.deepEqual(hiddenReplies(6, 6, false), { from: 1, to: 1 }, 'not long')
  assert.deepEqual(hiddenReplies(10, 10, true), { from: 1, to: 1 }, 'expanded')
  const messages = Array.from({ length: 8 }, (_, i) => ({ at: at(i) }))
  const hidden = hiddenReplies(8, 8, false)
  assert.deepEqual(timeline(messages, [], hidden, false, now).map(short), ['m0', '+4', 'm5', 'm6', 'm7'])
  assert.deepEqual(timeline(messages, [], hiddenReplies(8, 8, true), true, now).map(short), ['m0', 'fewer', 'm1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7'])
})

test('a clock that is off (future, or before the message above) keeps no time: its stored date instead', () => {
  const messages = [{ at: at(30) }, { at: at(0) }, { at: '2027-05-01T00:00:00Z' }, { at: at(31) }]
  const t = timeline(messages, [], { from: 1, to: 1 }, false, now)
  assert.deepEqual(t.map(short), ['m0', 'm1?', 'm2?', 'm3'])
  assert.deepEqual(t.map((e) => (e.kind === 'message' ? e.dated ?? e.time : undefined)),
    [Date.parse(at(30)), '2026-01-01', '2027-05-01', Date.parse(at(31))])
})
