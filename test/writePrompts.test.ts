// What Claude is told when it writes or refreshes a journey (src/write/prompts.ts), as golden text.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { journeyPrompt, journeyRules, refreshPrompt, refreshTask } from '../src/write/prompts'
import { expectGolden } from './golden'

const stage = '.code-notes/.writing/abc'
const installed = '/r/.claude/skills/code-journey'
const bundled = '/ext/skills/code-journey'

test('the prompts, as Claude reads them', () => {
  const one = refreshTask('saving', [{ n: 2, title: 'Reads it' }])
  const two = refreshTask('saving', [{ n: 1, title: 'Saves it' }, { n: 3, title: 'Shows it' }])
  const prompts: [string, string][] = [
    ['write, installed skill', journeyPrompt('make   me a\nmap of auth', installed, stage, 'journeys')],
    ['write, bundled skill', journeyPrompt('map of auth', bundled, stage, 'docs/journeys', true)],
    ['write, after the person answered (the rules alone)', journeyRules(bundled, stage, 'journeys')],
    ['refresh one step, bundled skill', refreshPrompt(bundled, stage, one, true)],
    ['refresh two steps, installed skill', refreshPrompt(installed, stage, two, false)],
  ]
  expectGolden('write', 'prompts', prompts.map(([name, p]) => `=== ${name}\n${p}\n`).join('\n'))
})

test('the prompt treats the words as a request and writes into the staging folder', () => {
  const p = journeyPrompt('make   me a\nmap of auth', installed, stage, 'journeys')
  assert.match(p, /^Use the code-journey skill to answer: make me a map of auth\n/)
  assert.match(p, /a request, not the journey's question/)
  assert.match(p, /--dir \.code-notes\/\.writing\/abc`/)
  assert.match(p, /moves the journey into journeys\//)
  assert.match(p, /clarifying question/)
  assert.match(p, /ANSWERED_BY: journeys\/<slug>\.json/, 'a journey that already answers is named on its own line')
  const b = journeyPrompt('map of auth', bundled, stage, 'journeys', true)
  assert.match(b, /^Read \/ext\/skills\/code-journey\/SKILL\.md and follow it exactly .* to answer: map of auth\n/, 'the bundled skill is read as a file')
})
