// The staging folders a journey is written into (src/write/staging.ts): made in the notes folder, removed after,
// and the ones left behind swept once they are a day old.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { STAGING, STAGING_MAX_AGE_MS, stagingFolder, sweepStaging } from '../src/write/staging'

test('a staging folder in the notes folder, gone after cleanup', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'staging-'))
  const s = stagingFolder(repo, '.code-notes')
  assert.equal(s.stage, `.code-notes/${STAGING}/${s.id}`)
  assert.ok(fs.statSync(s.dir).isDirectory())
  s.cleanup()
  assert.ok(!fs.existsSync(s.dir))
  s.cleanup()
  fs.rmSync(repo, { recursive: true })
})

test('the sweep removes only folders older than a day', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'staging-'))
  const root = path.join(repo, '.code-notes', STAGING)
  const old = stagingFolder(repo, '.code-notes')
  const fresh = stagingFolder(repo, '.code-notes')
  const dayAgo = (Date.now() - STAGING_MAX_AGE_MS - 60_000) / 1000
  fs.utimesSync(old.dir, dayAgo, dayAgo)
  assert.deepEqual(await sweepStaging(root), [old.dir])
  assert.deepEqual(fs.readdirSync(root), [fresh.id])
  assert.deepEqual(await sweepStaging(path.join(repo, 'nothing-here')), [], 'no staging folder yet')
  fs.rmSync(repo, { recursive: true })
})
