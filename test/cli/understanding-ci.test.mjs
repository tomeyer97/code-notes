// `understanding ci` without a forge's API: pass and fail, drift after merges and rebases, stacked and renamed branches,
// a settings-only change, advisory mode, unknown settings.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { ciMode, localStatus, readCheck, SKILL_URL, stateWords, unknownSettings } from '../../cli/understanding.mjs'
import { checkedRepo, codeLines, commitAll, configOnMain, divergedRepo, editCheck, gitIn, grow, repo, sha, verdicts } from './helpers/repos.mjs'
import { add, afterMarker, answerAll, ci, ciAt, EXIT, FAKE, githubEnv, gitlabEnv, graderLog, run, script, writeQuestions } from './helpers/cli.mjs'

const log = (r) => r.lines.join('\n')

test('ci: no code lines changed (the diff base is the head): passes', async () => {
  const d = repo()
  const r = await ci(d, gitlabEnv(d, undefined, { CI_MERGE_REQUEST_DIFF_BASE_SHA: sha(d) }))
  assert.equal(r.code, EXIT.pass)
  assert.equal(r.lines[0], '✓ No check needed: no code lines changed (only comments or blank lines).')
})

test('ci: no check file: fails, with what to do in VS Code, without it, and to skip', async () => {
  const d = repo()
  const r = await ci(d, gitlabEnv(d))
  assert.equal(r.code, EXIT.fail)
  assert.match(r.lines[0], /^✗ No understanding check yet: a few questions about your change \(3 questions, about 2 min\)\. Run "Code Notes: Check my understanding"/)
  assert.equal(r.lines[1], `  Without VS Code: add the understanding-check skill to .claude/skills (${SKILL_URL}), then type /understanding-check in Claude Code.`)
  assert.match(r.lines[2], /skip-understanding.*then re-run this job/)
})

test('ci never runs a grader, with or without a check', async () => {
  const d = repo()
  const env = () => ({ ...gitlabEnv(d), UNDERSTANDING_CLAUDE: FAKE, FAKE_GRADER_LOG: graderLog(d) })
  assert.equal((await ci(d, env())).code, EXIT.fail)
  const f = writeQuestions(d)
  answerAll(f, verdicts('pass', 'pass', 'pass'))
  commitAll(d)
  const r = await ci(d, env())
  assert.equal(r.code, EXIT.pass, log(r))
  assert.ok(!fs.existsSync(graderLog(d)), 'no grader ran')
})

test('ci: unanswered questions: fails with how many are done', async () => {
  const { d } = checkedRepo(verdicts('pass'))
  const r = await ci(d, gitlabEnv(d))
  assert.equal(r.code, EXIT.fail)
  assert.match(r.lines[0], /^✗ Understanding check: 1 of 3 done \(Answer all 3 · 2 must pass\)/)
})

test('ci: all answered, below the threshold: fails, and says how to restate', async () => {
  const { d } = checkedRepo(verdicts('pass', 'explained', 'explained'))
  const r = await ci(d, gitlabEnv(d))
  assert.equal(r.code, EXIT.fail)
  assert.match(r.lines[0], /1 passed, 2 must pass\. In VS Code, say an explained answer back in your own words/)
})

test('ci: a verdict or an answer changed after grading (a merge that kept another side): fails, names the attempts', async () => {
  const { d, f } = checkedRepo(verdicts('pass', 'explained', 'explained'))
  editCheck(d, f, (c) => {
    c.questions[1].attempts[0].verdict = 'pass'
    c.questions[2].attempts[0].answer = 'changed later'
  })
  const r = await ci(d, gitlabEnv(d))
  assert.equal(r.code, EXIT.fail)
  assert.match(r.lines[0], /q2 attempt 1, q3 attempt 1 changed after grading/)
})

test('ci: enough passed: passes with the count and the rule', async () => {
  const { d } = checkedRepo(verdicts('pass', 'pass', 'explained'))
  const r = await ci(d, gitlabEnv(d))
  assert.equal(r.code, EXIT.pass, log(r))
  assert.match(r.lines[0], /done: 2 of 3 passed \(Answer all 3 · 2 must pass\)/)
})

test('ci: comments, blank lines and exempt files added after the check are not drift', async () => {
  const { d } = checkedRepo()
  fs.appendFileSync(path.join(d, 'src/app.js'), codeLines(50, (i) => `// note ${i}: audited monthly`) + '/*\n block\n*/\n\n')
  fs.writeFileSync(path.join(d, 'NOTES.md'), Array.from({ length: 80 }, () => 'x').join('\n'))
  commitAll(d)
  configOnMain(d, '{ "exempt": ["*.md"] }\n')
  const r = await ci(d, gitlabEnv(d))
  assert.equal(r.code, EXIT.pass, log(r))
  assert.doesNotMatch(r.lines[0], /since the check/)
})

test('ci: code added after the check past the limit (40 lines): fails, says by how much', async () => {
  const { d } = checkedRepo()
  grow(d, 45)
  const r = await ci(d, gitlabEnv(d))
  assert.equal(r.code, EXIT.fail)
  assert.match(r.lines[0], /grew by 45 code lines since the check/)
})

test('ci: a check file that is not JSON: fails, says so', async () => {
  const { d, f } = checkedRepo()
  fs.writeFileSync(f, '{ "version": 1, ')
  commitAll(d)
  const r = await ci(d, gitlabEnv(d))
  assert.equal(r.code, EXIT.fail)
  assert.match(r.lines[0], /not valid JSON/)
})

test('ci: the questions\' commit is gone (rebased): compared by size', async () => {
  const { d, f } = checkedRepo(verdicts('pass', 'pass', 'explained'), { commit: false })
  editCheck(d, f, (c) => { c.head = 'deadbeef00' })
  const r = await ci(d, gitlabEnv(d))
  assert.equal(r.code, EXIT.pass, log(r))
})

test('drift is the branch\'s own change: merging main counts nothing', async () => {
  const { d } = divergedRepo()
  gitIn(d, 'merge', '-q', '--no-edit', 'main')
  const r = await ciAt(d)
  assert.equal(r.code, EXIT.pass, log(r))
  assert.doesNotMatch(r.lines[0], /since the check/)
  assert.equal(localStatus(d).drift.lines, 0)
  assert.match(script(d, 'start', '--top-up').out, /^NOTHING: no code lines changed since the questions were written/)
})

test('drift: a conflict resolved with new code counts; a top-up never asks about main\'s code', async () => {
  const { d } = divergedRepo()
  // Main changes a line the branch changed too; the conflict is resolved with new code: those lines count.
  gitIn(d, 'checkout', '-q', 'main')
  fs.writeFileSync(path.join(d, 'src/app.js'), 'export function main() {\n  return 1\n}\n')
  commitAll(d, 'main returns 1')
  gitIn(d, 'checkout', '-q', 'feat/x')
  try { gitIn(d, 'merge', '-q', '--no-edit', 'main') } catch { /* the conflict */ }
  const body = codeLines(70, (i) => `  const v${i} = load(${i}) // step ${i}`)
  const resolved = codeLines(45, (i) => `  const w${i} = merge(${i})`)
  fs.writeFileSync(path.join(d, 'src/app.js'), `export function main() {\n${body}${resolved}  return 1\n}\n`)
  commitAll(d, 'merge main, resolved')
  const r = await ciAt(d)
  assert.equal(r.code, EXIT.fail)
  assert.match(r.lines[0], /grew by 45 code lines/, 'the 45 resolution lines, not main\'s 260')
  const out = script(d, 'start', '--top-up').out
  assert.match(out, /NEW LINES \(ask only about these\): src\/app\.js:72-116/)
  assert.doesNotMatch(out, /refunds\.js/)
  assert.match(add(d, { kind: 'why', file: 'src/refunds.js', lines: '1-3', text: 'Why are the refunds exported one constant at a time here?' }).out, /not part of this new change/)
  assert.equal(add(d, { kind: 'why', file: 'src/app.js', lines: '80-82', text: 'Why does the merge step run after every load instead of once?' }).code, 0)
  assert.match(script(d, 'finish').out, /4 questions \(1 new\)/)
  const c = readCheck(path.join(d, 'understanding/feat-x.json'))
  assert.equal(c.base, gitIn(d, 'merge-base', 'main', 'HEAD').trim(), 'the top-up records today\'s merge base')
})

test('drift after a rebase onto main: none locally (old commits known), none in CI by size (old commits gone)', async () => {
  const { d, f } = divergedRepo()
  gitIn(d, 'rebase', '-q', 'main')
  let r = await ciAt(d)
  assert.equal(r.code, EXIT.pass, log(r))
  assert.doesNotMatch(r.lines[0], /since the check/)
  // A fresh clone in CI doesn't have the questions' commits: compared by size, still nothing.
  editCheck(d, f, (c) => {
    c.head = 'deadbeef00'
    c.base = 'deadbeef01'
  }, 'as if rewritten')
  r = await ciAt(d)
  assert.equal(r.code, EXIT.pass, log(r))
  grow(d, 45)
  r = await ciAt(d)
  assert.equal(r.code, EXIT.fail)
  assert.match(r.lines[0], /grew by 45 code lines since the check \(compared by size/)
})

test('advisory mode: the config\'s mode, and UNDERSTANDING_MODE over it', () => {
  assert.equal(ciMode({}, {}), 'required')
  assert.equal(ciMode({ mode: 'advisory' }, {}), 'advisory')
  assert.equal(ciMode({ mode: 'advisory' }, { UNDERSTANDING_MODE: 'required' }), 'required')
  assert.equal(ciMode({}, { UNDERSTANDING_MODE: 'advisory' }), 'advisory')
})

test('required mode (the default): no file fails', async () => {
  const d = repo()
  const r = await ci(d, gitlabEnv(d))
  assert.deepEqual([r.code, r.mode], [EXIT.fail, 'required'])
  assert.match(r.lines[0], /^✗ No understanding check yet/)
})

test('a merge request that switches its own check to advisory is judged by the target\'s settings: the change is the headline', async () => {
  const d = repo()
  fs.mkdirSync(path.join(d, 'understanding'))
  fs.writeFileSync(path.join(d, 'understanding/config.json'), '{ "mode": "advisory" }\n')
  commitAll(d, 'advisory')
  const r = await ci(d, gitlabEnv(d))
  assert.deepEqual([r.code, r.mode], [EXIT.fail, 'required'])
  assert.match(afterMarker(r.comment), /^\*\*⚠ This merge request changes the understanding check's settings: mode required → advisory\*\* \(from the merge on; this merge request follows the current settings\)\n\n\*\*Understanding check: not done yet\.\*\*/)
  assert.doesNotMatch(r.comment, /Advisory: this check/)
})

/** repo() with advisory mode on main (the target): its settings are the ones that apply. */
function advisoryRepo() {
  const d = repo()
  configOnMain(d, '{ "mode": "advisory" }\n')
  return d
}

test('advisory on the target branch: a failure exits 3 with the same message; the comment has one muted line, no skip instructions', async () => {
  const d = advisoryRepo()
  const r = await ci(d, gitlabEnv(d))
  assert.deepEqual([r.code, r.mode], [EXIT.advisory, 'advisory'])
  assert.match(r.lines[0], /^⚠ Advisory: No understanding check yet: a few questions/)
  assert.match(afterMarker(r.comment), /^Advisory: this check doesn't block merging\.\n\n\*\*Understanding check: not done yet\.\*\* A few questions about your change \(3 questions, about 2 min\)/)
  assert.doesNotMatch(r.comment + log(r), /skip-understanding/)
})

test('advisory: UNDERSTANDING_MODE=required wins over the file', async () => {
  const d = advisoryRepo()
  const r = await ci(d, { ...gitlabEnv(d), UNDERSTANDING_MODE: 'required' })
  assert.equal(r.code, EXIT.fail)
  assert.doesNotMatch(r.comment, /Advisory/)
})

test('advisory: "can\'t check" stays 2', async () => {
  const d = advisoryRepo()
  const r = await ci(d, gitlabEnv(d, undefined, { CI_MERGE_REQUEST_DIFF_BASE_SHA: 'deadbeef00' }))
  assert.equal(r.code, EXIT.cannotCheck)
})

test('advisory: a pass stays 0, with the muted line', async () => {
  const d = advisoryRepo()
  const f = writeQuestions(d)
  answerAll(f, verdicts('pass', 'pass', 'pass'))
  commitAll(d)
  const r = await ci(d, gitlabEnv(d))
  assert.equal(r.code, EXIT.pass)
  assert.match(r.lines[0], /^✓ Understanding check done/)
  assert.match(r.comment, /doesn't block merging/)
})

test('advisory on GitHub Actions: a failure exits 0 with a warning annotation (GitHub can\'t allow one exit code)', async () => {
  const d = advisoryRepo()
  const f = writeQuestions(d)
  answerAll(f, verdicts('pass', 'pass'))
  commitAll(d, 'one open')
  const r = await ci(d, githubEnv(d))
  assert.equal(r.code, EXIT.pass)
  assert.match(r.lines[0], /^⚠ Advisory: Understanding check: 2 of 3 done/)
  assert.match(r.lines.at(-1), /^::warning title=Understanding check::⚠ Advisory: Understanding check: 2 of 3 done/)
})

test('advisory through the command line: the exit code is what the job sees', async () => {
  const d = advisoryRepo()
  assert.equal((await run(d, ['ci', '--no-comment'], { ...gitlabEnv(d), PATH: process.env.PATH })).code, EXIT.advisory)
})

test('stacked branches: the change starts after the parent\'s committed check', async () => {
  const { d } = checkedRepo()
  gitIn(d, 'checkout', '-qb', 'fix/y')
  fs.writeFileSync(path.join(d, 'src/app.js'), fs.readFileSync(path.join(d, 'src/app.js'), 'utf8').replace('return 0', 'return 1'))
  commitAll(d, 'one line')
  const st = localStatus(d, { base: 'main' })
  assert.deepEqual([st.changed, st.stackedOn, st.state.phase], [2, 'feat/x', 'none'])
  assert.equal(stateWords(st.state, st).line, "2 code lines changed since feat/x's check · 1 question, ~1 min.")
  const out = script(d, 'start', '--base', 'main').out
  assert.match(out, /^STACKED: on feat\/x/m)
  assert.match(out, /CHANGE: branch fix\/y · 1 files · 2 code lines/)
  assert.match(out, /WRITE: 1 question/)
  // CI agrees: no check yet, about 2 lines (not the parent's 70).
  const r = await ci(d, { CI_MERGE_REQUEST_DIFF_BASE_SHA: gitIn(d, 'merge-base', 'main', 'HEAD').trim() })
  assert.equal(r.code, EXIT.fail)
  assert.match(r.lines[0], /No understanding check yet/)
  // The parent is merged into main: the merge base is past its check; the change is the child's own, still 2 lines.
  gitIn(d, 'checkout', '-q', 'main')
  gitIn(d, 'merge', '-q', '--no-ff', '-m', 'merge feat/x', 'feat/x')
  gitIn(d, 'checkout', '-q', 'fix/y')
  const merged = localStatus(d, { base: 'main' })
  assert.deepEqual([merged.changed, merged.stackedOn], [2, undefined])
})

test('a renamed branch (or the same work pushed under a new name) keeps its check: covered, nothing to redo; CI agrees', async () => {
  const { d } = checkedRepo()
  gitIn(d, 'branch', '-m', 'feat/x', 'feat/better-name')
  const st = localStatus(d, { base: 'main' })
  assert.deepEqual([st.state.phase, st.stackedOn], ['nothing', 'feat/x'])
  assert.equal(stateWords(st.state, st).line, "Covered by feat/x's check.")
  const r = await ci(d, {})
  assert.equal(r.code, EXIT.pass)
  assert.equal(r.lines[0], "✓ No check needed: covered by feat/x's check (no code changed since).")
})

test('an MR that only changes the check\'s settings: no check needed, and the comment says what changed', async () => {
  const { d } = checkedRepo()
  gitIn(d, 'checkout', '-q', 'main')
  gitIn(d, 'merge', '-q', '--no-ff', '-m', 'm', 'feat/x')
  gitIn(d, 'checkout', '-qb', 'chore/advisory')
  fs.writeFileSync(path.join(d, 'understanding/config.json'), '{ "mode": "advisory", "maxDrift": 60 }\n')
  commitAll(d, 'advisory')
  const r = await ci(d, { CI_MERGE_REQUEST_DIFF_BASE_SHA: sha(d, 'main') })
  assert.equal(r.code, EXIT.pass)
  // Never "only comments or blank lines": the settings are what changed. Judged by main's settings (required).
  assert.equal(r.lines[0], "✓ No check needed: only the check's settings changed.")
  assert.match(r.lines[1], /This merge request changes the understanding check's settings: (mode required → advisory, maxDrift 40 → 60|maxDrift 40 → 60, mode required → advisory)\./)
  assert.equal(r.mode, 'required')
  assert.match(afterMarker(r.comment), /^\*\*⚠ This merge request changes the understanding check's settings: /)
  assert.doesNotMatch(r.comment, /Advisory/)
})

test('a key of the settings that is not a setting is said in the log (ignored), never silently believed', async () => {
  const d = repo()
  configOnMain(d, '{ "minChangedLines": 20, "passRatio": 0.6 }\n')
  assert.deepEqual(unknownSettings(d), ['minChangedLines'])
  const r = await ci(d, gitlabEnv(d))
  assert.equal(r.code, EXIT.fail)
  assert.equal(r.lines.at(-1), '  understanding/config.json: "minChangedLines" is not a setting (ignored).')
  const st = await run(d, ['status'])
  assert.match(st.out, /understanding\/config\.json: "minChangedLines" is not a setting \(ignored\)\./)
})
