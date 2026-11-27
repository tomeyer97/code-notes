// A controller's explanation as a transient hint (src/core/bridge/hint.ts): shown beside the revealed lines, gone on
// the next edit in that file, when the caret leaves the lines, on Esc (dismiss), or when another reveal replaces it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { endsHint, HintState, hintLabel, LABEL_MAX, TransientHint } from '../src/core/bridge/hint'

const FILE = 'file:///shop/src/cart.ts'
const OTHER = 'file:///shop/src/tax.ts'
const shown: HintState = { uri: FILE, start: 11, end: 19, text: 'Adds the **tax**, then rounds.', author: 'Desk' }

/** A hint whose every change is kept (each state, none for gone). */
function hint() {
  const changes: (HintState | undefined)[] = []
  return { h: new TransientHint((s) => changes.push(s)), changes }
}

test('endsHint: an edit in its file, the caret out of its lines', () => {
  assert.equal(endsHint(shown, { kind: 'edit', uri: FILE }), true)
  assert.equal(endsHint(shown, { kind: 'selection', uri: FILE, line: 10 }), true, 'above the lines')
  assert.equal(endsHint(shown, { kind: 'selection', uri: FILE, line: 20 }), true, 'below the lines')
})

test('endsHint: the caret within its lines, or anything in another file, leaves it', () => {
  for (const line of [11, 15, 19]) assert.equal(endsHint(shown, { kind: 'selection', uri: FILE, line }), false, `line ${line}`)
  assert.equal(endsHint(shown, { kind: 'edit', uri: OTHER }), false)
  assert.equal(endsHint(shown, { kind: 'selection', uri: OTHER, line: 0 }), false)
})

test('TransientHint: shown, replaced by the next reveal, gone on the first event that ends it', () => {
  const { h, changes } = hint()
  h.show(shown)
  assert.deepEqual(h.state, shown)
  h.notice({ kind: 'selection', uri: FILE, line: 12 })
  assert.equal(changes.length, 1, 'the caret within the lines: still shown')
  const next = { ...shown, uri: OTHER, start: 0, end: 0, text: 'Another.' }
  h.show(next)
  assert.deepEqual(h.state, next, 'another reveal replaces it')
  h.notice({ kind: 'edit', uri: FILE })
  assert.deepEqual(h.state, next, 'an edit in the old file: nothing shown there any more')
  h.notice({ kind: 'edit', uri: OTHER })
  assert.equal(h.state, undefined)
  assert.deepEqual(changes, [shown, next, undefined])
})

test('TransientHint: dismiss (Esc, the command) ends it once; with nothing shown it says nothing', () => {
  const { h, changes } = hint()
  h.dismiss()
  assert.deepEqual(changes, [], 'nothing shown: nothing to say')
  h.show(shown)
  h.dismiss()
  h.dismiss()
  assert.deepEqual(changes, [shown, undefined])
})

test('TransientHint: its state is a copy (a caller cannot change what is shown)', () => {
  const { h } = hint()
  const given = { ...shown }
  h.show(given)
  given.text = 'changed'
  h.state!.end = 99
  assert.deepEqual(h.state, shown)
})

test('hintLabel: the first line, as plain text, cut to fit beside the code', () => {
  assert.equal(hintLabel('Adds the **tax**, then [rounds](https://x).\n\nMore below.'), 'Adds the tax, then rounds.')
  assert.equal(hintLabel('\n\n  `total`   is   cents  '), 'total is cents')
  const long = hintLabel('word '.repeat(60))
  assert.equal(long.length, LABEL_MAX)
  assert.ok(long.endsWith('…'))
})
