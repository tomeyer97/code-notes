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

const readme = read('README.md')
const pkg = JSON.parse(read('package.json'))

test('the README lists every VS Code default the extension changes, with how to undo it', () => {
  for (const key of Object.keys(pkg.contributes.configurationDefaults)) {
    const row = readme.split('\n').find((l) => l.startsWith(`| \`${key}\``))
    assert.ok(row, `${key}: a row in the README's Settings`)
    assert.ok(row.split('|').at(-2)!.includes(`"${key}"`), `${key}: how to undo it`)
  }
})

test('every docs/ file the README links ships in the package', () => {
  const links = [...readme.matchAll(/\]\((docs\/[^)#\s]+)/g)].map((m) => m[1]).filter((l) => !l.startsWith('docs/images/'))
  assert.ok(links.length >= 2, 'the README links docs')
  for (const l of links) assert.ok(pkg.files.includes(l), l)
})

test('the README is for users: no Development section, no gutter +, no status bar bell', () => {
  assert.doesNotMatch(readme, /^## Development/m)
  assert.doesNotMatch(readme, /gutter `?\+/)
  assert.doesNotMatch(readme, /\bbell\b/)
})

test('skipping is one rule: the label and an approval, never an approval alone', () => {
  for (const text of [readme, doc]) {
    assert.doesNotMatch(text, /any approval[^.]*waives/i)
    assert.doesNotMatch(text, /approval waives the check/i)
  }
  const rule = /add the label `skip-understanding` and get an approval from someone other than the author/g
  assert.equal([...doc.matchAll(rule)].length, 2, 'Using it and Skipping say the same')
})

/** The fenced yaml block that follows `heading` (a line starting with it). */
function yamlAfter(heading: string): string {
  const at = doc.split('\n').findIndex((l) => l.startsWith(heading))
  assert.ok(at >= 0, heading)
  const m = /```yaml\n([\s\S]*?)```/.exec(doc.split('\n').slice(at).join('\n'))
  assert.ok(m, `a yaml block after ${heading}`)
  return m[1]
}

test('the GitLab recipe is valid YAML in a regular stage, so it runs as a project\'s only job', () => {
  const yaml = yamlAfter('GitLab (`.gitlab-ci.yml`)')
  // A small structural check (no YAML parser among the dependencies): two-space indents, no tabs, every line a
  // `key:` or a `- item` under a key.
  const lines = yaml.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#'))
  for (const l of lines) {
    assert.doesNotMatch(l, /\t/, l)
    assert.equal((l.length - l.trimStart().length) % 2, 0, l)
    assert.match(l.trim(), /^(- .+|[\w$.-]+:( .*)?)$/, l)
  }
  assert.match(lines[0], /^understanding:$/)
  const stage = /^ {2}stage: (\S+)/m.exec(yaml)?.[1]
  assert.ok(stage, 'the job names its stage')
  // GitLab creates no pipeline whose only jobs are in .pre/.post.
  assert.ok(!['.pre', '.post'].includes(stage), stage)
  assert.match(yaml, /^ {2}needs: \[\]/m)
  assert.match(yaml, /merge_request_event/)
})
