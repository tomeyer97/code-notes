// `understanding status` and the check's state as the extension reads it (localStatus, checkState, stateWords): what
// to do next, the default branch, a check file with conflicts or in a stash, help and use without VS Code.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { checkState, conflictOf, hashProblems, isDefaultBranch, localStatus, readCheck, stateWords, validateCheck, writeCheck } from '../../cli/understanding.mjs'
import { bareRemote, commitAll, gitIn, grow, ID, repo, root, sh, smallRepo, stashUntracked, verdicts } from './helpers/repos.mjs'
import { answerAll, ci, EXIT, gitlabEnv, grade, run, SCRIPT, writeQuestions } from './helpers/cli.mjs'

test('status: what to do next, locally', async () => {
  const d = repo()
  assert.equal(localStatus(d).next, '70 code lines changed · 3 questions, ~2 min.')
  const f = writeQuestions(d)
  assert.equal(localStatus(d).next, 'Answer all 3 · 2 must pass · ~2 min left.')
  answerAll(f, verdicts('pass', 'pass', 'explained'))
  assert.equal(localStatus(d).next, 'A new file: not committed yet.')
  assert.match((await run(d, ['status'])).out, /^✓ Done · A new file: not committed yet\./)
  const r = await run(d, ['status', '--json'])
  assert.equal(JSON.parse(r.out).summary.passed, 2)
  assert.equal((await run(d, ['validate', f])).code, 0)
})

test('checkState: one word for where the check stands', () => {
  const d = repo()
  assert.equal(checkState(localStatus(d)).phase, 'none')
  const f = writeQuestions(d)
  commitAll(d)
  assert.deepEqual(checkState(localStatus(d)), { phase: 'answering', passed: 0, done: 0, total: 3, needed: 2, maxDrift: 40, grew: 0 })
  // A "try again" is not done: the rule waits for it, even with enough passes.
  answerAll(f, verdicts('pass', 'pass', 'retry'))
  assert.equal(localStatus(d).state.phase, 'answering')
  assert.equal(stateWords(localStatus(d).state).bar, 'Understanding 2/3')
  writeCheck(f, { ...readCheck(f), questions: readCheck(f).questions.map((q) => ({ ...q, attempts: [] })) })
  answerAll(f, verdicts('pass', 'explained', 'explained'))
  assert.equal(checkState(localStatus(d)).phase, 'short')
  answerAll(f, [undefined, undefined, { text: 'd', verdict: 'pass' }])
  assert.equal(checkState(localStatus(d)).phase, 'done')
  commitAll(d)
  // Uncommitted lines past the limit: a top-up is due once they are committed.
  grow(d, 45, { commit: false, name: 'w' })
  assert.deepEqual(checkState(localStatus(d)), { phase: 'drift', commitFirst: true, passed: 2, done: 3, total: 3, needed: 2, maxDrift: 40, grew: 45 })
  // New work, not a fault: neutral, counted in questions; the lines are in the title (the status bar's tooltip).
  assert.deepEqual(stateWords(localStatus(d).state), { tone: 'todo', bar: 'Understanding: +1 question', title: 'Your change grew by 45 code lines', line: 'Commit, then add 1 question about the new lines.', rule: 'Answer all 3 · 2 must pass' })
  commitAll(d, 'more')
  assert.equal(checkState(localStatus(d)).commitFirst, false)
})

test('the default branch: one line, no check here', () => {
  const d = repo()
  gitIn(d, 'checkout', '-q', 'main')
  const st = localStatus(d)
  assert.deepEqual(stateWords(st.state, st), { tone: 'ok', bar: '', title: 'main: no check here', line: '', rule: '' })
})

test('the default branch with a scratch edit or a staged rename: no check here, no nudge to commit or start', async () => {
  const d = repo()
  gitIn(d, 'checkout', '-q', 'main')
  // Cloned: main is compared with origin/main, so an edit on main is a change of its own.
  gitIn(d, 'remote', 'add', 'origin', bareRemote())
  gitIn(d, 'push', '-q', 'origin', 'main')
  gitIn(d, 'remote', 'set-head', 'origin', 'main')
  const quiet = async () => {
    const st = localStatus(d)
    assert.equal(st.state.phase, 'nothing')
    assert.deepEqual(stateWords(st.state, st), { tone: 'ok', bar: '', title: 'main: no check here', line: '', rule: '' })
    const r = await run(d, ['status'])
    assert.equal(r.out.split('\n')[0], 'main: no check here')
    assert.doesNotMatch(r.out, /Check my understanding|Without VS Code|Commit/)
  }
  // Five lines deleted while walking a journey, not committed.
  fs.writeFileSync(path.join(d, 'src/app.js'), 'export function main() {\n')
  assert.ok(localStatus(d).changed > 0)
  await quiet()
  gitIn(d, 'checkout', '-q', '--', 'src/app.js')
  gitIn(d, 'mv', 'src/app.js', 'src/main.js')
  await quiet()
  // Committed on main too: still no check there.
  commitAll(d, 'rename')
  await quiet()
})

test('the default branch is one rule: origin/HEAD when known, else main/master, plus the branch compared with', () => {
  const d = repo()
  const onBase = (branch, base) => {
    gitIn(d, 'checkout', '-q', branch)
    return !!localStatus(d, base ? { base } : {}).onBase
  }
  // No origin/HEAD: main or master.
  assert.ok(onBase('main') && !onBase('feat/x'))
  // origin/HEAD is develop: develop is the default branch, main is not (unless it is the branch compared with).
  gitIn(d, 'branch', 'develop', 'main')
  gitIn(d, 'update-ref', 'refs/remotes/origin/develop', 'main')
  gitIn(d, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/develop')
  assert.ok(onBase('develop') && !onBase('main') && !onBase('feat/x'))
  assert.ok(onBase('main', 'main') && onBase('main', 'origin/main'))
  assert.equal(isDefaultBranch(d, 'trunk', 'origin/trunk'), true)
  assert.equal(isDefaultBranch(d, 'master'), false)
})

test('a check file with merge-conflict markers: said so, where, and both answers kept when both sides read', async () => {
  const d = repo()
  const f = writeQuestions(d)
  const c = readCheck(f)
  const mine = structuredClone(c), theirs = structuredClone(c)
  const pass = (check, i, text) => grade(check, check.questions[i], text, 'pass', { feedback: 'Right.', gradedAt: '2026-11-16T10:00:00Z' })
  pass(mine, 0, 'mine on q1')
  pass(theirs, 1, 'theirs on q2')
  // A line-wise conflict, as git leaves it: the whole file differs between the sides here.
  const text = ['<<<<<<< HEAD', JSON.stringify(mine, null, 2), '=======', JSON.stringify(theirs, null, 2), '>>>>>>> main', ''].join('\n')
  fs.writeFileSync(f, text)
  const st = localStatus(d, { base: 'main' })
  assert.deepEqual([st.state.phase, st.conflict], ['invalid', { line: 1, mergeable: true }])
  assert.deepEqual(stateWords(st.state, st), { tone: 'warn', bar: 'Understanding: merge conflict', title: 'The check file has a merge conflict', line: 'Both sides of the conflict can be kept.', rule: '' })
  const r = await run(d, ['status'])
  // `status` exits 1 for scripts and hooks (the same "fail" as ci's).
  assert.equal(r.code, EXIT.fail)
  assert.match(r.out, /First conflict at understanding\/feat-x\.json:1\./)
  const m = conflictOf(text).merged
  assert.deepEqual(m.questions.map((q) => q.attempts?.at(-1)?.answer), ['mine on q1', 'theirs on q2', undefined])
  assert.deepEqual([validateCheck(m), hashProblems(m)], [[], []])
  // Not JSON on one side: open it, nothing to merge.
  assert.deepEqual(conflictOf('{\n<<<<<<< HEAD\n  "a": 1\n=======\n  "a": 2,\n>>>>>>> x\n}'), { line: 2 })
})

test('a check in a git stash: said (git stash pop), never Start', () => {
  const d = repo()
  const f = writeQuestions(d)
  const text = stashUntracked(d, 'understanding/feat-x.json')
  let st = localStatus(d, { base: 'main' })
  assert.deepEqual([st.state.phase, st.stashed], ['stashed', 'stash@{0}'])
  assert.deepEqual(stateWords(st.state, st), { tone: 'warn', bar: 'Understanding: in a stash', title: 'Your check is in a git stash', line: 'Run git stash pop (stash@{0}).', rule: '' })
  fs.writeFileSync(f, text)
  st = localStatus(d, { base: 'main' })
  assert.equal(st.state.phase, 'answering')
})

test('help links docs that exist', async () => {
  const help = await run(os.tmpdir(), ['help'])
  assert.match(help.out, /docs: https:\/\/github\.com\/tomeyer97\/code-notes\/blob\/main\/docs\/understanding-check\.md/)
  assert.match(help.out, /grade \[<file>\]/)
})

test('without VS Code: status and CI give the same way; the skill finds the repository\'s copy of the CLI', async () => {
  const d = smallRepo(['export const one = 1'])
  const st = await run(d, ['status'])
  assert.match(st.out, /1 code line changed/)
  assert.doesNotMatch(st.out, /1 code lines/)
  const way = st.out.split('\n').find((l) => /Without VS Code/.test(l)).trim()
  const r = await ci(d, gitlabEnv(d))
  assert.equal(r.lines[1].trim(), way)
  assert.match(way, /^Without VS Code: add the understanding-check skill to \.claude\/skills \(.*\), then type \/understanding-check in Claude Code\.$/)
  // The skill copied into .claude/skills, the CLI committed as tools/understanding.mjs: found.
  const skill = path.join(d, '.claude/skills/understanding-check/scripts')
  fs.mkdirSync(skill, { recursive: true })
  fs.copyFileSync(SCRIPT, path.join(skill, 'questions.mjs'))
  fs.copyFileSync(path.join(root, 'skills/understanding-check/SKILL.md'), path.join(skill, '../SKILL.md'))
  fs.mkdirSync(path.join(d, 'tools'))
  fs.copyFileSync(path.join(root, 'cli/understanding.mjs'), path.join(d, 'tools/understanding.mjs'))
  gitIn(d, 'add', 'tools')
  gitIn(d, 'commit', '-qm', 'cli')
  const out = sh(d, 'node', [path.join(skill, 'questions.mjs'), 'start', '--base', 'main'], { ...ID, UNDERSTANDING_CLI: '' })
  assert.match(out, /^CHANGE: branch feat\/x · /)
  // With the skill in the repository: the short way.
  assert.match((await run(d, ['status'])).out, /^ {2}Without VS Code: type \/understanding-check in Claude Code\.$/m)
})
