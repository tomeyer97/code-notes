// Golden tests (test/README.md): the check's pure pieces that are not driven by a check file (the CLI flow is
// test/cli/golden-understanding.test.mjs): TODO comments placed in code, and the grader's replies in a thread as the
// person reads them. The prompts and failures are in golden-check-agent.test.ts, the Check view's names in
// golden-check-view.test.ts.
import { test } from 'node:test'
import { expectGolden } from './golden'
import { commentMark, todoLines, todoPlace } from '../src/check/todoComment'
import { gradeBody } from '../src/check/threadText'
import type { Attempt } from '../src/check/types'

const AREA = 'check-model'

test('golden: TODO comments placed in code', () => {
  const code = ['def f(x):', '    if x:', '        return 1', '', '    return 2']
  expectGolden(AREA, 'todo', {
    marks: ['a.py', 'a.ts', 'a.go', 'a.rb', 'a.sql', 'a.html', 'a.css', 'Makefile', 'a.yaml', 'a.lua', 'a.unknown', 'README'].map((f) => [f, commentMark(f)]),
    lines: [todoLines(['#', ''], 'short'), todoLines(['//', ''], 'A concern long enough to wrap over more than one line of a comment in the code, with words that go on and on past the limit.', 60), todoLines(['<!--', '-->'], 'In html.')],
    places: [0, 1, 2, 3, 4, 9].map((at) => [at, todoPlace(code, at)]),
  })
})

test('golden: the grader\'s replies in a thread', () => {
  const cases: [string, Attempt, { restatement?: boolean }][] = [
    ['pass', { answer: 'a', verdict: 'pass', feedback: 'Right. The key makes it safe.' }, {}],
    ['pass, no feedback', { answer: 'a', verdict: 'pass' }, {}],
    ['restated', { answer: 'a', verdict: 'restated', feedback: 'Right.' }, {}],
    ['retry', { answer: 'a', verdict: 'retry', feedback: 'Close.', hint: 'Look at report().' }, {}],
    ['retry, the grader says not quite', { answer: 'a', verdict: 'retry', feedback: 'Not quite: what then?', hint: '' }, {}],
    ['retry, no feedback', { answer: 'a', verdict: 'retry' }, {}],
    ['explained', { answer: 'a', verdict: 'explained', feedback: 'It keeps it in a file.' }, {}],
    ['a restatement that missed', { answer: 'a', verdict: 'explained', feedback: 'The lock, not the lookup.' }, { restatement: true }],
  ]
  expectGolden(AREA, 'thread-text', Object.fromEntries(cases.map(([name, a, o]) => [name, gradeBody(a, o)])))
})
