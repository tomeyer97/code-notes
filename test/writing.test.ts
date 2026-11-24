import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clock, journeyPrompt, minutes, phaseOf } from '../src/core/writing'
import { bashCall } from './toolCalls'

test('elapsed time and a plain phase from journey.py commands', () => {
  assert.equal(clock(80_500), '1:20')
  assert.equal(clock(5_000), '0:05')
  assert.equal(minutes(130_000), '2 min')
  assert.equal(minutes(20_000), 'under a minute')
  assert.equal(phaseOf({ name: 'Read', input: { file_path: 'a.ts' } }, 'starting'), 'reading the code')
  assert.equal(phaseOf(bashCall('/s/scripts/journey.py --dir .code-notes/.writing/x new . slug "Q?" "T"'), 'reading the code'), 'drawing the map')
  assert.equal(phaseOf(bashCall('/s/scripts/journey.py node . slug a function "x"'), 'reading the code'), 'drawing the map')
  assert.equal(phaseOf(bashCall('/s/scripts/journey.py --dir=x step . slug a src/a.ts 1 2 "t"'), 'drawing the map'), 'writing the steps')
  assert.equal(phaseOf(bashCall('/s/scripts/journey.py --dir x link . slug 2 "stores it" src/a.ts 4'), 'writing the steps'), 'adding links and animations')
  assert.equal(phaseOf(bashCall('/s/scripts/journey.py --dir x scene . slug 2'), 'adding links and animations'), 'adding links and animations')
  assert.equal(phaseOf(bashCall('/s/scripts/journey.py --dir x check . slug quiet'), 'writing the steps'), 'checking')
  assert.equal(phaseOf({ name: 'Read', input: {} }, 'writing the steps'), 'writing the steps', 'reading more while writing steps stays there')
  assert.equal(phaseOf(bashCall('ls'), 'checking'), 'checking')
  assert.equal(phaseOf(undefined, 'starting'), 'starting')
})

test('the prompt treats the words as a request and writes into the staging folder', () => {
  const p = journeyPrompt('make   me a\nmap of auth', '/r/.claude/skills/code-journey', '.code-notes/.writing/abc', 'journeys')
  assert.match(p, /^Use the code-journey skill to answer: make me a map of auth\n/)
  assert.match(p, /a request, not the journey's question/)
  assert.match(p, /--dir \.code-notes\/\.writing\/abc`/)
  assert.match(p, /moves the journey into journeys\//)
  assert.match(p, /clarifying question/)
  const b = journeyPrompt('map of auth', '/ext/skills/code-journey', '.code-notes/.writing/abc', 'journeys', true)
  assert.match(b, /^Read \/ext\/skills\/code-journey\/SKILL\.md and follow it exactly .* to answer: map of auth\n/, 'the bundled skill is read as a file')
})
