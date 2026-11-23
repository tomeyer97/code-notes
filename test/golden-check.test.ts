// Golden tests (test/README.md): the Check view's pure pieces that are not driven by a check file (the CLI flow is
// test/cli/golden-understanding.test.mjs): the prompts Claude gets, failures in plain words, TODO comments, the
// view's names and the messages its page may send, text split at code links.
import { test } from 'node:test'
import { expectGolden } from './golden'
import { checkPhase, checkPrompt, tourPrompt } from '../src/check/prompts'
import { gradeFailure, jsonErrorAt, writeFailure } from '../src/check/failures'
import { commentMark, todoLines, todoPlace } from '../src/check/todoComment'
import { ACTIONS, busyLabel, definedOnly, KIND_LABEL, linkParts, STATE_WORD } from '../src/check/viewModel'
import { CHECK_VIEW_REPORTS, CHECK_VIEW_REQUESTS } from '../src/check/viewMessages'
import { missingMessages, retryText, SAY_IT_BACK } from '../src/check/threadText'
import * as C from '../src/check/constants'

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

test('golden: TODO comments placed in code', () => {
  const code = ['def f(x):', '    if x:', '        return 1', '', '    return 2']
  expectGolden(AREA, 'todo', {
    marks: ['a.py', 'a.ts', 'a.go', 'a.rb', 'a.sql', 'a.html', 'a.css', 'Makefile', 'a.yaml', 'a.lua', 'a.unknown', 'README'].map((f) => [f, commentMark(f)]),
    lines: [todoLines(['#', ''], 'short'), todoLines(['//', ''], 'A concern long enough to wrap over more than one line of a comment in the code, with words that go on and on past the limit.', 60), todoLines(['<!--', '-->'], 'In html.')],
    places: [0, 1, 2, 3, 4, 9].map((at) => [at, todoPlace(code, at)]),
  })
})

test('golden: the Check view\'s names, the messages its page sends, text at code links', () => {
  const links = [{ phrase: 'the lock' }, { phrase: 'unique key' }, { phrase: 'missing phrase' }, { phrase: 'the' }]
  expectGolden(AREA, 'view-names', {
    actions: ACTIONS, kinds: KIND_LABEL, states: STATE_WORD, requests: CHECK_VIEW_REQUESTS, reports: CHECK_VIEW_REPORTS,
    constants: C, sayItBack: SAY_IT_BACK,
    retry: [undefined, '', 'Not quite: look again.', 'Look at the lock.'].map((f) => retryText(f)),
    busy: [0, 999, 1000, 61_000, 3_600_000].map((ms) => busyLabel('Writing questions', 0, ms)),
    defined: definedOnly({ a: 1, b: undefined, c: null, d: '', e: false }),
    parts: ['Why is the lock taken before the unique key is checked?', 'No links here.', '', 'the the the'].map((t) => [t, linkParts(t, links)]),
    missing: [
      missingMessages([{ role: 'agent' }, { role: 'human' }], [{ role: 'agent', n: 1 }, { role: 'human', n: 2 }, { role: 'agent', n: 3 }]),
      missingMessages([], [{ n: 1 }, { role: 'human', n: 2 }]),
      missingMessages([{ role: 'agent' }, { role: 'agent' }, { role: 'agent' }], [{ role: 'agent', n: 1 }]),
    ],
  })
})
