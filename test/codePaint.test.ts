// media/code-paint.js's tokens: a line of code split into coloured pieces, by the file's language.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pageModule } from './pageModule'

type Lang = { keywords: Set<string>; hash: boolean }
const { tokens, langOf } = pageModule<{ tokens(text: string, lang: Lang): { text: string; cls: string }[]; langOf(file: string): Lang }>('media/code-paint.js')
/** The coloured pieces only, as `cls:text`. */
const painted = (text: string, file: string) => tokens(text, langOf(file)).filter((t) => t.cls).map((t) => `${t.cls}:${t.text}`)

test('the pieces put back together are the line', () => {
  const line = 'if (err != nil) { return fmt.Errorf("charge %d: %w", id, err) } // 2 tries'
  assert.equal(tokens(line, langOf('a.go')).map((t) => t.text).join(''), line)
})

test("keywords are the file's language's: map and type are names in JavaScript, keywords in Go", () => {
  assert.deepEqual(painted('const type = map(x)', 'src/a.js'), ['k:const', 'f:map'])
  assert.deepEqual(painted('type T = map(x)', 'src/a.ts'), ['k:type', 'f:map'])
  assert.deepEqual(painted('type m map[string]int', 'a.go'), ['k:type', 'k:map'])
  assert.deepEqual(painted('def go(self): return None', 'a.py'), ['k:def', 'f:go', 'k:self', 'k:return', 'k:None'])
})

test('# starts a comment where the language says so; elsewhere only the sign is skipped', () => {
  assert.deepEqual(painted('x = 1 # one', 'a.py'), ['n:1', 'c:# one'])
  assert.deepEqual(painted('RUN make # build', 'Dockerfile'), ['c:# build'])
  assert.deepEqual(painted('a = b #c', 'a.js'), [])
  assert.deepEqual(painted('x.#priv = 1', 'a.js'), ['n:1'])
})

test('a file of no known language gets every language\'s keywords', () => {
  assert.deepEqual(painted('if x then nil', 'notes.txt'), ['k:if', 'k:nil'])
})

test('each call reads its own line: a called name is seen at the end of a match, not from shared state', () => {
  const go = langOf('a.go')
  assert.deepEqual(tokens('run(', go).map((t) => t.cls), ['f', ''])
  assert.deepEqual(tokens('run', go).map((t) => t.cls), [''])
  assert.deepEqual(tokens('"s" // c', go).map((t) => t.cls), ['s', '', 'c'])
})
