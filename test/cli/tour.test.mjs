// The tour: a journey of the change (skills/code-journey/scripts/journey.py), written after the questions and embedded
// in the check file; top-ups, its length, docs-only and removal changes.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import * as U from '../../cli/understanding.mjs'
import { gitIn, repo, run, script, writeQuestions, answerAll, commitAll, ci, JPY, tourStage, jpy, writeTourSteps } from './helpers.mjs'

test('tour: written after the questions; each question placed after a step; validated; the grader and the MR comment know it', async () => {
  const d = repo()
  const f = writeQuestions(d)
  assert.match(script(d, 'tour-finish', '--steps', 'q1=1').out, /no tour in .*run `questions\.mjs tour`/)
  const { out, dir } = tourStage(d)
  assert.match(out, /^TOUR: a journey of this change \(feat\/x, \+70 −0 code lines\): 6-10 steps[^\n]*Its title names the change/m)
  assert.match(out, /q1 \(failure\) src\/app\.js:3-6: What happens when load\(\) throws/)
  assert.match(out, /^CHANGED: src\/app\.js:/m)
  assert.ok(dir.includes('understanding-tour') && !dir.startsWith(d + '/understanding'), 'staged in the git folder, never in the tree')
  writeTourSteps(d, dir)
  // Every question needs a step that exists.
  assert.match(script(d, 'tour-finish', '--steps', 'q1=1,q2=2').out, /PROBLEM: q3 has no step/)
  assert.match(script(d, 'tour-finish', '--steps', 'q1=1,q2=2,q3=9').out, /q3=9: the tour has 6 steps/)
  assert.match(script(d, 'tour-finish', '--steps', 'q1=1,q2=2,q4=3').out, /there is no question q4/)
  const r = script(d, 'tour-finish', '--steps', 'q1=1,q2=2,q3=6')
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /WROTE the tour into understanding\/feat-x\.json: 6 steps; q1 after step 1, q2 after step 2, q3 after step 6/)
  assert.ok(!fs.existsSync(dir), 'the staging folder goes')
  const c = U.readCheck(f)
  assert.deepEqual(c.questions.map((q) => q.step), [1, 2, 6])
  assert.equal(c.journey.steps.length, 6); assert.equal(c.journey.id, 'tour'); assert.equal(c.journey.commit, c.head)
  assert.deepEqual(U.validateCheck(c, { repo: d }), [])
  // validate: a step past the tour, a step without a tour, a tour without steps.
  const bad = structuredClone(c); bad.questions[0].step = 9
  assert.match(U.validateCheck(bad).join('\n'), /q1\): "step" 9, but the journey has 6 steps/)
  const none = structuredClone(c); delete none.journey
  assert.match(U.validateCheck(none).join('\n'), /"step" 1, but the check has no journey/)
  const empty = structuredClone(c); empty.journey.steps = []; empty.questions.forEach((q) => delete q.step)
  assert.match(U.validateCheck(empty).join('\n'), /journey: "steps" must be a non-empty array/)
  const odd = structuredClone(c); odd.journey.steps[2].node = 'nope'; odd.journey.steps[3].file = '../x.js'
  assert.match(U.validateCheck(odd).join('\n'), /journey: step 3: "node" "nope" is not a box[\s\S]*journey: step 4: "file" must be a path inside/)
  // A step's file deleted later never fails the check (the extension shows it as stale).
  const gone = structuredClone(c); gone.journey.steps[0].file = 'src/gone.js'
  assert.deepEqual(U.validateCheck(gone, { repo: d }), [])
  // The grader sees the tour, and where this question's answer is.
  assert.equal(U.tourText(c).split('\n')[0], '1. Main loads step number 1 here (src/app.js:10-11)')
  const p = U.graderPrompt({ q: c.questions[1], answer: 'x', attempt: 1, diff: '', code: '', canRead: true, tour: U.tourText(c) })
  assert.match(p, /A guided tour of the change[\s\S]*6\. Main returns zero at the end[\s\S]*visible by step 2\.[\s\S]*"step N"/)
  assert.doesNotMatch(U.graderPrompt({ q: c.questions[1], answer: 'x', attempt: 1, diff: '', code: '', canRead: true, tour: '' }), /guided tour/)
  // CI: passes as before; the comment's first line points reviewers at the tour.
  answerAll(f, [{ text: 'a', verdict: 'pass' }, { text: 'b', verdict: 'pass' }, { text: 'c', verdict: 'pass' }])
  commitAll(d)
  const res = await run(d, ['ci', '--no-comment', '--base', 'main'])
  assert.equal(res.code, 0, res.out)
  const body = U.commentBody(U.readCheck(f), U.summarize(U.readCheck(f), U.DEFAULTS), '**✓ Understanding check done**')
  assert.deepEqual(body.split('\n').slice(0, 4), [U.MARKER, '**✓ Understanding check done**', '', 'A guided tour of this change: open it in VS Code with Code Notes (Check view)'])
  assert.equal(U.commentBody(none, U.summarize(none, U.DEFAULTS), 'head').split('\n')[1], 'head', 'no tour, no line')
})

test('tour top-up: steps for the new part are appended; earlier steps and their questions stay; old files without a tour still pass', async () => {
  const d = repo()
  const f = writeQuestions(d)
  writeTourSteps(d, tourStage(d).dir)
  assert.equal(script(d, 'tour-finish', '--steps', 'q1=1,q2=2,q3=6').code, 0)
  answerAll(f, [{ text: 'GOOD', verdict: 'pass' }])
  commitAll(d)
  fs.appendFileSync(path.join(d, 'src/app.js'), Array.from({ length: 50 }, (_, i) => `export const extra${i} = ${i}`).join('\n') + '\n')
  commitAll(d, 'more')
  script(d, 'start', '--top-up')
  assert.equal(script(d, 'add', '--kind', 'why', '--file', 'src/app.js', '--lines', '80-82', '--text', 'Why are the extra values exported one constant at a time?').code, 0)
  assert.match(script(d, 'finish').out, /4 questions \(1 new\)/)
  // A top-up without a step yet is a valid file (the tour comes right after).
  assert.deepEqual(U.validateCheck(U.readCheck(f), { repo: d }), [])
  const { out, dir } = tourStage(d, true)
  assert.match(out, /^TOUR TOP-UP: the tour of feat\/x has 6 steps; add 1-4 after step 6/m)
  assert.match(out, /STEPS SO FAR[\s\S]*6\. Main returns zero at the end/)
  assert.match(out, /QUESTIONS that need a step:\n {2}q4 \(why\) src\/app\.js:80-82/)
  assert.doesNotMatch(out, / {2}q1 /)
  // Changing an earlier step is refused.
  jpy(d, dir, ['restep', d, 'tour', '1', 'title', 'Main loads the first step here'])
  jpy(d, dir, ['node', d, 'tour', 'f_extra', 'function', 'the extra values', 'app', 'src/app.js:74-123'], 'The extra exports.')
  jpy(d, dir, ['edge', d, 'tour', 'f_main', 'f_extra', 'sits beside'])
  jpy(d, dir, ['step', d, 'tour', 'f_extra', 'src/app.js', '80', '82', 'The extra values are exported one by one'], 'Each constant is its own export, so a reader imports only what it needs.')
  assert.match(script(d, 'tour-finish', '--steps', 'q4=7').out, /PROBLEM: the first 6 steps changed: a top-up only adds steps after step 6/)
  jpy(d, dir, ['restep', d, 'tour', '1', 'title', 'Main loads step number 1 here'])
  assert.match(script(d, 'tour-finish', '--steps', 'q4=7,q1=3').out, /q1 is at step 1 already: keep it/)
  const r = script(d, 'tour-finish', '--steps', 'q4=7')
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /7 steps \(1 new\)/)
  const c = U.readCheck(f)
  assert.deepEqual(c.questions.map((q) => q.step), [1, 2, 6, 7])
  assert.equal(c.journey.steps[6].title, 'The extra values are exported one by one')
  assert.equal(c.questions[0].attempts[0].answer, 'GOOD', 'answers kept')
  assert.ok(c.journey.updatedAt && c.journey.createdAt)
  // An older check (no tour at all) still validates and passes CI.
  const old = repo()
  const of = writeQuestions(old)
  answerAll(of, [{ text: 'a', verdict: 'pass' }, { text: 'b', verdict: 'pass' }, { text: 'c', verdict: 'pass' }])
  commitAll(old)
  assert.equal(U.readCheck(of).journey, undefined)
  const res = await run(old, ['ci', '--no-comment', '--base', 'main'])
  assert.equal(res.code, 0, res.out)
})

test('tour: its length follows the change; a change that mostly removes code gets a tour of what went', () => {
  const d = repo()
  const f = writeQuestions(d)
  const size = (st) => { const c = U.readCheck(f); c.diffStat = { files: 1, ...st }; U.writeCheck(f, c) }
  size({ added: 2, removed: 0 })
  let { out, dir } = tourStage(d)
  assert.match(out, /: 2-3 steps through/); assert.doesNotMatch(out, /REMOVAL/)
  assert.match(out, /^SMALL: a few lines changed\. Steps around the changed lines/m)
  writeTourSteps(d, dir)
  assert.match(script(d, 'tour-finish', '--steps', 'q1=1,q2=2,q3=6').out, /PROBLEM: 6 steps: a tour of this change has 2-3 \(its size\)/)
  size({ added: 15, removed: 0 })
  ;({ out } = tourStage(d))
  assert.match(out, /: 2-4 steps through/); assert.doesNotMatch(out, /SMALL/)
  size({ added: 1, removed: 40 })
  ;({ out } = tourStage(d))
  assert.match(out, /: 4-7 steps through/)
  assert.match(out, /^REMOVAL: this change mostly removes code\. Steps: what was removed/m)
  // Only removes code: a short tour of where it was used and why removing it is safe.
  size({ added: 0, removed: 40 })
  ;({ out } = tourStage(d))
  assert.match(out, /: 2-3 steps\. Its title/)
  assert.match(out, /^REMOVAL: this change only removes code\. Steps on code that is still there: where the removed code used to be called/m)
  assert.match(script(d, 'tour-finish', '--none').out, /PROBLEM: --none is only for a change to documentation/)
})

test('a docs-only change: its tour shows the code the text describes (any step), or none when it describes no code', () => {
  const d = repo()
  gitIn(d, 'checkout', '-q', 'main')
  fs.writeFileSync(path.join(d, 'README.md'), '# Shop\n\nmain() returns 0.\n')
  commitAll(d, 'readme')
  gitIn(d, 'checkout', '-qb', 'docs/main')
  fs.writeFileSync(path.join(d, 'README.md'), '# Shop\n\nmain() returns 0 when every step loaded.\n')
  commitAll(d, 'wording')
  script(d, 'start', '--base', 'main')
  assert.equal(script(d, 'add', '--kind', 'change', '--file', 'README.md', '--lines', '3-3', '--text', 'What can a reader of the README now tell about what main returns?').code, 0)
  assert.match(script(d, 'finish').out, /WROTE understanding\/docs-main\.json: 1 questions/)
  const f = path.join(d, 'understanding/docs-main.json')
  const { out, dir } = tourStage(d)
  assert.match(out, /: 2-3 steps\. Its title/)
  assert.match(out, /^DOCS: the change edits documentation\. Steps on the EXISTING code the edited text describes.*tour-finish --none$/m)
  // Two steps on src/app.js (the code the text describes): q1 is on README.md, any step shows its answer.
  jpy(d, dir, ['new', d, 'tour', 'What does main return?', 'Saying what main returns'], 'The README now says what main returns. Main is in src/app.js.')
  jpy(d, dir, ['node', d, 'tour', 'app', 'system', 'App', '--blurb', 'The program'], 'The program.')
  jpy(d, dir, ['node', d, 'tour', 'f_main', 'function', 'main', 'app', 'src/app.js:1-3'], 'Main.')
  jpy(d, dir, ['node', d, 'tour', 'f_end', 'function', 'the end of main', 'app', 'src/app.js:2-3'], 'Returns.')
  jpy(d, dir, ['edge', d, 'tour', 'f_main', 'f_end', 'returns zero'])
  jpy(d, dir, ['step', d, 'tour', 'f_main', 'src/app.js', '1', '1', 'Main is where the program starts'], 'Everything starts in main, which the README now describes.')
  jpy(d, dir, ['step', d, 'tour', 'f_end', 'src/app.js', '2', '2', 'Main returns zero at the end'], 'Nothing is returned but zero, whatever happened before.')
  assert.match(execFileSync('python3', [JPY, 'check', d, 'tour', 'quiet', '--dir', dir, '--steps', '2-3'], { cwd: d, encoding: 'utf8' }), /^ok: 2 steps, 0 problems/m)
  const r = script(d, 'tour-finish', '--steps', 'q1=1')
  assert.equal(r.code, 0, r.out)
  assert.equal(U.readCheck(f).journey.steps.length, 2)
  // Describes no code: no tour, on purpose; the file says so and stays valid.
  const c = U.readCheck(f); delete c.journey; delete c.questions[0].step; U.writeCheck(f, c)
  tourStage(d)
  assert.match(script(d, 'tour-finish', '--none').out, /^WROTE understanding\/docs-main\.json: no tour/)
  const after = U.readCheck(f)
  assert.deepEqual([after.noTour, after.journey, U.validateCheck(after)], [true, undefined, []])
  assert.deepEqual(U.validateCheck({ ...after, noTour: 'yes' }), ['"noTour" must be true or left out'])
})
