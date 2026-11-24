// Anchors (cli/understanding/anchors.ts): a question's lines found again after the code moved.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { localStatus, readCheck } from '../../cli/understanding.mjs'
import { cliModule } from './helpers/source.mjs'
import { commitAll, repo, root } from './helpers/repos.mjs'
import { writeQuestions } from './helpers/cli.mjs'

const { findAnchor, relocate } = await cliModule('anchors')

test('anchors: lines follow the code after edits above them (status, then the file when saved)', () => {
  const d = repo()
  const f = writeQuestions(d)
  commitAll(d)
  const src = path.join(d, 'src/app.js')
  fs.writeFileSync(src, `// a\n// b\n${fs.readFileSync(src, 'utf8')}`)
  commitAll(d, 'two lines on top')
  assert.deepEqual(localStatus(d).check.questions.slice(0, 2).map((q) => [q.start, q.end]), [[5, 8], [12, 14]])
  const c = readCheck(f)
  assert.equal(relocate(d, c), 2)
  assert.equal(relocate(d, c), 0, 'nothing moves twice')
  const lines = fs.readFileSync(src, 'utf8').split('\n')
  assert.equal(findAnchor(lines, { head: 'nothing like this', tail: 'x', lines: 1 }), undefined)
})

// The extension's findCompact runs the same cases (test/compact.test.ts); the CLI bundles it.
const { compactCases } = createRequire(import.meta.url)(path.join(root, 'out/test/compactCases.js'))
for (const c of compactCases()) {
  test(`shared relocation case: ${c.name}`, () => {
    const f = findAnchor(c.now, c.anchor, c.hint)
    assert.deepEqual(f ? { state: f.fresh ? 'fresh' : 'changed', start: f.start, end: f.end } : { state: 'gone' }, c.expected)
  })
}
