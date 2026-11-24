// What Claude is asked to write the questions and the tour, and the phases its tool calls are shown as
// (src/check/prompts.ts).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkPhase, checkPrompt, tourPrompt } from '../src/check/prompts'
import { bashCall } from './toolCalls'

test('the questions prompt names the skill, the script and the base', () => {
  const p = checkPrompt({ skill: '/ext/skills/understanding-check', branch: 'feat/x', baseRef: 'origin/main', base: 'abc123', topUp: false, bundled: true })
  assert.match(p, /Read \/ext\/skills\/understanding-check\/SKILL\.md and follow it exactly/)
  assert.match(p, /questions\.mjs start --base abc123/)
})

test('a top-up asks for the new part only', () => {
  const t = checkPrompt({ skill: '/s', branch: 'feat/x', baseRef: 'origin/main', base: 'abc', topUp: true, bundled: false })
  assert.match(t, /Use the understanding-check skill to add 1-2 questions/)
  assert.match(t, /start --top-up/)
})

for (const [call, from, phase] of [
  [bashCall('/s/scripts/questions.mjs start --base x'), 'starting', 'reading the change'],
  [{ name: 'Read', input: {} }, 'reading the change', 'reading the code'],
  [bashCall('/s/scripts/questions.mjs add --kind why'), 'reading the code', 'writing questions'],
  [{ name: 'Read', input: {} }, 'writing questions', 'writing questions'],
  [bashCall('/s/scripts/questions.mjs finish'), 'writing questions', 'checking'],
] as const) {
  test(`questions phase: ${from} → ${phase}`, () => assert.equal(checkPhase(call, from), phase))
}

test('the tour prompt goes on in the questions\' session and names both skills', () => {
  const p = tourPrompt({ skill: '/ext/skills/understanding-check', journeySkill: '/ext/skills/code-journey', topUp: false, bundled: true, resumed: true })
  assert.match(p, /^Now write the tour of this change/)
  assert.match(p, /section "The tour" of \/ext\/skills\/understanding-check\/SKILL\.md/)
  assert.match(p, /Start with: \/ext\/skills\/understanding-check\/scripts\/questions\.mjs tour$/m)
  assert.match(p, /\/ext\/skills\/code-journey\/scripts\/journey\.py/)
})

test('a tour prompt not resumed starts on its own; a top-up says so', () => {
  assert.match(tourPrompt({ skill: '/s', journeySkill: '/j', topUp: true, bundled: false, resumed: false }), /^Write the tour[\s\S]*questions\.mjs tour --top-up/)
})

for (const [call, from, phase] of [
  [bashCall('/s/scripts/questions.mjs tour'), 'starting', 'writing the tour'],
  [bashCall('/j/scripts/journey.py step /r tour api …'), 'reading the code', 'writing the tour'],
  [{ name: 'Read', input: {} }, 'writing the tour', 'writing the tour'],
  [bashCall('/s/scripts/questions.mjs tour-finish --steps q1=2'), 'writing the tour', 'checking'],
] as const) {
  test(`tour phase: ${from} → ${phase}`, () => assert.equal(checkPhase(call, from), phase))
}
