// Golden tests (test/README.md): the check's pure pieces that are not driven by a check file (the CLI flow is
// test/cli/golden-understanding.test.mjs): TODO comments placed in code. The prompts and failures are in
// golden-check-agent.test.ts, the Check view's names in golden-check-view.test.ts.
import { test } from 'node:test'
import { expectGolden } from './golden'
import { commentMark, todoLines, todoPlace } from '../src/check/todoComment'

const AREA = 'check-model'

test('golden: TODO comments placed in code', () => {
  const code = ['def f(x):', '    if x:', '        return 1', '', '    return 2']
  expectGolden(AREA, 'todo', {
    marks: ['a.py', 'a.ts', 'a.go', 'a.rb', 'a.sql', 'a.html', 'a.css', 'Makefile', 'a.yaml', 'a.lua', 'a.unknown', 'README'].map((f) => [f, commentMark(f)]),
    lines: [todoLines(['#', ''], 'short'), todoLines(['//', ''], 'A concern long enough to wrap over more than one line of a comment in the code, with words that go on and on past the limit.', 60), todoLines(['<!--', '-->'], 'In html.')],
    places: [0, 1, 2, 3, 4, 9].map((at) => [at, todoPlace(code, at)]),
  })
})
