// `understanding commit` and commitAndPush: only the check file (and, once, the line that folds check files in diffs),
// pushed with -u when there is no upstream; a rejected push and a sign-in failure in one line each.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { commitAndPush, foldMissing, readCheck, writeCheck } from '../../cli/understanding.mjs'
import { bareRemote, commitAll, gitIn, repo, verdicts } from './helpers/repos.mjs'
import { add, answerAll, run, script, writeQuestions } from './helpers/cli.mjs'
import { remoteWantingPassword } from './helpers/servers.mjs'

const CHECK = 'understanding/feat-x.json'

test('commitAndPush without a remote: commits only the check file, says it is not pushed', async () => {
  const d = repo()
  writeQuestions(d)
  fs.writeFileSync(path.join(d, 'other.txt'), 'not mine\n')
  const r = await commitAndPush(d, [CHECK], 'Understanding check')
  assert.deepEqual([r.ok, r.committed, r.line], [false, true, 'Committed, but not pushed: no git remote.'])
  assert.equal(gitIn(d, 'show', '--name-only', '--format=', 'HEAD').trim(), CHECK, 'only the check file')
  assert.match(gitIn(d, 'status', '--porcelain'), /\?\? other\.txt/)
})

test('commitAndPush: -u without an upstream, then to it', async () => {
  const d = repo()
  const bare = bareRemote()
  const f = writeQuestions(d)
  gitIn(d, 'remote', 'add', 'origin', bare)
  let r = await commitAndPush(d, [CHECK], 'Understanding check')
  assert.deepEqual([r.ok, r.committed, r.line], [true, true, 'Pushed.'])
  assert.equal(gitIn(d, 'rev-parse', '--abbrev-ref', '@{u}').trim(), 'origin/feat/x')
  // Nothing new to commit: pushed as it is.
  r = await commitAndPush(d, [CHECK], 'Understanding check')
  assert.deepEqual([r.ok, r.committed, r.line], [true, false, 'Pushed.'])
  answerAll(f, verdicts('pass'))
  r = await commitAndPush(d, [CHECK], 'Understanding check: answers')
  assert.deepEqual([r.ok, r.committed, r.line], [true, true, 'Pushed.'])
  assert.equal(gitIn(bare, 'rev-parse', 'feat/x').trim(), gitIn(d, 'rev-parse', 'HEAD').trim())
})

test('commitAndPush: someone else pushed in between: rejected, in one line', async () => {
  const d = repo()
  const bare = bareRemote()
  const f = writeQuestions(d)
  gitIn(d, 'remote', 'add', 'origin', bare)
  await commitAndPush(d, [CHECK], 'Understanding check')
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'uc-other-'))
  gitIn(other, 'clone', '-q', '-b', 'feat/x', bare, '.')
  fs.writeFileSync(path.join(other, 'x.txt'), 'x\n')
  commitAll(other, 'x')
  gitIn(other, 'push', '-q')
  answerAll(f, verdicts('pass', 'pass'))
  const r = await commitAndPush(d, [CHECK], 'Understanding check: answers')
  assert.equal(r.ok, false)
  assert.equal(r.line, 'Committed, but the push was rejected: origin has newer commits. Pull, then push again.')
})

test('commitAndPush: a remote that wants a password: no prompt, one line', async () => {
  const d = repo()
  writeQuestions(d)
  commitAll(d)
  const srv = await remoteWantingPassword()
  try {
    gitIn(d, 'remote', 'add', 'origin', `${srv.url}/shop.git`)
    const r = await commitAndPush(d, [CHECK], 'Understanding check: answers', { env: { ...process.env, GIT_ASKPASS: '', SSH_ASKPASS: '' } })
    assert.equal(r.line, "The push failed: git couldn't sign in to origin.")
  } finally { srv.close() }
})

test('commit: the first check in a repository also folds check files in diffs (.gitattributes); nothing else', async () => {
  const d = repo()
  const bare = bareRemote()
  gitIn(d, 'remote', 'add', 'origin', bare)
  fs.writeFileSync(path.join(d, 'notes.txt'), 'mine\n')
  assert.equal(foldMissing(d), true)
  const f = writeQuestions(d)
  answerAll(f, verdicts('pass', 'pass', 'pass'))
  const r = await run(d, ['commit'])
  assert.equal(r.code, 0, r.out)
  assert.equal(r.out, 'Committed feat-x.json, .gitattributes (also folds check files in diffs). Pushed.')
  assert.deepEqual(gitIn(d, 'show', '--name-only', '--format=%s', 'HEAD').trim().split('\n').filter(Boolean), ['Understanding check: feat/x', '.gitattributes', CHECK])
  assert.equal(fs.readFileSync(path.join(d, '.gitattributes'), 'utf8'), 'understanding/*.json gitlab-generated linguist-generated\nunderstanding/config.json -gitlab-generated -linguist-generated\n')
  assert.ok(!fs.existsSync(path.join(d, '.ignore')), '.ignore stays init\'s')
  assert.equal(gitIn(d, 'status', '--porcelain', '--', 'notes.txt').trim(), '?? notes.txt', 'nothing else is committed')
  assert.equal(gitIn(bare, 'rev-parse', 'feat/x').trim(), gitIn(d, 'rev-parse', 'HEAD').trim())
})

test('commit: once the fold line is there, only the check file; another branch has it too; nothing to commit is said', async () => {
  const d = repo()
  const f = writeQuestions(d)
  answerAll(f, verdicts('pass', 'pass', 'pass'))
  await run(d, ['commit', '--no-push'])
  assert.equal(foldMissing(d), false)
  const c = readCheck(f)
  c.questions[0].text += ' '
  writeCheck(f, c)
  let r = await run(d, ['commit', '--no-push'])
  assert.equal(r.out, 'Committed feat-x.json.')
  assert.deepEqual(gitIn(d, 'show', '--name-only', '--format=', 'HEAD').trim().split('\n'), [CHECK])
  // Another branch in the same repository: the line came with the first one.
  gitIn(d, 'checkout', '-qb', 'feat/y')
  fs.appendFileSync(path.join(d, 'src/app.js'), 'export const y = 1\n')
  commitAll(d, 'y')
  script(d, 'start', '--base', 'feat/x')
  add(d, { kind: 'why', file: 'src/app.js', lines: '74-74', text: 'Why is y exported from the app module and not kept inside main?' })
  assert.match(script(d, 'finish').out, /WROTE/)
  r = await run(d, ['commit', '--no-push'])
  assert.equal(r.out, 'Committed feat-y.json.')
  assert.equal((await run(d, ['commit', '--no-push'])).out, 'Nothing to commit.')
})
