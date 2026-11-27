// A failure said in plain words (src/check/failures.ts): its cause, a failed write, a failed grade, a file that
// stops being JSON; and the skill's start command (src/check/prompts.ts).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { causeOf, gradeFailure, jsonErrorAt, writeFailure } from '../src/check/failures'
import { checkPrompt, startCommand } from '../src/check/prompts'

test('causeOf: the extension\'s own kind first, then the first cause the words name', () => {
  assert.equal(causeOf('anything', 'no-cli'), 'no-cli')
  assert.equal(causeOf('spawn claude ENOENT'), 'no-cli')
  assert.equal(causeOf('model overloaded'), 'model', 'the order of the table decides')
  assert.equal(causeOf('HTTP 429'), 'busy')
  assert.equal(causeOf('HTTP 401'), 'auth')
  assert.equal(causeOf('broke'), 'other')
})

test('jsonErrorAt: the engine\'s words without the quoted text and the place, any engine wording', () => {
  assert.equal(jsonErrorAt('Expected \',\' or \']\' after array element in JSON at position 5 (line 1 column 6)', '[1, 2')?.text, 'Line 1: expected \',\' or \']\' after array element.')
  assert.equal(jsonErrorAt('Unexpected token } in JSON at position 5', '{\n "a"}')?.text, 'Line 2: unexpected token }.')
  assert.equal(jsonErrorAt('Unexpected end of JSON input at position 3', '{"a')?.text, 'Line 1: unexpected end of JSON input.')
})

test('startCommand: the skill script\'s start, as the questions prompt says it', () => {
  const o = { skill: '/s', branch: 'feat/x', base: 'abc', topUp: false, head: 'h1' }
  assert.equal(startCommand(o), '/s/scripts/questions.mjs start --base abc --branch feat/x --head h1')
  assert.equal(startCommand({ ...o, topUp: true, head: undefined }), '/s/scripts/questions.mjs start --top-up')
  assert.match(checkPrompt({ ...o, baseRef: 'origin/main', bundled: false }), /Start with: \/s\/scripts\/questions\.mjs start --base abc --branch feat\/x --head h1\n/)
})

test('a write that failed on the model: said with the model, and the setting offered', () => {
  const r = writeFailure({ error: "There's an issue with the selected model (bogus). Run --model to pick a different model.", model: 'bogus' })
  assert.deepEqual(r, { text: 'Claude couldn\'t use the model "bogus".', setting: true })
})

test('a write that failed for another reason: never the CLI\'s own advice', () => {
  assert.deepEqual(writeFailure({ error: 'Error 529: overloaded' }), { text: 'Claude is busy right now.' })
  assert.equal(writeFailure({ error: 'The process exited. Run --verbose to see more.' }).text, "Claude couldn't write the questions: The process exited.")
  assert.equal(writeFailure({ text: 'I could not write any questions. `questions.mjs add` rejects every file I give it.' }).text, "Claude couldn't write questions for this change.")
  assert.equal(writeFailure({ text: 'UNCOMMITTED: this change is not committed yet' }).text, 'Commit your change first: questions are about committed code.')
})

test('Claude Code not found: the path setting offered', () => {
  const r = writeFailure({ error: "couldn't start Claude Code (/home/a/.local/bin/claude): spawn /home/a/.local/bin/claude ENOENT" })
  assert.deepEqual(r, { text: "Claude Code wasn't found.", path: true })
})

test('a failure the extension raised is said by its kind, whatever its words', () => {
  assert.deepEqual(writeFailure({ error: "couldn't start Claude Code (/x/claude): spawn /x/claude EACCES", errorKind: 'no-cli' }), { text: "Claude Code wasn't found.", path: true })
  assert.equal(gradeFailure('Claude Code was not found.', 'no-cli'), "Claude Code wasn't found; your answer is saved.")
})

for (const [error, said] of [
  ['Claude Code exited (1): API Error: Connection error. (Overloaded) retrying failed', 'Claude is busy right now; your answer is saved.'],
  ['couldn\'t start Claude Code (/x/claude): spawn /x/claude ENOENT', "Claude Code wasn't found; your answer is saved."],
  ['Claude Code isn\'t logged in: 401', "Claude Code isn't signed in; your answer is saved."],
  ['something else', "Claude couldn't check it; your answer is saved."],
]) {
  test(`a failed grade: ${said}`, () => assert.equal(gradeFailure(error), said))
}

test('jsonErrorAt: an unexpected token, at its line and column', () => {
  const unexpected = 'Unexpected token \'}\', "{\n "a"}" is not valid JSON at position 4'
  assert.deepEqual(jsonErrorAt(unexpected, '{\n "a"}'), { line: 2, col: 3, text: 'Line 2: unexpected token \'}\'.' })
})

test('jsonErrorAt: a message that names its line itself', () => {
  const expected = 'Expected double-quoted property name in JSON at position 7 (line 2 column 3)'
  assert.equal(jsonErrorAt(expected, undefined)?.text, 'Line 2: expected double-quoted property name.')
})

test('jsonErrorAt: not a parse error', () => assert.equal(jsonErrorAt('ENOENT: no such file', undefined), undefined))
