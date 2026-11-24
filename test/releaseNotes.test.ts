// scripts/release-notes.mjs: the release workflow's notes, one version's section of CHANGELOG.md.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'fs'
import * as path from 'path'
import { pathToFileURL } from 'url'

const ROOT = path.join(__dirname, '../..')
type Script = { releaseNotes(changelog: string, version: string): string | undefined }
// The real import(): module commonjs would compile a written-out import() into require().
const dynamicImport = new Function('u', 'return import(u)') as (u: string) => Promise<Script>
const script = () => dynamicImport(pathToFileURL(path.join(ROOT, 'scripts/release-notes.mjs')).href)

const LOG = '# Changelog\n\n## 1.10.0 (2026-11-02)\n\n- New: b.\n\n### Fixed\n\n- c.\n\n## 1.1.0\n\n- a.\n\n## 1.0.0\n- first.\n'

test('a version\'s section, up to the next version', async () => {
  const { releaseNotes } = await script()
  assert.equal(releaseNotes(LOG, '1.10.0'), '- New: b.\n\n### Fixed\n\n- c.\n')
  assert.equal(releaseNotes(LOG, '1.1.0'), '- a.\n')
  assert.equal(releaseNotes(LOG, '1.0.0'), '- first.\n')
})

test('no section: undefined; a version is not a prefix of another', async () => {
  const { releaseNotes } = await script()
  assert.equal(releaseNotes(LOG, '2.0.0'), undefined)
  assert.equal(releaseNotes(LOG, '1.1'), undefined)
  assert.equal(releaseNotes(LOG, '1.10'), undefined)
})

test('the current version has a section in CHANGELOG.md', async () => {
  const { releaseNotes } = await script()
  const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version
  assert.ok(releaseNotes(fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8'), version)?.trim(), version)
})
