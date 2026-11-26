// `understanding init` and the setup it writes: .gitattributes and .ignore lines, the skill (with the CLI beside it)
// in .claude/skills, also from a copied CLI; what is missing, said by ci as a tip; the setup never counts as the change.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { CI_URL, initRepo, installSkill, localStatus, main, own, setupMissing, stateWords } from '../../cli/understanding.mjs'
import { checkedRepo, commitAll, gitIn, grow, ID, repo, root, sh, verdicts } from './helpers/repos.mjs'
import { answerAll, ci, EXIT, run, writeQuestions } from './helpers/cli.mjs'

const ATTRIBUTES = ['.gitattributes: understanding/*.json gitlab-generated linguist-generated', '.gitattributes: understanding/config.json -gitlab-generated -linguist-generated']
const read = (d, f) => fs.readFileSync(path.join(d, f), 'utf8')

test('init: .gitattributes and .ignore, the skill; what to commit and the CI recipe', async () => {
  const d = repo()
  fs.writeFileSync(path.join(d, '.gitattributes'), '*.png binary')
  const r = await run(d, ['init'])
  assert.equal(r.out.split('\n')[0], 'Added: .gitattributes: understanding/*.json gitlab-generated linguist-generated; .gitattributes: understanding/config.json -gitlab-generated -linguist-generated; .ignore: understanding/; the skill (.claude/skills/understanding-check: SKILL.md, questions.mjs, understanding.mjs).')
  assert.equal(r.out.split('\n')[1], 'Commit them: git add .gitattributes .ignore .claude/skills/understanding-check && git commit -m "Add understanding check setup"')
  // The docs' section: the README has no "In CI".
  assert.match(r.out, /^CI recipe: https:\/\/github\.com\/[^ ]*\/docs\/understanding-check\.md#in-ci$/m)
  // The settings file is not collapsed: a change to them stays in sight.
  assert.equal(read(d, '.gitattributes'), '*.png binary\nunderstanding/*.json gitlab-generated linguist-generated\nunderstanding/config.json -gitlab-generated -linguist-generated\n')
  assert.equal(read(d, '.ignore'), 'understanding/\n')
  assert.equal((await run(d, ['init'])).out.split('\n')[0], 'Already set up.')
})

test('init: existing lines kept, never duplicated; an earlier version\'s line replaced in place', () => {
  const d = repo()
  initRepo(d)
  fs.writeFileSync(path.join(d, '.ignore'), 'dist/\n  understanding/  \n')
  assert.deepEqual(initRepo(d), [])
  assert.equal(read(d, '.ignore'), 'dist/\n  understanding/  \n')
  // The line an earlier version wrote (GitLab ignores linguist-generated): replaced in place.
  fs.writeFileSync(path.join(d, '.gitattributes'), '*.png binary\nunderstanding/*.json linguist-generated=true\n*.pdf binary\n')
  assert.deepEqual(initRepo(d), ATTRIBUTES)
  assert.equal(read(d, '.gitattributes'), '*.png binary\nunderstanding/*.json gitlab-generated linguist-generated\n*.pdf binary\nunderstanding/config.json -gitlab-generated -linguist-generated\n')
})

test('init from a subfolder: the repository\'s root', async () => {
  const d = repo()
  assert.equal(await main(['init'], { cwd: path.join(d, 'src'), print: () => {} }), 0)
  assert.ok(fs.existsSync(path.join(d, '.ignore')))
})

test('setup: never written by itself; setupMissing names what is missing; ci gives a one-line tip in the log only', async () => {
  const d = repo()
  const f = writeQuestions(d)
  assert.ok(!fs.existsSync(path.join(d, '.gitattributes')) && !fs.existsSync(path.join(d, '.ignore')), 'the skill writes no setup files')
  assert.deepEqual(setupMissing(d), [...ATTRIBUTES, '.ignore: understanding/'])
  answerAll(f, verdicts('pass', 'pass', 'pass'))
  commitAll(d)
  let r = await ci(d, {})
  assert.equal(r.code, EXIT.pass, r.lines.join('\n'))
  assert.match(r.lines.at(-1), /^ {2}tip: run "node .*understanding\.mjs init" once and commit \.gitattributes and \.ignore/)
  assert.doesNotMatch(r.comment ?? '', /tip/)
  initRepo(d)
  commitAll(d, 'setup')
  assert.deepEqual(setupMissing(d), [])
  r = await ci(d, {})
  assert.ok(!r.lines.some((l) => /tip:/.test(l)))
})

/** The installed skill's script, run in `d` without UNDERSTANDING_CLI (it must find the CLI itself). */
const installedScript = (d, ...args) => sh(d, 'node', [path.join(d, '.claude/skills/understanding-check/scripts/questions.mjs'), ...args], { ...ID, UNDERSTANDING_CLI: '' })

test('installSkill: the skill in the repository for /understanding-check, the CLI beside it; idempotent; an older copy updated', () => {
  const d = repo()
  const skill = path.join(d, '.claude/skills/understanding-check')
  assert.deepEqual(installSkill(d), ['.claude/skills/understanding-check/SKILL.md', '.claude/skills/understanding-check/scripts/questions.mjs', '.claude/skills/understanding-check/scripts/understanding.mjs'])
  assert.equal(read(skill, 'SKILL.md'), read(root, 'skills/understanding-check/SKILL.md'))
  assert.match(read(skill, 'SKILL.md'), /^name: understanding-check$/m)
  assert.deepEqual(installSkill(d), [], 'idempotent')
  fs.writeFileSync(path.join(skill, 'SKILL.md'), 'old')
  assert.deepEqual(installSkill(d), ['.claude/skills/understanding-check/SKILL.md'], 'an older copy is updated')
})

test('installSkill: the skill and its CLI never count as part of the change; the installed script finds the CLI beside it', () => {
  const d = repo()
  installSkill(d)
  const before = localStatus(d, { base: 'main' }).changed
  commitAll(d, 'skill')
  assert.equal(localStatus(d, { base: 'main' }).changed, before)
  assert.equal(own('.claude/skills/understanding-check/scripts/understanding.mjs'), true)
  const out = installedScript(d, 'cli', 'status')
  assert.match(out, /^No check yet for feat\/x/)
  assert.match(out, /^ {2}Without VS Code: type \/understanding-check in Claude Code\.$/m)
})

test('init in a repository that commits its own copy of the CLI (tools/understanding.mjs): no second copy', async () => {
  const e = repo()
  fs.mkdirSync(path.join(e, 'tools'))
  fs.copyFileSync(path.join(root, 'cli/understanding.mjs'), path.join(e, 'tools/understanding.mjs'))
  gitIn(e, 'add', 'tools')
  gitIn(e, 'commit', '-qm', 'cli')
  const r = await run(e, ['init'])
  assert.match(r.out, /the skill \(\.claude\/skills\/understanding-check: SKILL\.md, questions\.mjs\)/)
  assert.ok(!fs.existsSync(path.join(e, '.claude/skills/understanding-check/scripts/understanding.mjs')))
  assert.match(installedScript(e, 'start', '--base', 'main'), /^CHANGE: branch feat\/x/m)
  assert.match((await run(e, ['init'])).out, /^Already set up\./)
})

test('the CI link goes to a section that exists: docs/understanding-check.md "## In CI"', () => {
  const [, file, anchor] = CI_URL.match(/\/blob\/main\/(.+)#(.+)$/)
  const headings = read(root, file).split('\n').filter((l) => /^#+ /.test(l)).map((l) => l.replace(/^#+ /, '').toLowerCase().replace(/[^a-z0-9 -]/g, '').replace(/ /g, '-'))
  assert.ok(headings.includes(anchor), `${file} has no heading for #${anchor}`)
})

/** `d` with the CLI copied into tools/, as the docs suggest (the extension's bundle, nothing beside it). */
const copyCli = (d) => {
  fs.mkdirSync(path.join(d, 'tools'))
  fs.copyFileSync(path.join(root, 'cli/understanding.mjs'), path.join(d, 'tools/understanding.mjs'))
  return path.join(d, 'tools/understanding.mjs')
}

test('init from a copied CLI (tools/understanding.mjs, not committed yet): installs the skill it carries, no second CLI copy', () => {
  const d = repo()
  const cli = copyCli(d)
  const out = sh(d, 'node', [cli, 'init'])
  const skill = path.join(d, '.claude/skills/understanding-check')
  assert.equal(read(skill, 'SKILL.md'), read(root, 'skills/understanding-check/SKILL.md'))
  assert.equal(read(skill, 'scripts/questions.mjs'), read(root, 'skills/understanding-check/scripts/questions.mjs'))
  assert.ok(!fs.existsSync(path.join(skill, 'scripts/understanding.mjs')), 'the repository has its own copy')
  assert.match(out, /^Added: .*; the skill \(\.claude\/skills\/understanding-check: SKILL\.md, questions\.mjs\)\.$/m)
  assert.match(out, /^Without VS Code: type \/understanding-check in Claude Code\.$/m)
  assert.doesNotMatch(out, /add the understanding-check skill/)
  assert.match(out, /#in-ci$/m)
})

test('a committed CLI copy and the setup never count as the change: status and next agree the check is done', async () => {
  const { d } = checkedRepo()
  const cli = copyCli(d)
  sh(d, 'node', [cli, 'init'])
  commitAll(d, 'understanding check setup')
  const st = localStatus(d)
  assert.equal(own('tools/understanding.mjs'), true)
  assert.equal(st.state.phase, 'done')
  assert.equal(st.drift.lines, 0)
  assert.match((await run(d, ['status'])).out, /· 0 lines since the check$/m)
  assert.match((await run(d, ['next'])).out, /^✓ Done: 3 of 3 passed/)
})

test('next says a grown check like status does, not Done', async () => {
  const { d } = checkedRepo()
  grow(d, 45)
  const words = stateWords(localStatus(d).state)
  assert.equal((await run(d, ['next'])).out, `${words.title} · ${words.line}`)
  assert.match((await run(d, ['status'])).out, /^Your change grew by 45 code lines · Add 1 question about the new lines\./)
})
