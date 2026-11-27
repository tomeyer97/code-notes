// Adding a note: what the lists and toasts make of a note whose first message is not text (a menu's argument once
// saved as the body, a note file written by hand). The commands themselves: test/integration/main/notesAdd.ts.
import test from 'node:test'
import assert from 'node:assert/strict'
import { describeNotes, noteTitle, plain } from '../src/core/text'

const note = (body: unknown) => ({ data: { messages: [{ author: 'a', role: 'human' as const, body: body as string, at: '' }], range: { start: 1, end: 1 } } })

test('plain: anything but a string is no text', () => {
  for (const body of [{ groupId: 0, editorIndex: 1 }, [{ path: '/src' }], 42, null, undefined]) assert.equal(plain(body), '')
  assert.equal(plain('  \n**Why** this?\nmore'), 'Why this?', 'a string as before')
})

test('noteTitle and describeNotes: a non-string first message names no note, and throws nothing', () => {
  assert.equal(noteTitle(note({ groupId: 0, editorIndex: 1 })), '')
  assert.equal(describeNotes([note(['a'])]), '""')
  assert.equal(noteTitle(note('Is this file still used?')), 'Is this file still used?')
})
