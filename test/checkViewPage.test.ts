// The Check view page's text helpers (media/codeSpans.js): `names` in backticks drawn as code, and said without them.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pageModule } from './pageModule'

const { codeSpans, plainText } = pageModule<{ codeSpans(t: string): unknown[]; plainText(t: string): string }>('media/codeSpans.js')

/** Just enough of a document for el(): an element is its tag, class and text. */
const fakeDocument = { createElement: (tag: string) => ({ tag, className: '', textContent: '' }) }

test('codeSpans: the pieces between backticks are code, the rest plain text; empty pieces dropped', () => {
  const g = globalThis as { document?: unknown }
  const before = g.document
  g.document = fakeDocument
  try {
    const parts = codeSpans('What does `takeJob` return for `a`?')
    assert.deepEqual(parts.map((p) => (typeof p === 'string' ? p : `<${(p as { tag: string }).tag}>${(p as { textContent: string }).textContent}`)), [
      'What does ', '<code>takeJob', ' return for ', '<code>a', '?',
    ])
    assert.deepEqual(codeSpans('`x`'), [{ tag: 'code', className: '', textContent: 'x' }])
    assert.deepEqual(codeSpans('no code'), ['no code'])
    assert.deepEqual(codeSpans(''), [])
  } finally {
    g.document = before
  }
})

test('plainText: what a screen reader hears, without the backticks', () => {
  assert.equal(plainText('What does `takeJob` return?'), 'What does takeJob return?')
})
