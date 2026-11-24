// Which changed files count (cli/understanding/changeFiles.ts): the check's own files never; the config's globs.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cliModule } from './helpers/source.mjs'

const { counted, globRe } = await cliModule('changeFiles')

test('counted: everything but the check itself and notes, by default', () => {
  assert.ok(counted('src/a.ts') && counted('README.md') && counted('web/package-lock.json'))
  assert.ok(!counted('understanding/x.json') && !counted('.code-notes/a.json'))
  // The lines `init` writes for the check are not part of the change (nor drift).
  assert.ok(!counted('.gitattributes') && !counted('.ignore') && counted('web/.gitattributes'))
})

test('counted: the config\'s exempt globs', () => {
  const exempt = ['docs/**', '*.md', 'package-lock.json']
  const files = ['README.md', 'docs/a/b.ts', 'web/package-lock.json', 'src/a.ts', 'src/docs/x.ts', 'a.mdx']
  assert.deepEqual(files.map((f) => counted(f, exempt)), [false, false, false, true, true, true])
})

test('globRe: ** any folders (also none), * within a name', () => {
  assert.ok(globRe('src/**/*.test.js').test('src/a/b/c.test.js'))
  assert.ok(globRe('src/**/*.test.js').test('src/c.test.js'))
  assert.ok(!globRe('src/*.js').test('src/a/b.js'))
})
