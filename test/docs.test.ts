// The CI recipes in docs/understanding-check.md, which people copy into their repositories: they must download the
// CLI of this version and pin the actions to the same commits as this repository's own CI.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'fs'
import * as path from 'path'

const ROOT = path.join(__dirname, '../..')
const read = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf8')
const doc = read('docs/understanding-check.md')

test('the recipes download cli/understanding.mjs of this version', () => {
  const version = JSON.parse(read('package.json')).version
  const tags = [...doc.matchAll(/raw\.githubusercontent\.com\/tomeyer97\/code-notes\/([^/]+)\/cli\/understanding\.mjs/g)].map((m) => m[1])
  assert.ok(tags.length >= 2, 'a GitLab and a GitHub recipe')
  assert.deepEqual([...new Set(tags)], [`v${version}`])
  assert.ok(doc.includes(`(\`v${version}\`, this version)`), 'the line above the recipes names the version too')
})

test('the recipes pin each action to the commit this repository\'s CI uses', () => {
  const ours = new Map<string, string>()
  for (const f of ['.github/workflows/ci.yml', '.github/workflows/release.yml', '.github/actions/setup/action.yml']) {
    for (const m of read(f).matchAll(/uses: ([\w-]+\/[\w-]+)@(\S+)/g)) ours.set(m[1], m[2])
  }
  const used = [...doc.matchAll(/uses: ([\w-]+\/[\w-]+)@(\S+)/g)]
  assert.ok(used.length, 'the GitHub recipe uses actions')
  for (const [, action, ref] of used) {
    assert.match(ref, /^[0-9a-f]{40}$/, `${action}: pinned to a commit`)
    assert.equal(ref, ours.get(action), `${action}: the commit this repository's CI uses`)
  }
})
