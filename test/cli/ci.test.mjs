// `understanding ci` without a forge's API: pass and fail, drift after merges and rebases, stacked and renamed branches,
// a settings-only change, advisory mode, unknown settings.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import * as U from '../../cli/understanding.mjs'
import { FAKE, gitIn, repo, run, script, writeQuestions, answerAll, commitAll, configOnMain, gitlabEnv, ci, divergedRepo, ciAt } from './helpers.mjs'

test('ci: nothing changed passes; no file fails with what to do; no model is ever called', async () => {
  const d = repo()
  const res = await ci(d, gitlabEnv(d, undefined, { CI_MERGE_REQUEST_DIFF_BASE_SHA: gitIn(d, 'rev-parse', 'HEAD').trim() }))
  assert.equal(res.code, 0); assert.equal(res.lines[0], '✓ No check needed: no code lines changed (only comments or blank lines).')
  const log = path.join(d, '..', `grader-${path.basename(d)}.log`)
  const r2 = await ci(d, { ...gitlabEnv(d), UNDERSTANDING_CLAUDE: FAKE, FAKE_GRADER_LOG: log })
  assert.equal(r2.code, 1)
  assert.match(r2.lines[0], /^✗ No understanding check yet: a few questions about your change \(3 questions, about 2 min\)\. Run "Code Notes: Check my understanding"/)
  assert.equal(r2.lines[1], `  Without VS Code: add the understanding-check skill to .claude/skills (${U.SKILL_URL}), then type /understanding-check in Claude Code.`)
  assert.match(r2.lines[2], /skip-understanding.*then re-run this job/)
  const f = writeQuestions(d)
  answerAll(f, [{ text: 'a', verdict: 'pass' }, { text: 'b', verdict: 'pass' }, { text: 'c', verdict: 'pass' }])
  commitAll(d)
  const r3 = await ci(d, { ...gitlabEnv(d), UNDERSTANDING_CLAUDE: FAKE, FAKE_GRADER_LOG: log })
  assert.equal(r3.code, 0, r3.lines.join('\n'))
  assert.ok(!fs.existsSync(log), 'ci never runs a grader')
})

test('ci: unanswered, below the threshold, damaged hashes, drift, an invalid file', async () => {
  const d = repo()
  const f = writeQuestions(d)
  answerAll(f, [{ text: 'a', verdict: 'pass' }])
  commitAll(d)
  let r = await ci(d, gitlabEnv(d))
  assert.equal(r.code, 1); assert.match(r.lines[0], /^✗ Understanding check: 1 of 3 done \(Answer all 3 · 2 must pass\)/)
  answerAll(f, [undefined, { text: 'b', verdict: 'explained' }, { text: 'c', verdict: 'explained' }])
  commitAll(d)
  r = await ci(d, gitlabEnv(d))
  assert.equal(r.code, 1); assert.match(r.lines[0], /1 passed, 2 must pass\. In VS Code, say an explained answer back in your own words/)
  // A merge that kept another answer under the same verdict.
  const c = U.readCheck(f)
  c.questions[1].attempts[0].verdict = 'pass'; c.questions[2].attempts[0].answer = 'changed later'
  U.writeCheck(f, c); commitAll(d)
  r = await ci(d, gitlabEnv(d))
  assert.equal(r.code, 1); assert.match(r.lines[0], /q2 attempt 1, q3 attempt 1 changed after grading/)
  c.questions[1].attempts[0].hash = U.attemptHash(c.questions[1], c.questions[1].attempts[0])
  c.questions[2].attempts[0].hash = U.attemptHash(c.questions[2], c.questions[2].attempts[0])
  U.writeCheck(f, c); commitAll(d)
  r = await ci(d, gitlabEnv(d))
  assert.equal(r.code, 0, r.lines.join('\n')); assert.match(r.lines[0], /done: 2 of 3 passed \(Answer all 3 · 2 must pass\)/)
  // Comments and blank lines never count as drift; exempt files neither; code does.
  fs.appendFileSync(path.join(d, 'src/app.js'), Array.from({ length: 50 }, (_, i) => `// note ${i}: audited monthly\n`).join('') + '/*\n block\n*/\n\n')
  fs.writeFileSync(path.join(d, 'NOTES.md'), Array.from({ length: 80 }, () => 'x').join('\n'))
  commitAll(d)
  configOnMain(d, '{ "exempt": ["*.md"] }\n')
  r = await ci(d, gitlabEnv(d))
  assert.equal(r.code, 0, r.lines.join('\n')); assert.doesNotMatch(r.lines[0], /since the check/)
  fs.appendFileSync(path.join(d, 'src/app.js'), Array.from({ length: 45 }, (_, i) => `export const z${i} = ${i}`).join('\n') + '\n')
  commitAll(d)
  r = await ci(d, gitlabEnv(d))
  assert.equal(r.code, 1); assert.match(r.lines[0], /grew by 45 code lines since the check/)
  fs.writeFileSync(f, '{ "version": 1, ')
  commitAll(d)
  r = await ci(d, gitlabEnv(d))
  assert.equal(r.code, 1); assert.match(r.lines[0], /not valid JSON/)
})

test('ci: the questions\' commit is gone (rebased): compared by size', async () => {
  const d = repo()
  const f = writeQuestions(d)
  answerAll(f, [{ text: 'a', verdict: 'pass' }, { text: 'b', verdict: 'pass' }, { text: 'c', verdict: 'explained' }])
  const c = U.readCheck(f); c.head = 'deadbeef00'; U.writeCheck(f, c)
  commitAll(d)
  const r = await ci(d, gitlabEnv(d))
  assert.equal(r.code, 0, r.lines.join('\n'))
})

test('drift is the branch\'s own change: merging main counts nothing, a conflict resolution does, a top-up never asks about main\'s code', async () => {
  const { d } = divergedRepo()
  gitIn(d, 'merge', '-q', '--no-edit', 'main')
  let r = await ciAt(d)
  assert.equal(r.code, 0, r.lines.join('\n')); assert.doesNotMatch(r.lines[0], /since the check/)
  assert.equal(U.localStatus(d).drift.lines, 0)
  assert.match(script(d, 'start', '--top-up').out, /^NOTHING: no code lines changed since the questions were written/)
  // Main changes a line the branch changed too; the conflict is resolved with new code: those lines count.
  gitIn(d, 'checkout', '-q', 'main')
  fs.writeFileSync(path.join(d, 'src/app.js'), 'export function main() {\n  return 1\n}\n')
  commitAll(d, 'main returns 1')
  gitIn(d, 'checkout', '-q', 'feat/x')
  try { gitIn(d, 'merge', '-q', '--no-edit', 'main') } catch { /* the conflict */ }
  const body = Array.from({ length: 70 }, (_, i) => `  const v${i} = load(${i}) // step ${i}`).join('\n')
  const resolved = Array.from({ length: 45 }, (_, i) => `  const w${i} = merge(${i})`).join('\n')
  fs.writeFileSync(path.join(d, 'src/app.js'), `export function main() {\n${body}\n${resolved}\n  return 1\n}\n`)
  commitAll(d, 'merge main, resolved')
  r = await ciAt(d)
  assert.equal(r.code, 1); assert.match(r.lines[0], /grew by 45 code lines/, 'the 45 resolution lines, not main\'s 260')
  const out = script(d, 'start', '--top-up').out
  assert.match(out, /NEW LINES \(ask only about these\): src\/app\.js:72-116/)
  assert.doesNotMatch(out, /refunds\.js/)
  assert.match(script(d, 'add', '--kind', 'why', '--file', 'src/refunds.js', '--lines', '1-3', '--text', 'Why are the refunds exported one constant at a time here?').out, /not part of this new change/)
  assert.equal(script(d, 'add', '--kind', 'why', '--file', 'src/app.js', '--lines', '80-82', '--text', 'Why does the merge step run after every load instead of once?').code, 0)
  assert.match(script(d, 'finish').out, /4 questions \(1 new\)/)
  const c = U.readCheck(path.join(d, 'understanding/feat-x.json'))
  assert.equal(c.base, gitIn(d, 'merge-base', 'main', 'HEAD').trim(), 'the top-up records today\'s merge base')
})

test('drift after a rebase onto main: none locally (old commits known), none in CI by size (old commits gone)', async () => {
  const { d, f } = divergedRepo()
  gitIn(d, 'rebase', '-q', 'main')
  let r = await ciAt(d)
  assert.equal(r.code, 0, r.lines.join('\n')); assert.doesNotMatch(r.lines[0], /since the check/)
  // A fresh clone in CI doesn't have the questions' commits: compared by size, still nothing.
  const c = U.readCheck(f); c.head = 'deadbeef00'; c.base = 'deadbeef01'; U.writeCheck(f, c); commitAll(d, 'as if rewritten')
  r = await ciAt(d)
  assert.equal(r.code, 0, r.lines.join('\n'))
  fs.appendFileSync(path.join(d, 'src/app.js'), Array.from({ length: 45 }, (_, i) => `export const z${i} = ${i}`).join('\n') + '\n')
  commitAll(d, 'grew')
  r = await ciAt(d)
  assert.equal(r.code, 1); assert.match(r.lines[0], /grew by 45 code lines since the check \(compared by size/)
})

test('advisory mode: a failure exits 3 ("⚠ Advisory:"), GitHub exits 0 with a warning; the comment says it doesn\'t block; UNDERSTANDING_MODE overrides the config', async () => {
  const d = repo()
  assert.equal(U.ciMode({}, {}), 'required')
  assert.equal(U.ciMode({ mode: 'advisory' }, {}), 'advisory')
  assert.equal(U.ciMode({ mode: 'advisory' }, { UNDERSTANDING_MODE: 'required' }), 'required')
  assert.equal(U.ciMode({}, { UNDERSTANDING_MODE: 'advisory' }), 'advisory')
  // Required: no file → 1.
  let r = await ci(d, gitlabEnv(d))
  assert.deepEqual([r.code, r.mode], [1, 'required']); assert.match(r.lines[0], /^✗ No understanding check yet/)
  // A merge request that switches its own check to advisory is judged by the target's settings: the change is the headline.
  fs.mkdirSync(path.join(d, 'understanding'))
  fs.writeFileSync(path.join(d, 'understanding/config.json'), '{ "mode": "advisory" }\n')
  commitAll(d, 'advisory')
  r = await ci(d, gitlabEnv(d))
  assert.deepEqual([r.code, r.mode], [1, 'required'])
  assert.match(r.comment, /^<!-- understanding-check -->\n\*\*⚠ This merge request changes the understanding check's settings: mode required → advisory\*\* \(from the merge on; this merge request follows the current settings\)\n\n\*\*Understanding check: not done yet\.\*\*/)
  assert.doesNotMatch(r.comment, /Advisory: this check/)
  // Advisory on the target branch: 3, the same message, the comment with one muted line, no skip instructions.
  gitIn(d, 'reset', '-q', '--hard', 'HEAD~1')
  configOnMain(d, '{ "mode": "advisory" }\n')
  r = await ci(d, gitlabEnv(d))
  assert.deepEqual([r.code, r.mode], [3, 'advisory']); assert.match(r.lines[0], /^⚠ Advisory: No understanding check yet: a few questions/)
  assert.match(r.comment, /^<!-- understanding-check -->\nAdvisory: this check doesn't block merging\.\n\n\*\*Understanding check: not done yet\.\*\* A few questions about your change \(3 questions, about 2 min\)/)
  assert.doesNotMatch(r.comment + r.lines.join('\n'), /skip-understanding/)
  // The env var wins over the file.
  r = await ci(d, { ...gitlabEnv(d), UNDERSTANDING_MODE: 'required' })
  assert.equal(r.code, 1); assert.doesNotMatch(r.comment, /Advisory/)
  // Can't check stays 2.
  r = await ci(d, gitlabEnv(d, undefined, { CI_MERGE_REQUEST_DIFF_BASE_SHA: 'deadbeef00' }))
  assert.equal(r.code, 2)
  // A pass stays 0, with the muted line.
  const f = writeQuestions(d)
  answerAll(f, [{ text: 'a', verdict: 'pass' }, { text: 'b', verdict: 'pass' }, { text: 'c', verdict: 'pass' }])
  commitAll(d)
  r = await ci(d, gitlabEnv(d))
  assert.equal(r.code, 0); assert.match(r.lines[0], /^✓ Understanding check done/); assert.match(r.comment, /doesn't block merging/)
  // GitHub Actions: exit 0 and a warning annotation.
  const c = U.readCheck(f); delete c.questions[2].attempts; U.writeCheck(f, c)
  commitAll(d, 'one open')
  const ev = path.join(d, '..', `event-adv-${path.basename(d)}.json`)
  fs.writeFileSync(ev, JSON.stringify({ pull_request: { number: 5, head: { sha: gitIn(d, 'rev-parse', 'HEAD').trim(), ref: 'feat/x' }, base: { sha: gitIn(d, 'rev-parse', 'main').trim() }, user: { login: 'ada' }, labels: [] } }))
  r = await ci(d, { GITHUB_ACTIONS: 'true', GITHUB_EVENT_PATH: ev, GITHUB_REPOSITORY: 'o/shop' })
  assert.equal(r.code, 0)
  assert.match(r.lines[0], /^⚠ Advisory: Understanding check: 2 of 3 done/)
  assert.match(r.lines.at(-1), /^::warning title=Understanding check::⚠ Advisory: Understanding check: 2 of 3 done/)
  // Through main: the exit code is what the job sees.
  assert.equal((await run(d, ['ci', '--no-comment'], { ...gitlabEnv(d), PATH: process.env.PATH })).code, 3)
})

test('stacked branches: the change starts after the parent\'s committed check; once the parent is merged, the merge base takes over', async () => {
  const d = repo()
  const f = writeQuestions(d)
  answerAll(f, [{ text: 'a', verdict: 'pass' }, { text: 'b', verdict: 'pass' }, { text: 'c', verdict: 'pass' }])
  commitAll(d, 'check of feat/x')
  gitIn(d, 'checkout', '-qb', 'fix/y')
  fs.writeFileSync(path.join(d, 'src/app.js'), fs.readFileSync(path.join(d, 'src/app.js'), 'utf8').replace('return 0', 'return 1'))
  commitAll(d, 'one line')
  let st = U.localStatus(d, { base: 'main' })
  assert.deepEqual([st.changed, st.stackedOn, st.state.phase], [2, 'feat/x', 'none'])
  assert.equal(U.stateWords(st.state, st).line, "2 code lines changed since feat/x's check · 1 question, ~1 min.")
  const out = script(d, 'start', '--base', 'main').out
  assert.match(out, /^STACKED: on feat\/x/m)
  assert.match(out, /CHANGE: branch fix\/y · 1 files · 2 code lines/)
  assert.match(out, /WRITE: 1 question/)
  // CI agrees: no check yet, about 2 lines (not the parent's 70).
  const r = await ci(d, { CI_MERGE_REQUEST_DIFF_BASE_SHA: gitIn(d, 'merge-base', 'main', 'HEAD').trim() })
  assert.equal(r.code, 1); assert.match(r.lines[0], /No understanding check yet/)
  // The parent is merged into main: the merge base is past its check; the change is the child's own, still 2 lines.
  gitIn(d, 'checkout', '-q', 'main'); gitIn(d, 'merge', '-q', '--no-ff', '-m', 'merge feat/x', 'feat/x'); gitIn(d, 'checkout', '-q', 'fix/y')
  st = U.localStatus(d, { base: 'main' })
  assert.deepEqual([st.changed, st.stackedOn], [2, undefined])
})

test('a renamed branch (or the same work pushed under a new name) keeps its check: covered, nothing to redo; CI agrees', async () => {
  const d = repo()
  const f = writeQuestions(d)
  answerAll(f, [{ text: 'a', verdict: 'pass' }, { text: 'b', verdict: 'pass' }, { text: 'c', verdict: 'pass' }])
  commitAll(d, 'check')
  gitIn(d, 'branch', '-m', 'feat/x', 'feat/better-name')
  const st = U.localStatus(d, { base: 'main' })
  assert.deepEqual([st.state.phase, st.stackedOn], ['nothing', 'feat/x'])
  assert.equal(U.stateWords(st.state, st).line, "Covered by feat/x's check.")
  const r = await ci(d, {})
  assert.equal(r.code, 0); assert.equal(r.lines[0], "✓ No check needed: covered by feat/x's check (no code changed since).")
})

test('an MR that only changes the check\'s settings: no check needed, and the comment says what changed', async () => {
  const d = repo()
  const f = writeQuestions(d)
  answerAll(f, [{ text: 'a', verdict: 'pass' }, { text: 'b', verdict: 'pass' }, { text: 'c', verdict: 'pass' }])
  commitAll(d)
  gitIn(d, 'checkout', '-q', 'main'); gitIn(d, 'merge', '-q', '--no-ff', '-m', 'm', 'feat/x'); gitIn(d, 'checkout', '-qb', 'chore/advisory')
  fs.writeFileSync(path.join(d, 'understanding/config.json'), '{ "mode": "advisory", "maxDrift": 60 }\n'); commitAll(d, 'advisory')
  const r = await ci(d, { CI_MERGE_REQUEST_DIFF_BASE_SHA: gitIn(d, 'rev-parse', 'main').trim() })
  assert.equal(r.code, 0)
  // Never "only comments or blank lines": the settings are what changed. Judged by main's settings (required).
  assert.equal(r.lines[0], "✓ No check needed: only the check's settings changed.")
  assert.match(r.lines[1], /This merge request changes the understanding check's settings: (mode required → advisory, maxDrift 40 → 60|maxDrift 40 → 60, mode required → advisory)\./)
  assert.equal(r.mode, 'required')
  assert.match(r.comment, /^<!-- understanding-check -->\n\*\*⚠ This merge request changes the understanding check's settings: /)
  assert.doesNotMatch(r.comment, /Advisory/)
})

test('a key of the settings that is not a setting is said in the log (ignored), never silently believed', async () => {
  const d = repo()
  configOnMain(d, '{ "minChangedLines": 20, "passRatio": 0.6 }\n')
  assert.deepEqual(U.unknownSettings(d), ['minChangedLines'])
  const r = await ci(d, gitlabEnv(d))
  assert.equal(r.code, 1)
  assert.equal(r.lines.at(-1), '  understanding/config.json: "minChangedLines" is not a setting (ignored).')
  const st = await run(d, ['status'])
  assert.match(st.out, /understanding\/config\.json: "minChangedLines" is not a setting \(ignored\)\./)
})
