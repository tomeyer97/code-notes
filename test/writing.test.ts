import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clock, journeyPrompt, minutes, modelProblem, phaseOf } from '../src/writing'
import { foldEvent } from '../src/claude'
import { linkify } from '../src/answerLinks'
import { scoreJourney, tellingWords } from '../src/match'

test('elapsed time and a plain phase from journey.py commands', () => {
  assert.equal(clock(80_500), '1:20')
  assert.equal(clock(5_000), '0:05')
  assert.equal(minutes(130_000), '2 min')
  assert.equal(minutes(20_000), 'under a minute')
  const bash = (command: string) => ({ name: 'Bash', input: { command } })
  assert.equal(phaseOf({ name: 'Read', input: { file_path: 'a.ts' } }, 'starting'), 'reading the code')
  assert.equal(phaseOf(bash('/s/scripts/journey.py --dir .code-notes/.writing/x new . slug "Q?" "T"'), 'reading the code'), 'drawing the map')
  assert.equal(phaseOf(bash('/s/scripts/journey.py node . slug a function "x"'), 'reading the code'), 'drawing the map')
  assert.equal(phaseOf(bash('/s/scripts/journey.py --dir=x step . slug a src/a.ts 1 2 "t"'), 'drawing the map'), 'writing the steps')
  assert.equal(phaseOf(bash('/s/scripts/journey.py --dir x link . slug 2 "stores it" src/a.ts 4'), 'writing the steps'), 'adding links and animations')
  assert.equal(phaseOf(bash('/s/scripts/journey.py --dir x scene . slug 2'), 'adding links and animations'), 'adding links and animations')
  assert.equal(phaseOf(bash('/s/scripts/journey.py --dir x check . slug quiet'), 'writing the steps'), 'checking')
  assert.equal(phaseOf({ name: 'Read', input: {} }, 'writing the steps'), 'writing the steps', 'reading more while writing steps stays there')
  assert.equal(phaseOf(bash('ls'), 'checking'), 'checking')
  assert.equal(phaseOf(undefined, 'starting'), 'starting')
})

test('the finished tool call reaches progress (for the phase)', () => {
  const state: any = { text: '' }
  foldEvent(state, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'journey.py check . x' } }] } }))
  assert.deepEqual(state.tool, { name: 'Bash', input: { command: 'journey.py check . x' } })
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

test('references in answers are links, inside parentheses and lists, never with the home path', () => {
  const link = (t: string, f: string, l?: string) => `[${t}](cmd:${f}:${l ?? 1})`
  const L = (s: string) => linkify(s, '/home/me/repo', '/home/me', link)
  assert.equal(L('see (src/a.ts:12)'), 'see ([src/a.ts:12](cmd:src/a.ts:12))')
  assert.equal(L('- `src/a.ts:3`'), '- [`src/a.ts:3`](cmd:src/a.ts:3)')
  assert.equal(L('in /home/me/repo/src/a.ts:7 here'), 'in [src/a.ts:7](cmd:src/a.ts:7) here')
  assert.equal(L('([a.ts:7](/home/me/repo/src/a.ts:7))'), '([a.ts:7](cmd:src/a.ts:7))')
  assert.equal(L('[`src/x.ts:3`](src/x.ts:3)'), '[`src/x.ts:3`](cmd:src/x.ts:3)', 'no link nested in a link label')
  assert.equal(L('[x](src/x.ts#L4)'), '[x](cmd:src/x.ts:4)')
  assert.equal(L('lines src/a.ts:12-20.'), 'lines [src/a.ts:12-20](cmd:src/a.ts:12).')
  assert.equal(L('outside /home/me/other/b.ts:2'), 'outside ~/other/b.ts:2', 'outside the repo: no link, no home path')
  assert.equal(L('[docs](https://example.com/a/b.md:3)'), '[docs](https://example.com/a/b.md:3)')
  assert.equal(L('![shot](img/a.png)'), '[image: shot](img/a.png)')
})

test('a journey matches most of the telling words, with synonyms; title and question count most', () => {
  const j = { title: 'Change a shipping address', question: 'How does the shipping address of an order get updated?', summary: 'The address is updated without a new order.', steps: ['The page posts the new address'] }
  assert.deepEqual(tellingWords('How does the code work?'), [])
  assert.ok(scoreJourney(j, 'How do we change the address of an order?').answers, '"change" finds "update"')
  assert.ok(scoreJourney(j, 'How are shipping addresses updated?').answers)
  assert.ok(!scoreJourney(j, 'How are widgets frobnicated?').answers)
  const s = scoreJourney(j, 'How is an address deleted and billed?')
  assert.ok(!s.answers && s.matched === 1, 'one word of three is not enough')
  const head = scoreJourney(j, 'address'), tail = scoreJourney({ ...j, title: 'x', question: 'y?' }, 'address')
  assert.ok(head.weight > tail.weight, 'title/question weigh more than the summary')
})

test('models are aliases or claude-* ids', () => {
  for (const m of [undefined, '', 'sonnet', 'Opus', 'haiku', 'fable', 'sonnet[1m]', 'claude-sonnet-4-5', 'claude-fable-5-2'])
    assert.equal(modelProblem(m), undefined, String(m))
  assert.equal(modelProblem('sonet'), "Unknown model 'sonet'. Use sonnet, opus, haiku or fable.")
  assert.ok(modelProblem('gpt-5') && modelProblem('fake-model-x') && modelProblem('--dangerous'))
})
