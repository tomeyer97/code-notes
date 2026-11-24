// The check's failures by cause (src/check/failures.ts) and the skill's start command (src/check/prompts.ts).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { causeOf, jsonErrorAt } from '../src/check/failures'
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
