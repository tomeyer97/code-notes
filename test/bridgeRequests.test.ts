// A controller's requests read before anything runs (src/core/bridge/requests.ts): the frame, then each method's
// params, with the reason sent back when they can't be used.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isMethod, MAX_TEXT, readContextGet, readFrame, readJourneyPlay, readNoteAdd, readReveal } from '../src/core/bridge/requests'

test('readFrame: a request has a type and an id; anything else is ignored', () => {
  assert.deepEqual(readFrame('{"type":"request","id":"1","method":"reveal","params":{"a":1}}'), { type: 'request', id: '1', method: 'reveal', params: { a: 1 } })
  assert.deepEqual(readFrame('{"type":"request","id":"2"}'), { type: 'request', id: '2', method: '', params: undefined }, 'no method: answered as unknown')
  for (const x of ['', 'nope', '[]', '{"type":"request"}', '{"type":"request","id":""}', '{"type":"response","id":"1"}', '{"id":"1","method":"reveal"}']) {
    assert.equal(readFrame(x), undefined, x)
  }
})

test('isMethod: the four methods', () => {
  for (const m of ['reveal', 'journey.play', 'note.add', 'context.get']) assert.equal(isMethod(m), true, m)
  for (const m of ['', 'Reveal', 'note.delete', 'toString']) assert.equal(isMethod(m), false, m)
})

test('readReveal: file and 1-based lines, end defaulting to start; text optional, blank text none', () => {
  assert.deepEqual(readReveal({ file: 'src/a.ts', start: 3, end: 5, text: 'Why' }), { ok: true, value: { file: 'src/a.ts', start: 3, end: 5, text: 'Why' } })
  assert.deepEqual(readReveal({ file: 'src/a.ts', start: 3 }), { ok: true, value: { file: 'src/a.ts', start: 3, end: 3 } })
  assert.deepEqual(readReveal({ file: 'src/a.ts', start: 3, end: 3, text: '  ' }), { ok: true, value: { file: 'src/a.ts', start: 3, end: 3 } })
})

test('readReveal: what is refused, and why', () => {
  const why = (p: unknown) => { const r = readReveal(p); return r.ok ? 'ok' : r.error }
  assert.equal(why(undefined), 'params: an object is needed')
  assert.equal(why({ start: 1 }), 'file: a path is needed')
  assert.equal(why({ file: 'a', start: 0 }), 'start: a line number (1-based) is needed')
  assert.equal(why({ file: 'a', start: 1.5 }), 'start: a line number (1-based) is needed')
  assert.equal(why({ file: 'a', start: 4, end: 2 }), 'end: a line number at or after start')
  assert.equal(why({ file: 'a', start: 1, text: 7 }), 'text: text is needed')
  assert.equal(why({ file: 'a', start: 1, text: 'x'.repeat(MAX_TEXT + 1) }), `text: longer than ${MAX_TEXT} characters`)
})

test('readJourneyPlay: an id; the step by number or id; a folder', () => {
  assert.deepEqual(readJourneyPlay({ id: 'saving' }), { ok: true, value: { id: 'saving' } })
  assert.deepEqual(readJourneyPlay({ id: 'saving', step: 2, folder: '/w' }), { ok: true, value: { id: 'saving', step: 2, folder: '/w' } })
  assert.deepEqual(readJourneyPlay({ id: 'saving', step: 's-b' }), { ok: true, value: { id: 'saving', step: 's-b' } })
  assert.deepEqual(readJourneyPlay({}), { ok: false, error: 'id: a journey id is needed' })
  assert.deepEqual(readJourneyPlay({ id: 'x', step: 0 }), { ok: false, error: 'step: a step number (1-based) or a step id' })
  assert.deepEqual(readJourneyPlay({ id: 'x', folder: 3 }), { ok: false, error: 'folder: a workspace folder path or URI' })
})

test('readNoteAdd: lines, a body and a session are all needed', () => {
  assert.deepEqual(readNoteAdd({ file: 'a.ts', start: 1, end: 2, body: 'Look', session: ' review ' }),
    { ok: true, value: { file: 'a.ts', start: 1, end: 2, body: 'Look', session: 'review' } })
  assert.deepEqual(readNoteAdd({ file: 'a.ts', start: 1, session: 's' }), { ok: false, error: 'body: text is needed' })
  assert.deepEqual(readNoteAdd({ file: 'a.ts', start: 1, body: ' ', session: 's' }), { ok: false, error: 'body: text is needed' })
  assert.deepEqual(readNoteAdd({ file: 'a.ts', start: 1, body: 'b' }), { ok: false, error: 'session: a session name is needed' })
})

test('readContextGet: no params, or selectionText to also get the selected text', () => {
  assert.deepEqual(readContextGet(undefined), { ok: true, value: {} })
  assert.deepEqual(readContextGet({ selectionText: true }), { ok: true, value: { selectionText: true } })
  assert.deepEqual(readContextGet({ selectionText: 'yes' }), { ok: true, value: {} }, 'only true asks for text')
  assert.deepEqual(readContextGet(3), { ok: false, error: 'params: an object, or none' })
})
