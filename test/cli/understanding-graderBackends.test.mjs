// Which grader runs (cli/understanding/graderBackends.ts): Claude Code, or the Anthropic API.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cliModule } from './helpers/source.mjs'
import { FAKE } from './helpers/cli.mjs'

const { pickBackend } = await cliModule('graderBackends')

test('backend choice: the flag; Claude Code when found; the API with a key; else no grader', () => {
  assert.equal(pickBackend({ flag: 'anthropic' }), 'anthropic')
  assert.equal(pickBackend({ env: { UNDERSTANDING_CLAUDE: FAKE } }), 'claude')
  assert.equal(pickBackend({ env: { UNDERSTANDING_CLAUDE: '/nope/claude', PATH: '', ANTHROPIC_API_KEY: 'x' } }), 'anthropic')
  assert.throws(() => pickBackend({ env: { UNDERSTANDING_CLAUDE: '/nope/claude', PATH: '' } }), /no grader/)
  assert.throws(() => pickBackend({ flag: 'gpt' }), /unknown grader backend/)
})
