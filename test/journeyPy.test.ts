// journey.py's own tests (test/journey-py/test_*.py, Python's unittest): its command line, context, text, ranges and
// commands. The extension's rules it shares with journey-check.mjs are compared in test/cli/journeyRules.test.mjs.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'child_process'
import * as path from 'path'

const DIR = path.join(__dirname, '../../test/journey-py')

test('journey.py: its unit tests pass', () => {
  const r = spawnSync('python3', ['-W', 'ignore::ResourceWarning', '-m', 'unittest', 'discover', '-s', DIR, '-p', 'test_*.py'], {
    cwd: DIR, encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  })
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`)
  assert.match(r.stderr, /^OK$/m)
})
