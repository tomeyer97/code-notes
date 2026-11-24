// A TODO comment about a concern (src/check/todoComment.ts): its lines, where it goes, the file's comment marks.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { commentMark, commentMarkFor, opensNextBlock, todoLines, todoPlace, wrapWords } from '../src/check/todoComment'

const LONG = 'The stock update in the refund loop adds every refunded unit back to products with no restock option, so unreturned or damaged goods inflate stock.'

test('wrapWords: lines of at most the width, at words, nothing cut', () => {
  const lines = wrapWords(LONG, 40)
  assert.ok(lines.every((l) => l.length <= 40), JSON.stringify(lines))
  assert.equal(lines.join(' '), LONG)
})

test('wrapWords: a word longer than the width gets a line of its own', () => {
  assert.deepEqual(wrapWords('a verylongword b', 5), ['a', 'verylongword', 'b'])
})

test('a short concern: one line', () => {
  assert.deepEqual(todoLines(['//', ''], 'Stock goes up for damaged units.'), ['// TODO: Stock goes up for damaged units.'])
})

test('a long concern: wrapped within 100 characters, nothing cut, lined up under the text', () => {
  const t = todoLines(['//', ''], LONG)
  assert.ok(t.length === 2 && t.every((l) => l.length <= 100), JSON.stringify(t))
  assert.equal(t.map((l, i) => (i ? l.replace(/^\/\/\s+/, '') : l.replace(/^\/\/ TODO: /, ''))).join(' '), LONG)
  assert.match(t[1], /^\/\/ {7}\S/)
})

test('a block comment: one opening mark and one closing mark around all its lines', () => {
  const h = todoLines(['<!--', ' -->'], LONG)
  assert.ok(h[0].startsWith('<!-- TODO: ') && h.at(-1)!.endsWith(' -->') && !h[0].endsWith('-->'), JSON.stringify(h))
})

const CODE = ['  try {', '    run()', '  } catch (err) {', '    log(err)', '  }']

test('a TODO goes above its line, at its indentation', () => {
  assert.deepEqual(todoPlace(CODE, 1), { line: 1, indent: '    ' })
})

test('a line that closes a block and opens the next: the TODO goes inside the block it opens', () => {
  assert.deepEqual(todoPlace(CODE, 2), { line: 3, indent: '    ' })
})

test('opensNextBlock: "} catch {", "} else {", "]):"; not a plain closing brace', () => {
  assert.deepEqual(['} catch (e) {', '} else {', ']):', '}', 'if (x) {'].map(opensNextBlock), [true, true, true, false, false])
})

test('commentMark: by the file\'s name', () => {
  const marks = [commentMark('a/b.py'), commentMark('x/Dockerfile'), commentMark('a.vue'), commentMark('a.ts')]
  assert.deepEqual(marks, [['#', ''], ['#', ''], ['<!--', ' -->'], ['//', '']])
})

test('commentMarkFor: by the document\'s language; a language not known here (or plain text): by the file\'s name', () => {
  assert.deepEqual(commentMarkFor('powershell', 'a.ps1'), ['#', ''])
  assert.deepEqual(commentMarkFor('ini', 'setup.cfg'), [';', ''])
  assert.deepEqual(commentMarkFor('plaintext', 'main.tf'), ['#', ''])
  assert.deepEqual(commentMarkFor('go', 'main.go'), ['//', ''])
})
