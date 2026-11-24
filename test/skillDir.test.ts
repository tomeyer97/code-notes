// Where a skill is (src/platform/skillDir.ts): the repository's copy, the home folder's, else the extension's.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { findSkill } from '../src/platform/skillDir'

test('findSkill: the first copy that has the marker, in the repository, the home folder, the extension', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skilldir-'))
  const repo = path.join(root, 'repo'), home = path.join(root, 'home'), ext = path.join(root, 'ext', 'skills')
  const put = (dir: string) => {
    fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'scripts', 'run.mjs'), '')
  }
  const find = () => findSkill('s', { repo, bundled: ext, marker: 'scripts/run.mjs', home })
  try {
    assert.equal(find(), undefined, 'none: said, not thrown')
    put(path.join(ext, 's'))
    assert.deepEqual(find(), { dir: path.join(ext, 's'), bundled: true })
    put(path.join(home, '.claude/skills/s'))
    assert.deepEqual(find(), { dir: path.join(home, '.claude/skills/s'), bundled: false })
    // A folder without the marker is not the skill.
    fs.mkdirSync(path.join(repo, '.claude/skills/s'), { recursive: true })
    assert.equal(find()?.dir, path.join(home, '.claude/skills/s'))
    put(path.join(repo, '.claude/skills/s'))
    assert.deepEqual(find(), { dir: path.join(repo, '.claude/skills/s'), bundled: false })
    assert.equal(findSkill('s', { bundled: ext, marker: 'scripts/run.mjs', home })?.dir, path.join(home, '.claude/skills/s'), 'no repository')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
