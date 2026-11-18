// The CLI in a repository, as a person (or the extension) runs it: grading with the fake grader, status and the
// check's state, anchors, drift, commit & push, init, conflicts and stashes, use without VS Code.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { execFileSync } from 'node:child_process'
import * as U from '../../cli/understanding.mjs'
import { root, FAKE, SCRIPT, ID, gitIn, repo, run, script, writeQuestions, answerAll, commitAll, gitlabEnv, ci, smallRepo } from './helpers.mjs'

test('grade with the claude backend: pass, retry, then explained; hashes written; a second person is recorded', async () => {
  const d = repo()
  const f = writeQuestions(d)
  const env = { UNDERSTANDING_BACKEND: 'claude', UNDERSTANDING_CLAUDE: FAKE }
  let r = await run(d, ['grade', f, '--question', 'q1', '--answer', 'GOOD: it is kept', '--write'], env)
  assert.equal(r.code, 0, r.out); assert.match(r.out, /✓ q1 pass/)
  r = await run(d, ['grade', f, '--question', 'q2', '--answer', 'no idea', '--write'], env)
  assert.match(r.out, /q2 retry: Not quite[\s\S]*Hint: Look at what the reset function does/)
  r = await run(d, ['grade', f, '--question', 'q2', '--answer', 'still no idea', '--write'], env)
  assert.match(r.out, /q2 explained: It retries/)
  const c = U.readCheck(f)
  assert.deepEqual(c.questions[1].attempts.map((a) => a.verdict), ['retry', 'explained'])
  assert.deepEqual(U.hashProblems(c), [])
  assert.equal(c.result.passed, 1)
  gitIn(d, 'config', 'user.email', 'bo@example.com'); gitIn(d, 'config', 'user.name', 'Bo')
  await run(d, ['grade', f, '--question', 'q3', '--answer', 'GOOD', '--write'], env)
  const c2 = U.readCheck(f)
  assert.deepEqual(c2.questions[2].attempts[0].by, { name: 'Bo', email: 'bo@example.com' })
  assert.equal(c2.questions[0].attempts[0].by, undefined)
  assert.equal(U.validateCheck(c2).length, 0)
  r = await run(d, ['grade', f], env)
  assert.match(r.out, /Nothing to grade/)
})

test('grade with the anthropic backend (Messages API)', async () => {
  const d = repo()
  const f = writeQuestions(d)
  let seen
  const srv = http.createServer((req, res) => { let b = ''; req.on('data', (x) => { b += x }); req.on('end', () => { seen = { headers: req.headers, url: req.url, body: JSON.parse(b) }; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{"verdict":"pass","feedback":"Yes.","hint":""}' }] })) }) })
  await new Promise((r) => srv.listen(0, r))
  try {
    const r = await run(d, ['grade', f, '--question', 'q1', '--answer', 'kept in a file', '--backend', 'anthropic', '--write'], { ANTHROPIC_API_KEY: 'k', ANTHROPIC_BASE_URL: `http://127.0.0.1:${srv.address().port}` })
    assert.equal(r.code, 0, r.out)
    assert.equal(seen.url, '/v1/messages'); assert.equal(seen.headers['x-api-key'], 'k')
    assert.equal(seen.body.model, 'claude-opus-5-5'); assert.match(seen.body.messages[0].content, /kept in a file/)
    assert.equal(U.readCheck(f).questions[0].attempts[0].verdict, 'pass')
  } finally { srv.close() }
})

test('status: what to do next, locally', async () => {
  const d = repo()
  assert.equal(U.localStatus(d).next, '70 code lines changed · 3 questions, ~2 min.')
  const f = writeQuestions(d)
  assert.equal(U.localStatus(d).next, 'Answer all 3 · 2 must pass · ~2 min left.')
  answerAll(f, [{ text: 'a', verdict: 'pass' }, { text: 'b', verdict: 'pass' }, { text: 'c', verdict: 'explained' }])
  assert.equal(U.localStatus(d).next, 'A new file: not committed yet.')
  assert.match((await run(d, ['status'])).out, /^✓ Done · A new file: not committed yet\./)
  const r = await run(d, ['status', '--json'])
  assert.equal(JSON.parse(r.out).summary.passed, 2)
  assert.equal((await run(d, ['validate', f])).code, 0)
})

test('anchors: lines follow the code after edits above them (status, then the file when saved)', () => {
  const d = repo()
  const f = writeQuestions(d)
  commitAll(d)
  const src = path.join(d, 'src/app.js')
  fs.writeFileSync(src, `// a\n// b\n${fs.readFileSync(src, 'utf8')}`)
  commitAll(d, 'two lines on top')
  assert.deepEqual(U.localStatus(d).check.questions.slice(0, 2).map((q) => [q.start, q.end]), [[5, 8], [12, 14]])
  const c = U.readCheck(f)
  assert.equal(U.relocate(d, c), 2)
  assert.equal(U.relocate(d, c), 0, 'nothing moves twice')
  const lines = fs.readFileSync(src, 'utf8').split('\n')
  assert.equal(U.findAnchor(lines, { head: 'nothing like this', tail: 'x', lines: 1 }), undefined)
})

test('checkState: one word for where the check stands', () => {
  const d = repo()
  assert.equal(U.checkState(U.localStatus(d)).phase, 'none')
  const f = writeQuestions(d)
  commitAll(d)
  assert.deepEqual(U.checkState(U.localStatus(d)), { phase: 'answering', passed: 0, done: 0, total: 3, needed: 2, maxDrift: 40, grew: 0 })
  // A "try again" is not done: the rule waits for it, even with enough passes.
  answerAll(f, [{ text: 'a', verdict: 'pass' }, { text: 'b', verdict: 'pass' }, { text: 'c', verdict: 'retry' }])
  assert.equal(U.localStatus(d).state.phase, 'answering')
  assert.equal(U.stateWords(U.localStatus(d).state).bar, 'Understanding 2/3')
  U.writeCheck(f, { ...U.readCheck(f), questions: U.readCheck(f).questions.map((q) => ({ ...q, attempts: [] })) })
  answerAll(f, [{ text: 'a', verdict: 'pass' }, { text: 'b', verdict: 'explained' }, { text: 'c', verdict: 'explained' }])
  assert.equal(U.checkState(U.localStatus(d)).phase, 'short')
  answerAll(f, [undefined, undefined, { text: 'd', verdict: 'pass' }])
  assert.equal(U.checkState(U.localStatus(d)).phase, 'done')
  commitAll(d)
  // Uncommitted lines past the limit: a top-up is due once they are committed.
  fs.appendFileSync(path.join(d, 'src/app.js'), Array.from({ length: 45 }, (_, i) => `export const w${i} = ${i}`).join('\n') + '\n')
  assert.deepEqual(U.checkState(U.localStatus(d)), { phase: 'drift', commitFirst: true, passed: 2, done: 3, total: 3, needed: 2, maxDrift: 40, grew: 45 })
  assert.equal(U.stateWords(U.localStatus(d).state).bar, 'Needs top-up: +45 lines')
  commitAll(d, 'more')
  assert.equal(U.checkState(U.localStatus(d)).commitFirst, false)
})

test('commit & push: only the check file; -u without an upstream; then to it; rejected and sign-in failures in one line', async () => {
  const d = repo()
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'uc-remote-'))
  gitIn(bare, 'init', '-q', '--bare')
  const f = writeQuestions(d)
  fs.writeFileSync(path.join(d, 'other.txt'), 'not mine\n')
  const rel = 'understanding/feat-x.json'
  let r = await U.commitAndPush(d, [rel], 'Understanding check')
  assert.deepEqual([r.ok, r.committed, r.line], [false, true, 'Committed, but not pushed: no git remote.'])
  assert.equal(gitIn(d, 'show', '--name-only', '--format=', 'HEAD').trim(), rel, 'only the check file')
  assert.match(gitIn(d, 'status', '--porcelain'), /\?\? other\.txt/)
  gitIn(d, 'remote', 'add', 'origin', bare)
  r = await U.commitAndPush(d, [rel], 'Understanding check')
  assert.deepEqual([r.ok, r.committed, r.line], [true, false, 'Pushed.'])
  assert.equal(gitIn(d, 'rev-parse', '--abbrev-ref', '@{u}').trim(), 'origin/feat/x')
  answerAll(f, [{ text: 'a', verdict: 'pass' }])
  r = await U.commitAndPush(d, [rel], 'Understanding check: answers')
  assert.deepEqual([r.ok, r.committed, r.line], [true, true, 'Pushed.'])
  assert.equal(gitIn(bare, 'rev-parse', 'feat/x').trim(), gitIn(d, 'rev-parse', 'HEAD').trim())
  // Someone else pushed in between.
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'uc-other-'))
  gitIn(other, 'clone', '-q', '-b', 'feat/x', bare, '.'); gitIn(other, 'config', 'user.name', 'Bo'); gitIn(other, 'config', 'user.email', 'bo@example.com')
  fs.writeFileSync(path.join(other, 'x.txt'), 'x\n'); gitIn(other, 'add', '-A'); gitIn(other, 'commit', '-qm', 'x'); gitIn(other, 'push', '-q')
  answerAll(f, [undefined, { text: 'b', verdict: 'pass' }])
  r = await U.commitAndPush(d, [rel], 'Understanding check: answers')
  assert.equal(r.ok, false); assert.equal(r.line, 'Committed, but the push was rejected: origin has newer commits. Pull, then push again.')
  // A remote that wants a password: no prompt, one line.
  const srv = http.createServer((req, res) => { res.statusCode = 401; res.setHeader('WWW-Authenticate', 'Basic realm="git"'); res.end() })
  await new Promise((ok) => srv.listen(0, ok))
  try {
    gitIn(d, 'remote', 'set-url', 'origin', `http://127.0.0.1:${srv.address().port}/shop.git`)
    r = await U.commitAndPush(d, [rel], 'Understanding check: answers', { env: { ...process.env, GIT_ASKPASS: '', SSH_ASKPASS: '' } })
    assert.equal(r.line, "The push failed: git couldn't sign in to origin.")
  } finally { srv.close() }
})

test('size: question count scales with code lines; config bounds it', () => {
  assert.deepEqual([1, 10, 19, 20, 59, 60, 149, 150, 299, 300, 2000].map((n) => U.questionsFor(n)), [1, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5])
  assert.equal(U.questionsFor(5, { questions: { min: 3, max: 5 } }), 3)
  assert.equal(U.questionsFor(500, { questions: { min: 1, max: 3 } }), 3)
  const d = repo()
  fs.mkdirSync(path.join(d, 'understanding'), { recursive: true })
  fs.writeFileSync(path.join(d, 'understanding/config.json'), '{ "questions": 2, "exempt": ["docs/**"] }')
  const cfg = U.loadConfig(d)
  assert.deepEqual([cfg.questions, cfg.exempt, cfg.minChangedLines], [{ min: 2, max: 2 }, ['docs/**'], undefined])
  assert.equal(U.questionsFor(1000, cfg), 2)
})

test('only the final answer stays: earlier attempts lose their text and hash; CI verifies the last one; older files still validate', async () => {
  const q = { id: 'q1', kind: 'why', text: 'Why is this so here?', file: 'a.js', start: 1, end: 2 }
  const check = { version: 1, branch: 'b', head: 'abcdef1', answeredBy: { name: 'Ada' }, questions: [q] }
  const a1 = U.addAttempt(check, q, 'a wrong guess', { name: 'Ada' })
  Object.assign(a1, { verdict: 'retry', feedback: 'Re-check the loop.', hint: 'Look at a.js:2', gradedAt: 't1' }); a1.hash = U.attemptHash(q, a1)
  const a2 = U.addAttempt(check, q, 'still wrong', { name: 'Ada' })
  Object.assign(a2, { verdict: 'explained', feedback: 'It retries.', topic: 'retries', note: 'It retries.' }); a2.hash = U.attemptHash(q, a2)
  U.addAttempt(check, q, 'It retries until it works.', { name: 'Bo' })
  assert.deepEqual(q.attempts.map((a) => [a.answer, a.hash, a.verdict]), [[undefined, undefined, 'retry'], [undefined, undefined, 'explained'], ['It retries until it works.', undefined, undefined]])
  assert.deepEqual([q.attempts[0].feedback, q.attempts[0].hint, q.attempts[0].at !== undefined, q.attempts[1].topic, q.attempts[2].by], ['Re-check the loop.', 'Look at a.js:2', true, 'retries', { name: 'Bo' }])
  assert.ok(!JSON.stringify(check).includes('wrong'), 'no wrong guess in the file')
  const last = q.attempts[2]; last.verdict = 'restated'; last.hash = U.attemptHash(q, last)
  assert.deepEqual(U.validateCheck(check), [])
  assert.deepEqual(U.hashProblems(check), [])
  assert.equal(U.stateOf(q), 'restated')
  last.answer = 'edited by hand'
  assert.deepEqual(U.hashProblems(check), ['q1 attempt 3'])
  // The last attempt must keep its answer.
  delete last.answer
  assert.match(U.validateCheck(check).join(), /attempt 3: "answer" must be a string/)
  // The older format (every attempt with its answer and hash) still validates; a bad old hash is not checked.
  const old = { ...check, questions: [{ ...q, attempts: [{ answer: 'x', verdict: 'retry', hash: 'nothash' }, { answer: 'y', verdict: 'pass' }] }] }
  old.questions[0].attempts[1].hash = U.attemptHash(old.questions[0], old.questions[0].attempts[1])
  assert.deepEqual([U.validateCheck(old), U.hashProblems(old)], [[], []])
  assert.equal(U.pruneAttempts(old.questions[0]).attempts[0].answer, undefined)
  // `grade --answer` prunes too.
  const d = repo()
  const f = writeQuestions(d)
  const env = { UNDERSTANDING_BACKEND: 'claude', UNDERSTANDING_CLAUDE: FAKE }
  await run(d, ['grade', f, '--question', 'q2', '--answer', 'no idea', '--write'], env)
  await run(d, ['grade', f, '--question', 'q2', '--answer', 'GOOD: now I see', '--write'], env)
  const c = U.readCheck(f)
  assert.deepEqual(c.questions[1].attempts.map((a) => a.answer), [undefined, 'GOOD: now I see'])
  assert.deepEqual([U.validateCheck(c), U.hashProblems(c)], [[], []])
})

test('init: .gitattributes and .ignore, idempotent, never duplicated, existing lines kept', async () => {
  const d = repo()
  fs.writeFileSync(path.join(d, '.gitattributes'), '*.png binary')
  let r = await run(d, ['init'])
  assert.equal(r.out.split('\n')[0], 'Added: .gitattributes: understanding/*.json gitlab-generated linguist-generated; .gitattributes: understanding/config.json -gitlab-generated -linguist-generated; .ignore: understanding/; the skill (.claude/skills/understanding-check: SKILL.md, questions.mjs, understanding.mjs).')
  assert.equal(r.out.split('\n')[1], 'Commit them: git add .gitattributes .ignore .claude/skills/understanding-check && git commit -m "Add understanding check setup"')
  assert.match(r.out, /CI recipe: https:\/\/github\.com\/.*#in-ci/)
  // The settings file is not collapsed: a change to them stays in sight.
  assert.equal(fs.readFileSync(path.join(d, '.gitattributes'), 'utf8'), '*.png binary\nunderstanding/*.json gitlab-generated linguist-generated\nunderstanding/config.json -gitlab-generated -linguist-generated\n')
  assert.equal(fs.readFileSync(path.join(d, '.ignore'), 'utf8'), 'understanding/\n')
  r = await run(d, ['init'])
  assert.equal(r.out.split('\n')[0], 'Already set up.')
  fs.writeFileSync(path.join(d, '.ignore'), 'dist/\n  understanding/  \n')
  assert.deepEqual(U.initRepo(d), [])
  assert.equal(fs.readFileSync(path.join(d, '.ignore'), 'utf8'), 'dist/\n  understanding/  \n')
  // The line an earlier version wrote (GitLab ignores linguist-generated): replaced in place.
  fs.writeFileSync(path.join(d, '.gitattributes'), '*.png binary\nunderstanding/*.json linguist-generated=true\n*.pdf binary\n')
  assert.deepEqual(U.initRepo(d), ['.gitattributes: understanding/*.json gitlab-generated linguist-generated', '.gitattributes: understanding/config.json -gitlab-generated -linguist-generated'])
  assert.equal(fs.readFileSync(path.join(d, '.gitattributes'), 'utf8'), '*.png binary\nunderstanding/*.json gitlab-generated linguist-generated\n*.pdf binary\nunderstanding/config.json -gitlab-generated -linguist-generated\n')
  // From a subfolder: the repository's root.
  fs.rmSync(path.join(d, '.ignore'))
  assert.equal((await U.main(['init'], { cwd: path.join(d, 'src'), print: () => {} })), 0)
  assert.ok(fs.existsSync(path.join(d, '.ignore')))
})

test('setup: never written by itself; setupMissing names what is missing; ci gives a one-line tip in the log only', async () => {
  const d = repo()
  const f = writeQuestions(d)
  assert.ok(!fs.existsSync(path.join(d, '.gitattributes')) && !fs.existsSync(path.join(d, '.ignore')), 'the skill writes no setup files')
  assert.deepEqual(U.setupMissing(d), ['.gitattributes: understanding/*.json gitlab-generated linguist-generated', '.gitattributes: understanding/config.json -gitlab-generated -linguist-generated', '.ignore: understanding/'])
  answerAll(f, [{ text: 'a', verdict: 'pass' }, { text: 'b', verdict: 'pass' }, { text: 'c', verdict: 'pass' }])
  commitAll(d)
  let r = await ci(d, {})
  assert.equal(r.code, 0, r.lines.join('\n'))
  assert.match(r.lines.at(-1), /^ {2}tip: run "node .*understanding\.mjs init" once and commit \.gitattributes and \.ignore/)
  assert.doesNotMatch(r.comment ?? '', /tip/)
  U.initRepo(d); commitAll(d, 'setup')
  assert.deepEqual(U.setupMissing(d), [])
  r = await ci(d, {})
  assert.ok(!r.lines.some((l) => /tip:/.test(l)))
})

test('the default branch: one line, no check here', () => {
  const d = repo()
  gitIn(d, 'checkout', '-q', 'main')
  const st = U.localStatus(d)
  assert.deepEqual(U.stateWords(st.state, st), { tone: 'ok', bar: '', title: 'main: no check here', line: '', rule: '' })
})

test('the default branch is one rule: origin/HEAD when known, else main/master, plus the branch compared with', () => {
  const d = repo()
  const onBase = (branch, base) => { gitIn(d, 'checkout', '-q', branch); return !!U.localStatus(d, base ? { base } : {}).onBase }
  // No origin/HEAD: main or master.
  assert.ok(onBase('main') && !onBase('feat/x'))
  // origin/HEAD is develop: develop is the default branch, main is not (unless it is the branch compared with).
  gitIn(d, 'branch', 'develop', 'main')
  gitIn(d, 'update-ref', 'refs/remotes/origin/develop', 'main')
  gitIn(d, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/develop')
  assert.ok(onBase('develop') && !onBase('main') && !onBase('feat/x'))
  assert.ok(onBase('main', 'main') && onBase('main', 'origin/main'))
  assert.equal(U.isDefaultBranch(d, 'trunk', 'origin/trunk'), true)
  assert.equal(U.isDefaultBranch(d, 'master'), false)
})

test('a check file with merge-conflict markers: said so, where, and both answers kept when both sides read', async () => {
  const d = repo()
  const f = writeQuestions(d)
  const c = U.readCheck(f)
  const mine = structuredClone(c), theirs = structuredClone(c)
  const pass = (check, i, text) => { const q = check.questions[i]; const a = U.addAttempt(check, q, text); Object.assign(a, { verdict: 'pass', feedback: 'Right.', gradedAt: '2026-11-16T10:00:00Z' }); a.hash = U.attemptHash(q, a) }
  pass(mine, 0, 'mine on q1'); pass(theirs, 1, 'theirs on q2')
  // A line-wise conflict, as git leaves it: the whole file differs between the sides here.
  const text = ['<<<<<<< HEAD', JSON.stringify(mine, null, 2), '=======', JSON.stringify(theirs, null, 2), '>>>>>>> main', ''].join('\n')
  fs.writeFileSync(f, text)
  const st = U.localStatus(d, { base: 'main' })
  assert.deepEqual([st.state.phase, st.conflict], ['invalid', { line: 1, mergeable: true }])
  assert.deepEqual(U.stateWords(st.state, st), { tone: 'warn', bar: 'Understanding: merge conflict', title: 'The check file has a merge conflict', line: 'Both sides of the conflict can be kept.', rule: '' })
  const r = await run(d, ['status'])
  assert.equal(r.code, 1, 'status fails for scripts and hooks'); assert.match(r.out, /First conflict at understanding\/feat-x\.json:1\./)
  const m = U.conflictOf(text).merged
  assert.deepEqual(m.questions.map((q) => q.attempts?.at(-1)?.answer), ['mine on q1', 'theirs on q2', undefined])
  assert.deepEqual([U.validateCheck(m), U.hashProblems(m)], [[], []])
  // Not JSON on one side: open it, nothing to merge.
  assert.deepEqual(U.conflictOf('{\n<<<<<<< HEAD\n  "a": 1\n=======\n  "a": 2,\n>>>>>>> x\n}'), { line: 2 })
})

test('a check in a git stash: said (git stash pop), never Start', () => {
  const d = repo()
  const f = writeQuestions(d)
  // As `git stash -u` leaves it (built with plumbing): a stash commit whose third parent holds the untracked check file.
  const head = gitIn(d, 'rev-parse', 'HEAD').trim(), tree = gitIn(d, 'rev-parse', 'HEAD^{tree}').trim()
  const blob = execFileSync('git', ['hash-object', '-w', f], { cwd: d, encoding: 'utf8' }).trim()
  const sub = execFileSync('git', ['mktree'], { cwd: d, encoding: 'utf8', input: `100644 blob ${blob}\tfeat-x.json\n` }).trim()
  const utree = execFileSync('git', ['mktree'], { cwd: d, encoding: 'utf8', input: `040000 tree ${sub}\tunderstanding\n` }).trim()
  const ct = (t, msg, ...parents) => execFileSync('git', ['commit-tree', t, ...parents.flatMap((x) => ['-p', x]), '-m', msg], { cwd: d, encoding: 'utf8' }).trim()
  const ucommit = ct(utree, 'untracked'), icommit = ct(tree, 'index', head)
  gitIn(d, 'update-ref', '--create-reflog', '-m', 'WIP on feat/x', 'refs/stash', ct(tree, 'WIP', head, icommit, ucommit))
  fs.rmSync(path.join(d, 'understanding'), { recursive: true })
  let st = U.localStatus(d, { base: 'main' })
  assert.deepEqual([st.state.phase, st.stashed], ['stashed', 'stash@{0}'])
  assert.deepEqual(U.stateWords(st.state, st), { tone: 'warn', bar: 'Understanding: in a stash', title: 'Your check is in a git stash', line: 'Run git stash pop (stash@{0}).', rule: '' })
  fs.mkdirSync(path.join(d, 'understanding')); fs.writeFileSync(f, execFileSync('git', ['cat-file', 'blob', blob], { cwd: d, encoding: 'utf8' }))
  st = U.localStatus(d, { base: 'main' })
  assert.equal(st.state.phase, 'answering')
})

test('without VS Code: help links docs that exist, status and CI give the same way, the skill finds the repository\'s copy of the CLI', async () => {
  const help = await run(os.tmpdir(), ['help'])
  assert.match(help.out, /docs: https:\/\/github\.com\/tomeyer97\/code-notes\/blob\/main\/docs\/understanding-check\.md/)
  assert.match(help.out, /grade \[<file>\]/)
  const d = smallRepo(['export const one = 1'])
  const st = await run(d, ['status'])
  assert.match(st.out, /1 code line changed/); assert.doesNotMatch(st.out, /1 code lines/)
  const way = st.out.split('\n').find((l) => /Without VS Code/.test(l)).trim()
  const r = await ci(d, gitlabEnv(d))
  assert.equal(r.lines[1].trim(), way)
  assert.match(way, /^Without VS Code: add the understanding-check skill to \.claude\/skills \(.*\), then type \/understanding-check in Claude Code\.$/)
  // The skill copied into .claude/skills, the CLI committed as tools/understanding.mjs: found.
  const skill = path.join(d, '.claude/skills/understanding-check/scripts')
  fs.mkdirSync(skill, { recursive: true }); fs.copyFileSync(SCRIPT, path.join(skill, 'questions.mjs'))
  fs.copyFileSync(path.join(root, 'skills/understanding-check/SKILL.md'), path.join(skill, '../SKILL.md'))
  fs.mkdirSync(path.join(d, 'tools')); fs.copyFileSync(path.join(root, 'cli/understanding.mjs'), path.join(d, 'tools/understanding.mjs'))
  gitIn(d, 'add', 'tools'); gitIn(d, 'commit', '-qm', 'cli')
  const out = execFileSync('node', [path.join(skill, 'questions.mjs'), 'start', '--base', 'main'], { cwd: d, encoding: 'utf8', env: { ...process.env, ...ID, UNDERSTANDING_CLI: '' } })
  assert.match(out, /^CHANGE: branch feat\/x · /)
  // With the skill in the repository: the short way.
  assert.match((await run(d, ['status'])).out, /^ {2}Without VS Code: type \/understanding-check in Claude Code\.$/m)
})

test('without VS Code: the next question, the grader\'s rules, a grade recorded as the extension records it, a flag; no model call', async () => {
  const d = repo()
  const f = writeQuestions(d)
  const log = path.join(d, '..', `grader-${path.basename(d)}.log`)
  // A bad grader path and no API key: any model call would fail loudly (and the fake would log it).
  const env = { UNDERSTANDING_CLAUDE: FAKE, FAKE_GRADER_LOG: log, ANTHROPIC_API_KEY: '' }
  let r = await run(d, ['next'], env)
  assert.equal(r.out, 'q1 (1 of 3) · failure · src/app.js:3-6\nWhat happens when load() throws for one of the steps here?')
  r = await run(d, ['grade', '--question', 'q1', '--answer', 'It stops main.', '--prompt'], env)
  assert.equal(r.code, 0)
  assert.match(r.out, /^You grade one answer in an "understanding check"/)
  assert.match(r.out, /<answer>\nIt stops main\.\n<\/answer>/)
  assert.match(r.out, /"verdict": "pass" \| "retry"/)
  assert.equal(U.readCheck(f).questions[0].attempts, undefined, '--prompt records nothing')
  // A miss: retry with a hint; the next try is "try 2"; a second miss is explained (the attempt fixes the verdict).
  r = await run(d, ['grade', '--question', 'q1', '--answer', 'It stops main.', '--reply', '{"verdict":"retry","feedback":"Re-check what load does.","hint":"What does load() do with errors?"}'], env)
  assert.equal(r.out, '↻ q1 retry: Re-check what load does.\n  Hint: What does load() do with errors?\n0 of 3 done · next: q1')
  assert.match((await run(d, ['next'], env)).out, /^q1 \(1 of 3, try 2\)[\s\S]*\nHint: What does load\(\) do with errors\?$/)
  r = await run(d, ['grade', '--question', 'q1', '--answer', 'No idea.', '--reply', '```json\n{"verdict":"retry","feedback":"load() throws and nothing catches it, so main stops.","hint":"x","topic":"errors in load","concern":"A failing load() stops main: every later step is skipped."}\n```'], env)
  assert.match(r.out, /^· q1 explained: load\(\) throws and nothing catches it, so main stops\.\n {2}Concern: A failing load\(\) stops main/)
  let c = U.readCheck(f)
  const q1 = c.questions[0]
  assert.deepEqual(q1.attempts.map((a) => [a.verdict, a.answer]), [['retry', undefined], ['explained', 'No idea.']], 'only the final answer is kept')
  assert.deepEqual([U.hashProblems(c), U.validateCheck(c)], [[], []])
  assert.deepEqual([q1.concern.text, q1.concern.flagged], ['A failing load() stops main: every later step is skipped.', false])
  // Said back in one sentence: restated (counts as passed).
  r = await run(d, ['grade', '--question', 'q1', '--answer', 'Nothing catches a throw from load, so main ends there.', '--reply', '{"verdict":"pass","feedback":"Right."}'], env)
  assert.match(r.out, /^✓ q1 restated: Right\./)
  // Flag the concern for the reviewer.
  r = await run(d, ['flag', '--question', 'q1'], env)
  assert.equal(r.out, '⚠ Flagged for the reviewer: A failing load() stops main: every later step is skipped.')
  assert.equal(U.readCheck(f).questions[0].concern.flagged, true)
  assert.equal((await run(d, ['flag', '--question', 'q2'], env)).out, 'q2 has no concern to flag.')
  for (const id of ['q2', 'q3']) await run(d, ['grade', '--question', id, '--answer', 'One at a time, in order.', '--reply', '{"verdict":"pass","feedback":"Right."}'], env)
  c = U.readCheck(f)
  assert.deepEqual([c.result.verdict, U.summarize(c).met], ['pass', true])
  assert.match((await run(d, ['next'], env)).out, /^✓ Done: 3 of 3 passed \(2 needed\)\. Commit and push: node \S*understanding\.mjs commit$/)
  // Bad replies are refused, nothing recorded.
  r = await run(d, ['grade', '--question', 'q2', '--answer', 'x', '--reply', 'not json'], env)
  assert.equal(r.code, 2); assert.match(r.out, /didn't reply with a verdict/)
  assert.ok(!fs.existsSync(log), 'no grader was ever run')
})

test('commit: the check file, and the first check in a repository also folds check files in diffs (.gitattributes), once', async () => {
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'uc-remote-'))
  gitIn(bare, 'init', '-q', '--bare')
  const d = repo()
  gitIn(d, 'remote', 'add', 'origin', bare)
  fs.writeFileSync(path.join(d, 'notes.txt'), 'mine\n')
  assert.equal(U.foldMissing(d), true)
  const f = writeQuestions(d)
  answerAll(f, [{ text: 'a', verdict: 'pass' }, { text: 'b', verdict: 'pass' }, { text: 'c', verdict: 'pass' }])
  let r = await run(d, ['commit'])
  assert.equal(r.code, 0, r.out)
  assert.equal(r.out, 'Committed feat-x.json, .gitattributes (also folds check files in diffs). Pushed.')
  assert.deepEqual(gitIn(d, 'show', '--name-only', '--format=%s', 'HEAD').trim().split('\n').filter(Boolean), ['Understanding check: feat/x', '.gitattributes', 'understanding/feat-x.json'])
  assert.equal(fs.readFileSync(path.join(d, '.gitattributes'), 'utf8'), 'understanding/*.json gitlab-generated linguist-generated\nunderstanding/config.json -gitlab-generated -linguist-generated\n')
  assert.ok(!fs.existsSync(path.join(d, '.ignore')), '.ignore stays init\'s')
  assert.equal(gitIn(d, 'status', '--porcelain', '--', 'notes.txt').trim(), '?? notes.txt', 'nothing else is committed')
  assert.equal(gitIn(bare, 'rev-parse', 'feat/x').trim(), gitIn(d, 'rev-parse', 'HEAD').trim())
  // The next commit of a check: the line is there, so only the check file.
  assert.equal(U.foldMissing(d), false)
  const c = U.readCheck(f); c.questions[0].text += ' '; U.writeCheck(f, c)
  answerAll(f, [])
  r = await run(d, ['commit', '--no-push'])
  assert.equal(r.out, 'Committed feat-x.json.')
  assert.deepEqual(gitIn(d, 'show', '--name-only', '--format=', 'HEAD').trim().split('\n'), ['understanding/feat-x.json'])
  // Another branch in the same repository: the line came with the first one.
  gitIn(d, 'checkout', '-qb', 'feat/y')
  fs.appendFileSync(path.join(d, 'src/app.js'), 'export const y = 1\n'); commitAll(d, 'y')
  script(d, 'start', '--base', 'feat/x')
  script(d, 'add', '--kind', 'why', '--file', 'src/app.js', '--lines', '74-74', '--text', 'Why is y exported from the app module and not kept inside main?')
  assert.match(script(d, 'finish').out, /WROTE/)
  r = await run(d, ['commit', '--no-push'])
  assert.equal(r.out, 'Committed feat-y.json.')
  assert.equal((await run(d, ['commit', '--no-push'])).out, 'Nothing to commit.')
})

test('init: puts the skill in the repository for /understanding-check, with the CLI beside it unless the repository has one; idempotent; never counted', async () => {
  const d = repo()
  const skill = path.join(d, '.claude/skills/understanding-check')
  assert.deepEqual(U.installSkill(d), ['.claude/skills/understanding-check/SKILL.md', '.claude/skills/understanding-check/scripts/questions.mjs', '.claude/skills/understanding-check/scripts/understanding.mjs'])
  assert.equal(fs.readFileSync(path.join(skill, 'SKILL.md'), 'utf8'), fs.readFileSync(path.join(root, 'skills/understanding-check/SKILL.md'), 'utf8'))
  assert.match(fs.readFileSync(path.join(skill, 'SKILL.md'), 'utf8'), /^name: understanding-check$/m)
  assert.deepEqual(U.installSkill(d), [], 'idempotent')
  fs.writeFileSync(path.join(skill, 'SKILL.md'), 'old')
  assert.deepEqual(U.installSkill(d), ['.claude/skills/understanding-check/SKILL.md'], 'an older copy is updated')
  // Committed: the skill and its CLI never count as part of the change.
  const before = U.localStatus(d, { base: 'main' }).changed
  commitAll(d, 'skill')
  assert.equal(U.localStatus(d, { base: 'main' }).changed, before)
  assert.equal(U.own('.claude/skills/understanding-check/scripts/understanding.mjs'), true)
  // The installed script finds the CLI beside it: the whole flow works from the repository's copy.
  const out = execFileSync('node', [path.join(skill, 'scripts/questions.mjs'), 'cli', 'status'], { cwd: d, encoding: 'utf8', env: { ...process.env, ...ID, UNDERSTANDING_CLI: '' } })
  assert.match(out, /^No check yet for feat\/x/)
  assert.match(out, /^ {2}Without VS Code: type \/understanding-check in Claude Code\.$/m)
  // A repository that commits its own copy of the CLI (tools/understanding.mjs): no second copy.
  const e = repo()
  fs.mkdirSync(path.join(e, 'tools')); fs.copyFileSync(path.join(root, 'cli/understanding.mjs'), path.join(e, 'tools/understanding.mjs'))
  gitIn(e, 'add', 'tools'); gitIn(e, 'commit', '-qm', 'cli')
  const r = await run(e, ['init'])
  assert.match(r.out, /the skill \(\.claude\/skills\/understanding-check: SKILL\.md, questions\.mjs\)/)
  assert.ok(!fs.existsSync(path.join(e, '.claude/skills/understanding-check/scripts/understanding.mjs')))
  assert.match(execFileSync('node', [path.join(e, '.claude/skills/understanding-check/scripts/questions.mjs'), 'start', '--base', 'main'], { cwd: e, encoding: 'utf8', env: { ...process.env, ...ID, UNDERSTANDING_CLI: '' } }), /^CHANGE: branch feat\/x/m)
  assert.match((await run(e, ['init'])).out, /^Already set up\./)
})
