// Golden tests (test/README.md): the check's Claude parts as they work today: the prompts that write a check and its
// tour, the phase shown while Claude works, failures in plain words.
import { test } from 'node:test'
import { expectGolden } from './golden'
import { checkPhase, checkPrompt, tourPrompt } from '../src/check/prompts'
import { gradeFailure, jsonErrorAt, writeFailure } from '../src/check/failures'

const AREA = 'check-model'

test('golden: the prompts that write a check and its tour, and the phase shown while Claude works', () => {
  const prompts: string[] = []
  for (const bundled of [false, true]) for (const topUp of [false, true]) for (const head of [undefined, 'abc123']) {
    prompts.push(`--- bundled=${bundled} topUp=${topUp} head=${head ?? '-'}\n${checkPrompt({ skill: '/ext/skills/understanding-check', branch: 'feat/x', baseRef: 'origin/main', base: 'abc', topUp, bundled, head })}`)
  }
  for (const bundled of [false, true]) for (const topUp of [false, true]) for (const resumed of [false, true]) {
    prompts.push(`--- tour bundled=${bundled} topUp=${topUp} resumed=${resumed}\n${tourPrompt({ skill: '/ext/skills/understanding-check', journeySkill: '/ext/skills/code-journey', topUp, bundled, resumed })}`)
  }
  expectGolden(AREA, 'prompts', prompts.join('\n\n'))
  const calls = [undefined, { name: 'Read', input: {} }, { name: 'Grep', input: {} }, { name: 'Edit', input: {} },
    ...['start', 'add', 'remove', 'finish', 'tour', 'tour-finish', 'help'].map((c) => ({ name: 'Bash', input: { command: `node /x/questions.mjs ${c} --base main` } })),
    { name: 'Bash', input: { command: 'python3 journey.py step …' } }, { name: 'Bash', input: { command: 'git diff' } }]
  expectGolden(AREA, 'phases', ['starting', 'writing questions', 'writing the tour'].map((prev) => ({ prev, phases: calls.map((t) => checkPhase(t, prev)) })))
})

test('golden: failures in plain words', () => {
  const errors = ['spawn claude ENOENT', "There's an issue with the selected model (bogus). Run --model to pick another.", 'API Error: 529 overloaded', 'rate limit reached', 'Invalid API key · Please run /login', 'Something else broke. More words here.', '']
  const json = (s: string) => { try { JSON.parse(s); return 'valid' } catch (e) { return (e as Error).message } }
  const texts = ['{\n  "a": 1,\n  "b" 2\n}', '{"a":}', '[1, 2', '{\n\n  x\n}']
  expectGolden(AREA, 'failures', {
    grade: errors.map((e) => [e, gradeFailure(e), gradeFailure(e, 'no-cli')]),
    write: [...errors.map((error) => ({ error, model: 'opus' })), { text: 'UNCOMMITTED: 3 files' }, { text: 'NOTHING to ask' }, { text: 'I could not.' }, {}].map((o) => [o, writeFailure(o)]),
    // The engine's own messages (V8's words, Node 22) and messages as other engines word them.
    json: texts.map((t) => [t, json(t), jsonErrorAt(json(t), t) ?? null]),
    jsonWorded: ['Unexpected token } in JSON at position 5', 'Expected property name or \'}\' in JSON at position 2 (line 1 column 3)', 'no place given'].map((m) => [m, jsonErrorAt(m, '{\n "a"}') ?? null]),
  })
})
