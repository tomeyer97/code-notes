// Text as rows and threads show it (src/core/text.ts), Markdown's marks one rule at a time (src/core/markdown.ts),
// and ages (src/core/time.ts).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { markdownAsText, stripEmphasis, stripLineMark, stripLinks } from '../src/core/markdown'
import { isolate, plain, plural, rangeLabel, shortQ } from '../src/core/text'
import { labelSafe } from '../src/core/escape'
import { ago, ageOf, DAY_MS } from '../src/core/time'

test('markdown: links and images as their text', () => {
  assert.equal(stripLinks('see [the docs](http://x) and ![img](a.png)'), 'see the docs and img')
  assert.equal(stripLinks('[a] (b)'), '[a] (b)')
})

test('markdown: a heading or quote mark in front', () => {
  assert.equal(stripLineMark('## Title'), 'Title')
  assert.equal(stripLineMark('  > quoted'), 'quoted')
  assert.equal(stripLineMark('a # not at the start'), 'a # not at the start')
})

test('markdown: bold, strike-through, code, and single emphasis around words only', () => {
  assert.equal(stripEmphasis('**bold** __b__ ~~s~~ `code`'), 'bold b s code')
  assert.equal(stripEmphasis('an *emphasised* _word_'), 'an emphasised word')
  assert.equal(stripEmphasis('snake_case_name and 2*3*4'), 'snake_case_name and 2*3*4')
  assert.equal(stripEmphasis('* a list mark'), '* a list mark')
})

test('plain: the first line with text, marks out, one-spaced, cut', () => {
  assert.equal(plain('\n\n# Is **this**   [needed](x)?\nmore'), 'Is this needed?')
  assert.equal(plain('a'.repeat(100), 10), `${'a'.repeat(9)}…`)
  assert.equal(markdownAsText('> *hi*'), 'hi')
})

test('text: ranges, plurals, short questions, labels, isolates', () => {
  const n = (d: object) => ({ data: { messages: [], range: { start: 3, end: 3 }, ...d } })
  assert.equal(rangeLabel(n({})), 'L3')
  assert.equal(rangeLabel(n({ range: { start: 3, end: 5 } })), 'L3–5')
  assert.equal(rangeLabel(n({ target: 'file' })), 'whole file')
  assert.equal(rangeLabel(n({ target: 'folder' })), 'folder')
  assert.equal(plural(1, 'reply', 'replies'), '1 reply')
  assert.equal(plural(2, 'note'), '2 notes')
  assert.equal(shortQ('a  b\nc', 4), 'a b…')
  assert.equal(labelSafe('<a & b>'), '‹a ＆ b›')
  assert.equal(isolate('plain'), 'plain')
  assert.equal(isolate('שלום'), '⁨שלום⁩')
  assert.equal(isolate('مرحبا'), '⁨مرحبا⁩')
})

test('time: "how long ago" in messages, and the list\'s age', () => {
  const now = Date.parse('2026-11-20T12:00:00Z')
  const at = (ms: number) => new Date(now - ms).toISOString()
  assert.equal(ago(undefined, now), '')
  assert.equal(ago(at(10_000), now), 'just now')
  assert.equal(ago(at(5 * 60_000), now), '5 min ago')
  assert.equal(ago(at(3 * 3_600_000), now), '3 h ago')
  assert.equal(ago(at(2 * DAY_MS), now), '2 d ago')
  assert.equal(ageOf(at(2 * DAY_MS), now), '2 d')
  assert.equal(ageOf(at(1000), now), 'today')
})
