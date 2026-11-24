// Reading diffs (cli/understanding/diff.ts): hunks, changed ranges, old and new line numbers, code lines.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { cliModule } from './helpers/source.mjs'
import { commitAll, gitIn, smallRepo } from './helpers/repos.mjs'
import { dedent } from './helpers/text.mjs'

const { changedRanges, codeLines, hunksOf, nearestChanged, numberDiff, oldLineOf, removalPoints } = await cliModule('diff')

test('hunksOf: each hunk\'s new-side lines (a deletion: the line it happened at); the extension asks it about a concern\'s lines', () => {
  const diff = dedent`
    diff
    @@ -1,2 +3,4 @@ x
    +a
    @@ -9 +12 @@
    @@ -20,3 +19,0 @@
  `
  assert.deepEqual(hunksOf(diff.trimEnd()), [{ start: 3, end: 6 }, { start: 12, end: 12 }, { start: 19, end: 19 }])
})

test('diff walkers: a removed "-- x" or an added "++ x" inside a hunk is a line, not a file header', () => {
  // A SQL comment removed ("--- note") and a Haskell line added ("+++ rest") in q.sql / m.hs.
  const diff = dedent`
    diff --git a/q.sql b/q.sql
    --- a/q.sql
    +++ b/q.sql
    @@ -1,2 +1,2 @@
    --- note
    +select 2;
     select 3;
    diff --git a/m.hs b/m.hs
    --- a/m.hs
    +++ b/m.hs
    @@ -4,0 +5,2 @@
    +++ rest
    +main = go
  `
  const ranges = changedRanges(diff)
  assert.deepEqual([...ranges.keys()], ['q.sql', 'm.hs'])
  assert.deepEqual(ranges.get('m.hs'), [[5, 6]])
  assert.deepEqual(oldLineOf(diff, 'q.sql', 2), 2)
  assert.equal(nearestChanged(diff, 'm.hs', 6), 6)
  assert.match(numberDiff(diff), /^ {4}1 \+select 2;$/m)
  assert.match(numberDiff(diff), /^ {4}5 \+\+\+ rest$/m)
})

test('a removed "-- x" (code in a language where -- is not a comment) is a removal point in that file', () => {
  const diff = dedent`
    diff --git a/a.js b/a.js
    --- a/a.js
    +++ b/a.js
    @@ -3,1 +2,0 @@
    --- i
  `
  assert.deepEqual(Object.fromEntries(removalPoints(diff)), { 'a.js': [[2, 2]] })
})

test('codeLines: a removed SQL comment line does not move the lines after it to another file', () => {
  const d = smallRepo(['-- old note', 'select 1;'], 'q.sql')
  gitIn(d, 'checkout', '-q', '-b', 'later')
  fs.writeFileSync(path.join(d, 'q.sql'), fs.readFileSync(path.join(d, 'q.sql'), 'utf8').replace('-- old note\nselect 1;', 'select 2;'))
  commitAll(d)
  assert.deepEqual(codeLines(d, 'HEAD~1', 'HEAD').map((x) => `${x.file} ${x.sign}${x.text}`), ['q.sql -select 1;', 'q.sql +select 2;'])
})
