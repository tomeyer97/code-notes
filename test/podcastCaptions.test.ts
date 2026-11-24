import { test } from 'node:test'
import assert from 'node:assert/strict'
import { captionParts, charClock, partAt, sentencesOf } from '../src/podcast/captions'

// The caption's timing (src/podcast/captions.ts), which the listening page runs as it is: sentences and their times,
// the marks anchoring when words are said, parts of two lines, the speaker when the voice changes.

const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≈ ${b}`)

test('the file\'s own sentence times are used as they are, each to the next one\'s start', () => {
  const s = sentencesOf({ start: 2, end: 6, text: 'A b. C d.', sentences: [{ start: 2, text: 'A b.' }, { start: 3.5, text: 'C d.' }] })
  assert.deepEqual(s, [{ start: 2, end: 3.5, text: 'A b.' }, { start: 3.5, end: 6, text: 'C d.' }])
})

test('without them, sentences are cut at . ! ? … and timed by their share of the characters', () => {
  const text = 'It reads repo.ReadTestFile first. Then what? “Done.” And on…'
  const s = sentencesOf({ start: 10, end: 10 + text.length, text })
  assert.deepEqual(s.map((x) => x.text), ['It reads repo.ReadTestFile first.', 'Then what?', '“Done.”', 'And on…'])
  // One character a second here: each sentence starts at its offset.
  for (const x of s) near(x.start, 10 + text.indexOf(x.text))
  near(s[s.length - 1].end, 10 + text.length)
})

test('a segment that ends before it starts is said in no time', () => {
  const s = sentencesOf({ start: 5, end: 4, text: 'One. Two.' })
  assert.ok(s.every((x) => x.start === 5 && x.end === 5))
})

test('marks anchor when their phrase is said; between them the characters share the time', () => {
  const text = 'aaaa bbbb cccc'
  // Without marks: linear over 14 characters in 14 s.
  near(charClock({ start: 0, end: 14, text }, 14)(5), 5)
  // "bbbb" said at 10 s: the first five characters take 10 s, the rest 4 s.
  const clock = charClock({ start: 0, end: 14, text, marks: [{ phrase: 'bbbb', at: 10 }] }, 14)
  near(clock(5), 10)
  near(clock(2.5), 5)
  near(clock(14), 14)
  // A mark out of order, outside the segment, or not in the text is left out.
  const bad = charClock({ start: 0, end: 14, text, marks: [{ phrase: 'cccc', at: 20 }, { phrase: 'zz', at: 3 }, { phrase: 'bbbb', at: 'x' }] }, 14)
  near(bad(5), 5)
})

test('caption parts: the speaker before the first part when the voice changes, and only with two voices', () => {
  const segments = [
    { start: 0, end: 2, text: 'Hello there.', speaker: 'host' },
    { start: 2, end: 4, text: 'Hi. <b>yes</b>', speaker: 'guest' },
    { start: 4, end: 6, text: 'More.', speaker: 'guest' },
  ]
  assert.deepEqual(captionParts(segments, 1, undefined).map((p) => p.html), ['<b class="pod-who">Guest:</b> Hi.', '&lt;b&gt;yes&lt;/b&gt;'])
  assert.deepEqual(captionParts(segments, 2, undefined).map((p) => p.html), ['More.'])
  assert.deepEqual(captionParts([{ ...segments[0], speaker: 'guest' }, segments[1]], 1, undefined).map((p) => p.html), ['Hi.', '&lt;b&gt;yes&lt;/b&gt;'])
})

test('a sentence too long for two lines is said in parts, each from when its first word is said', () => {
  const text = 'one two three four five six'
  // "Fits" while the part is at most 13 characters of text.
  const fits = (html: string) => html.length <= 13
  const parts = captionParts([{ start: 0, end: text.length, text, speaker: 'host' }], 0, fits)
  assert.deepEqual(parts.map((p) => p.html), ['one two three', 'four five six'])
  near(parts[1].start, text.indexOf('four'))
  assert.equal(partAt(parts, 0)?.html, 'one two three')
  assert.equal(partAt(parts, 13.9)?.html, 'one two three')
  assert.equal(partAt(parts, 14)?.html, 'four five six')
  assert.equal(partAt([], 3), undefined)
})
