// The skill's copy inside the CLI (cli/understanding/skillFiles.ts): `init` installs it from a CLI copied away from
// skills/understanding-check (tools/understanding.mjs). Generated from the skill: UPDATE_GOLDENS=1 npm run
// test:goldens writes it, then npm run build bundles it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { root } from './helpers/repos.mjs'

const SKILL = path.join(root, 'skills/understanding-check')
const COPY = path.join(root, 'cli/understanding/skillFiles.ts')
/** The files `init` installs, relative to the skill's folder. */
const FILES = ['SKILL.md', 'scripts/questions.mjs']

/** skillFiles.ts as the skill's files make it. */
function generated() {
  const entries = FILES.map((f) => `  ${JSON.stringify(f)}: ${JSON.stringify(fs.readFileSync(path.join(SKILL, f), 'utf8'))},`)
  return [
    '// Generated from skills/understanding-check by test/cli/golden-skill-copy.test.mjs (UPDATE_GOLDENS=1 npm run',
    '// test:goldens): edit the skill, not this file. What `init` installs when no skill ships beside the CLI.',
    'export const SKILL_FILES: Readonly<Record<string, string>> = {',
    ...entries,
    '}',
    '',
  ].join('\n')
}

test('the CLI carries the skill as it is (cli/understanding/skillFiles.ts)', () => {
  const want = generated()
  if (process.env.UPDATE_GOLDENS) fs.writeFileSync(COPY, want)
  assert.equal(fs.readFileSync(COPY, 'utf8'), want, 'the skill changed: UPDATE_GOLDENS=1 npm run test:goldens, then npm run build')
})
