// The skill's script (skills/understanding-check/scripts/questions.mjs) on real git repositories made here: start,
// add (and what it refuses), finish, top-ups, and what it asks about (comments, removals, docs, renames, stacks).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { localStatus, readCheck, stateWords, validateCheck } from '../../cli/understanding.mjs'
import { checkedRepo, codeLines, commitAll, configOnMain, gitIn, grow, repo, sha, smallRepo } from './helpers/repos.mjs'
import { add, ci, EXIT, gitlabEnv, script, writeQuestions } from './helpers/cli.mjs'
import { cliModule } from './helpers/source.mjs'

const { codeLinksIn, parseVerdict } = await cliModule('grading')
/** The draft the script keeps between `add` and `finish`. */
const draft = (d) => JSON.parse(fs.readFileSync(path.join(d, '.git/understanding-draft.json'), 'utf8'))

/** Questions on repo()'s src/app.js the script refuses, and why. */
const REFUSED = [
  [{ lines: '1-1', text: 'What does line 2 do in this function here?' }, /names a line number/],
  [{ file: 'src/other.js', lines: '1-1', text: 'How does this work when it is called twice?' }, /doesn't exist/],
  [{ lines: '3-4', text: 'How does it work? And why?' }, /more than one question/],
  [{ lines: '3-4', text: 'How does this work when it runs' }, /ending with "\?"/],
]

test('skill script: add refuses a question that names a line, a missing file, two questions, no "?"', () => {
  const d = repo()
  script(d, 'start', '--base', 'main')
  for (const [q, why] of REFUSED) assert.match(add(d, { kind: 'how', file: 'src/app.js', ...q }).out, why, q.text)
  assert.equal(add(d, { kind: 'how', file: 'src/app.js', lines: '3-4', text: 'How does main behave when it is called twice in a row?' }).code, 0)
})

test('skill script: finish wants the suggested count and more than one kind', () => {
  const d = repo()
  script(d, 'start', '--base', 'main')
  const how = (lines, text) => add(d, { kind: 'how', file: 'src/app.js', lines, text })
  how('3-4', 'How does main behave when it is called twice in a row?')
  assert.match(script(d, 'finish').out, /1 question: write 3-5 for this change \(3 suggested\)/)
  how('5-6', 'How are the loaded values used after the loop finishes?')
  how('7-8', 'How is the order of the steps decided in this function?')
  assert.match(script(d, 'finish').out, /one kind/)
})

test('skill script: the file it writes (ids, anchors, answeredBy from git, the head); start again says it exists', () => {
  const d = repo()
  const f = writeQuestions(d)
  const c = readCheck(f)
  assert.deepEqual(validateCheck(c, { repo: d }), [])
  assert.deepEqual(c.answeredBy, { name: 'Ada', email: 'ada@example.com' })
  assert.deepEqual(c.questions.map((q) => q.id), ['q1', 'q2', 'q3'])
  assert.equal(c.questions[0].anchor.v, 3)
  assert.equal(c.questions[2].target, 'file')
  assert.equal(c.head, sha(d))
  assert.match(script(d, 'start', '--base', 'main').out, /exists already/)
})

test('top-up adds questions about the new lines only, keeping answers', () => {
  const { d, f } = checkedRepo([{ text: 'GOOD', verdict: 'pass' }])
  grow(d, 50, { name: 'extra' })
  assert.match(script(d, 'start', '--top-up').out, /TOP-UP[\s\S]*WRITE: 1 question about these new lines only/)
  assert.match(add(d, { kind: 'why', file: 'src/app.js', lines: '3-4', text: 'Why are the steps loaded one at a time here again?' }).out, /not near a changed code line/)
  assert.equal(add(d, { kind: 'why', file: 'src/app.js', lines: '80-82', text: 'Why are the extra values exported one constant at a time?' }).code, 0)
  assert.match(script(d, 'finish').out, /4 questions \(1 new\)/)
  const c = readCheck(f)
  assert.deepEqual([c.questions[3].id, c.questions[3].round], ['q4', 2])
  assert.equal(c.questions[0].attempts[0].answer, 'GOOD')
  assert.equal(c.head, sha(d))
})

test('skill script: --also for the unchanged code an answer needs; lists and "…, and could" are refused', () => {
  const d = repo()
  script(d, 'start', '--base', 'main')
  assert.match(add(d, { kind: 'failure', file: 'src/app.js', lines: '3-6', text: 'If load() throws, what happens to the steps, the values and the result?' }).out, /a list of things/)
  assert.match(add(d, { kind: 'failure', file: 'src/app.js', lines: '3-6', text: 'If load() throws, what happens to main, and could a step run twice?' }).out, /asks two things/)
  assert.match(add(d, { kind: 'failure', file: 'src/app.js', lines: '3-6', text: 'If load() throws for one step, what happens to the steps after it?', also: 'src/none.js:1-2' }).out, /doesn't exist/)
  const ok = add(d, { kind: 'failure', file: 'src/app.js', lines: '3-6', text: 'When load() throws for one step, what happens to the ones after it?', also: 'src/app.js:30-32' })
  assert.equal(ok.code, 0, ok.out)
  assert.match(ok.out, /also src\/app\.js:30-32/)
  const [also] = draft(d).questions[0].also
  assert.deepEqual([also.file, also.start, also.anchor.v], ['src/app.js', 30, 3])
})

test('no size limit: a 1-line code change needs a check with 1 question; the skill enforces the count', async () => {
  const d = smallRepo(['export const rate = Math.round(price * 0.2)'])
  assert.equal(localStatus(d).state.phase, 'none')
  const r = await ci(d, gitlabEnv(d))
  assert.equal(r.code, EXIT.fail)
  assert.match(r.lines[0], /No understanding check yet/)
  assert.match(script(d, 'start', '--base', 'main').out, /1 code lines \(\+1 −0\)[\s\S]*WRITE: 1 question, about code lines/)
  assert.equal(add(d, { kind: 'edge', file: 'src/app.js', lines: '4-4', text: 'What does rate become for a price of 0.025, and why that value?' }).code, 1)
  assert.equal(add(d, { kind: 'edge', file: 'src/app.js', lines: '4-4', text: 'What value does rate get for a price that ends in half a cent?' }).code, 0)
  assert.equal(add(d, { kind: 'why', file: 'src/app.js', lines: '4-4', text: 'Why is the rate rounded here rather than when it is shown?' }).code, 0)
  assert.match(script(d, 'finish').out, /2 questions: write 1 for this change/)
  script(d, 'remove', '2')
  assert.match(script(d, 'finish').out, /WROTE understanding\/feat-x\.json: 1 questions/)
})

test('a comment-only change: nothing to check, nothing to ask; exempt files only: says which', async () => {
  const d = smallRepo(['// the rate is reviewed monthly by finance', '/*', ' * see the runbook', ' */', ''])
  let r = await ci(d, gitlabEnv(d))
  assert.equal(r.code, EXIT.pass)
  assert.equal(r.lines[0], '✓ No check needed: no code lines changed (only comments or blank lines).')
  assert.equal(localStatus(d).state.phase, 'nothing')
  assert.match(script(d, 'start', '--base', 'main').out, /^NOTHING: no code lines changed/)
  const e = smallRepo(['# Guide', '', 'Some words.'], 'docs/guide.md')
  r = await ci(e, gitlabEnv(e))
  assert.equal(r.code, EXIT.fail, 'docs count unless the config exempts them')
  // The branch's own settings don't apply to it: judged by main's.
  fs.mkdirSync(path.join(e, 'understanding'))
  fs.writeFileSync(path.join(e, 'understanding/config.json'), '{ "exempt": ["docs/**", "*.md", "package-lock.json"] }\n')
  commitAll(e, 'config')
  r = await ci(e, gitlabEnv(e))
  assert.equal(r.code, EXIT.fail)
  assert.match(r.lines[1], /^  This merge request changes the understanding check's settings: exempt \[\] → \["docs\/\*\*","\*\.md","package-lock\.json"\]\. It applies once merged\.$/)
  gitIn(e, 'reset', '-q', '--hard', 'HEAD~1')
  configOnMain(e, '{ "exempt": ["docs/**", "*.md", "package-lock.json"] }\n')
  r = await ci(e, gitlabEnv(e))
  assert.equal(r.code, EXIT.pass)
  assert.equal(r.lines[0], '✓ No check needed: only exempt files changed (docs/guide.md).')
  assert.deepEqual([localStatus(e).state.phase, localStatus(e).state.exemptOnly], ['nothing', true])
})

test('skill script: never asks about comment lines; --suspect; two-in-one questions refused', () => {
  const d = smallRepo(['// how the rate is computed', '// (finance asked for it)', 'export const rate = (p) => Math.round(p * 0.2)', 'export const fee = (p) => p > 100 ? 2 : 1'].concat(Array.from({ length: 20 }, (_, i) => `export const k${i} = ${i}`)))
  assert.match(script(d, 'start', '--base', 'main').out, /WRITE: 2 questions/)
  assert.match(add(d, { kind: 'why', file: 'src/app.js', lines: '4-5', text: 'Why does finance need the rate computed this way here?' }).out, /only comments or blank lines: ask about code/)
  const twoInOne = [
    'What does fee return for exactly 100, or does it throw for that price?',
    'What does rate return for a negative price; what does fee return then?',
    'What happens to fee at 100 and what happens to rate at 0 then?',
  ]
  for (const text of twoInOne) assert.match(add(d, { kind: 'edge', file: 'src/app.js', lines: '7-7', text }).out, /asks two things/, text)
  assert.equal(add(d, { kind: 'edge', file: 'src/app.js', lines: '7-7', suspect: true, text: 'What fee does an order of exactly 100 pay, and is that intended?' }).code, 1, 'still two things')
  const ok = add(d, { kind: 'edge', file: 'src/app.js', lines: '7-7', suspect: true, text: 'Which fee does an order of exactly 100 pay with this check?' })
  assert.equal(ok.code, 0, ok.out)
  assert.equal(add(d, { kind: 'why', file: 'src/app.js', lines: '6-6', text: 'Why is the rate rounded before it is returned instead of later?' }).code, 0)
  assert.match(script(d, 'finish').out, /WROTE/)
  const c = readCheck(path.join(d, 'understanding/feat-x.json'))
  assert.deepEqual(c.questions.map((q) => q.suspect), [true, undefined])
  assert.deepEqual(c.diffStat, { files: 1, added: 22, removed: 0 }, 'code lines only')
})

test('code links: the grader names code and links it; links are checked against the text and the files; the skill takes --links', () => {
  const d = repo()
  const v = parseVerdict(JSON.stringify({ verdict: 'retry', feedback: 'Right about the loop. Re-check what main returns.', hint: 'What does the return at the end do?',
    links: [{ phrase: 'the return at the end', file: 'src/app.js', start: 32, end: 32 }, { phrase: 'not in the text', file: 'src/app.js', start: 1, end: 1 }, { phrase: 'the loop', file: 'src/app.js', start: 900, end: 901 }, { phrase: 'main', file: '../x.js', start: 1, end: 1 }] }), 1)
  assert.deepEqual(v.links.map((l) => l.phrase), ['the return at the end', 'the loop', 'main'])
  const ok = codeLinksIn(d, v.links)
  assert.deepEqual(ok, [{ phrase: 'the return at the end', file: 'src/app.js', start: 32, end: 32, text: fs.readFileSync(path.join(d, 'src/app.js'), 'utf8').split('\n')[31] }])
  script(d, 'start', '--base', 'main')
  assert.match(add(d, { kind: 'failure', file: 'src/app.js', lines: '3-6', text: 'What happens when load() throws in the first step?', links: 'the last step@src/app.js:3-4' }).out, /is not in the question's text/)
  assert.match(add(d, { kind: 'failure', file: 'src/app.js', lines: '3-6', text: 'What happens when load() throws in the first step?', links: 'the first step@src/app.js:300-301' }).out, /not a range of a file/)
  const r = add(d, { kind: 'failure', file: 'src/app.js', lines: '3-6', text: 'What happens when load() throws in the first step?', links: 'the first step@src/app.js:2-2' })
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /1 link/)
  assert.deepEqual(draft(d).questions[0].links, [{ phrase: 'the first step', file: 'src/app.js', start: 2, end: 2, text: fs.readFileSync(path.join(d, 'src/app.js'), 'utf8').split('\n')[1] }])
})

test('a branch switch while the questions are written: start pins the branch and commit; files are read there; finish keeps them in the cache', () => {
  const d = repo()
  const head = sha(d)
  // The person switched to main before the writer started: everything is still about feat/x at its commit.
  gitIn(d, 'checkout', '-q', 'main')
  assert.match(script(d, 'start', '--base', 'main', '--branch', 'feat/x', '--head', head).out, /CHANGE: branch feat\/x · 1 files · 7\d code lines/)
  assert.equal(add(d, { kind: 'failure', file: 'src/app.js', lines: '3-6', text: 'What happens when load() throws for one of the steps here?' }).code, 0, 'lines 3-6 exist at feat/x, not on main')
  assert.equal(add(d, { kind: 'why', file: 'src/app.js', lines: '10-12', text: 'Why are the steps loaded one by one instead of all at once?', links: 'the steps@src/app.js:10-12' }).code, 0)
  assert.equal(add(d, { kind: 'edge', file: 'src/app.js', wholeFile: true, text: 'What does main return when there are no steps to load at all?' }).code, 0)
  const r = script(d, 'finish')
  assert.match(r.out, /WROTE understanding\/feat-x\.json \(kept for feat\/x: it is not checked out\): 3 questions/)
  assert.ok(!fs.existsSync(path.join(d, 'understanding')), 'nothing written to main')
  const c = readCheck(path.join(d, '.code-notes/.cache/checks/feat-x.json'))
  assert.deepEqual([c.branch, c.head, c.questions[1].links[0].text], ['feat/x', head, '  const v8 = load(8) // step 8'])
  assert.equal(gitIn(d, 'status', '--porcelain').trim(), '', 'the cache is git-ignored')
})

test('a change that only removes code: one evidence question from a search of the repository, at the removal or where the removed code was used', () => {
  const d = repo()
  gitIn(d, 'checkout', '-q', 'main')
  fs.writeFileSync(path.join(d, 'src/codes.js'), "export const CODES = {\n  SAVE10: 10,\n  SAVE15: 15,\n  SAVE20: 20,\n}\n")
  fs.writeFileSync(path.join(d, 'src/use.js'), "import { CODES } from './codes.js'\nexport const discount = (c) => CODES[c] ?? 0\n")
  fs.writeFileSync(path.join(d, 'src/old.sql'), 'ALTER TABLE orders ADD COLUMN gift boolean;\n')
  commitAll(d, 'codes')
  gitIn(d, 'checkout', '-qb', 'chore/drop')
  fs.writeFileSync(path.join(d, 'src/codes.js'), "export const CODES = {\n  SAVE10: 10,\n  SAVE20: 20,\n}\n")
  fs.rmSync(path.join(d, 'src/old.sql'))
  commitAll(d, 'drop SAVE15')
  const st = localStatus(d, { base: 'main' })
  assert.equal(stateWords(st.state, st).line, '2 code lines removed · 1 question, ~1 min.')
  const out = script(d, 'start', '--base', 'main').out
  assert.match(out, /^REMOVED ONLY: this change only removes code\. Write ONE evidence question .*src\/codes\.js:3/m)
  assert.match(out, /^EVIDENCE \(search at [0-9a-f]{7}\): SAVE15: 0 hits$/m)
  assert.match(out, /e\.g\. "Nothing calls SAVE15 any more \(search: 0 hits\) — right\?"/)
  assert.match(out, /WRITE: 1 question/)
  // At the removal (src/codes.js around line 3), or where it was used (src/use.js, not part of the diff).
  assert.equal(add(d, { kind: 'failure', file: 'src/use.js', lines: '2-2', text: 'What does discount() return now for a customer who still enters SAVE15?' }).code, 0)
  assert.match(script(d, 'finish').out, /PROBLEM: this change only removes code: its question is an evidence question/)
  assert.equal(script(d, 'remove', '1').code, 0)
  const r = add(d, { evidence: true, kind: 'change', file: 'src/codes.js', lines: '2-3', text: 'Nothing uses SAVE15 any more (search: 0 hits) — right?' })
  assert.equal(r.code, 0, r.out)
  assert.match(script(d, 'finish').out, /WROTE understanding\/chore-drop\.json: 1 questions/)
  const q = readCheck(path.join(d, 'understanding/chore-drop.json')).questions[0]
  // Graded as an evidence question (its prompt: test/goldens/check/grader-prompt.variants.txt).
  assert.equal(q.evidence, true)
  // --evidence is for removals only.
  const e = repo()
  script(e, 'start', '--base', 'main')
  assert.match(add(e, { evidence: true, kind: 'change', file: 'src/app.js', lines: '3-6', text: 'Nothing calls load any more (search: 0 hits) — right?' }).out, /PROBLEM: --evidence is for a change that only removes code/)
})

test('a rename: detected as a move (0 lines changed, not new code); it gets one question about the move itself', async () => {
  const d = repo()
  gitIn(d, 'checkout', '-q', 'main')
  fs.mkdirSync(path.join(d, 'docs'))
  fs.writeFileSync(path.join(d, 'docs/setup.md'), 'Run:\n  npm start -- --port 8080\nThen open http://localhost:8080\n')
  commitAll(d, 'setup')
  gitIn(d, 'checkout', '-qb', 'chore/rename')
  gitIn(d, 'mv', 'docs/setup.md', 'docs/setup-old.md')
  commitAll(d, 'rename')
  const st = localStatus(d, { base: 'main' })
  assert.deepEqual([st.changed, st.change.renamed, st.state.phase], [0, [{ from: 'docs/setup.md', to: 'docs/setup-old.md' }], 'none'])
  assert.equal(stateWords(st.state, st).line, 'Renamed, 0 lines changed (setup-old.md) · 1 question, ~1 min.')
  const out = script(d, 'start', '--base', 'main').out
  assert.match(out, /^RENAMED ONLY: docs\/setup\.md → docs\/setup-old\.md, 0 lines changed/m)
  assert.match(out, /WRITE: 1 question/)
  const kept = add(d, { kind: 'why', file: 'docs/setup-old.md', lines: '2-2', text: 'Why does the setup guide start the server on port 8080 here?' })
  assert.notEqual(kept.code, 0, 'never about the kept content')
  assert.equal(add(d, { kind: 'failure', file: 'docs/setup-old.md', wholeFile: true, text: 'What does a reader see who follows a link to the setup guide now that it has a new name?' }).code, 0)
  assert.match(script(d, 'finish').out, /WROTE understanding\/chore-rename\.json: 1 questions/)
  // CI: a check is needed (a move is a change), not "no code lines changed".
  fs.rmSync(path.join(d, 'understanding'), { recursive: true })
  const r = await ci(d, {})
  assert.equal(r.code, EXIT.fail)
  assert.match(r.lines[0], /No understanding check yet/)
})

test('at most one "what does it return for <numbers>" question per check', () => {
  const d = repo()
  script(d, 'start', '--base', 'main')
  assert.equal(add(d, { kind: 'edge', file: 'src/app.js', lines: '3-6', text: 'What does main return for 3 steps when load(1) throws (is that a valid result)?' }).code, 0)
  const r = add(d, { kind: 'edge', file: 'src/app.js', lines: '10-12', text: 'What value does main return when there are 70 steps to load here?' })
  assert.match(r.out, /a second "what does it return for <numbers>" question/)
  assert.equal(add(d, { kind: 'why', file: 'src/app.js', lines: '10-12', text: 'Why are the steps loaded one by one instead of all at once?' }).code, 0)
})

test('a docs-only change: one question about what a reader sees differently; "just wording" passes', () => {
  const d = repo()
  gitIn(d, 'checkout', '-q', 'main')
  fs.writeFileSync(path.join(d, 'README.md'), '# Shop\n\nWe sell outdoor gear.\n\nQuestions: #shop-team.\n')
  commitAll(d, 'readme')
  gitIn(d, 'checkout', '-qb', 'docs/typos')
  fs.writeFileSync(path.join(d, 'README.md'), '# Shop\n\nWe sell outdoor gear and camping kit.\n\nQuestions: #shop-team on chat.\n')
  commitAll(d, 'wording')
  const st = localStatus(d, { base: 'main' })
  assert.equal(stateWords(st.state, st).line, '4 lines changed (docs) · 1 question, ~1 min.')
  const out = script(d, 'start', '--base', 'main').out
  assert.match(out, /^DOCS ONLY: only documentation changed\. Write ONE question/m)
  assert.match(out, /WRITE: 1 question/)
  assert.equal(add(d, { kind: 'change', file: 'README.md', lines: '3-3', text: 'What does a reader of the README now learn about what the shop sells?' }).code, 0)
  assert.match(script(d, 'finish').out, /WROTE understanding\/docs-typos\.json: 1 questions/)
  const q = readCheck(path.join(d, 'understanding/docs-typos.json')).questions[0]
  // Graded as a docs question: "just wording" is a full pass (its prompt: test/goldens/check/grader-prompt.variants.txt).
  assert.equal(q.docs, true)
})

test('stacked branches: commits the parent made after its check are the parent\'s, never asked about on the child', async () => {
  const { d } = checkedRepo()
  // The parent goes on after its check: 10 more lines in worker.js (within its drift).
  fs.writeFileSync(path.join(d, 'src/worker.js'), codeLines(10, (i) => `export const w${i} = ${i}`))
  commitAll(d, 'parent: retry warning')
  gitIn(d, 'checkout', '-qb', 'cleanup/y')
  fs.writeFileSync(path.join(d, 'src/app.js'), fs.readFileSync(path.join(d, 'src/app.js'), 'utf8').replace('return 0', 'return 1'))
  commitAll(d, 'one line')
  const st = localStatus(d, { base: 'main' })
  assert.deepEqual([st.changed, st.stackedOn], [2, 'feat/x'])
  const out = script(d, 'start', '--base', 'main').out
  assert.match(out, /CHANGE: branch cleanup\/y · 1 files · 2 code lines/)
  assert.doesNotMatch(out, /worker\.js/)
})

test('a removal whose name is still used: the evidence names where; the estimate is 1 question', async () => {
  const d = smallRepo(['export const one = 1'])
  gitIn(d, 'checkout', '-q', 'main')
  fs.writeFileSync(path.join(d, 'src/report.js'), 'export function refundReport(rows) {\n  return rows.length\n}\nexport const keep = 1\n')
  fs.writeFileSync(path.join(d, 'src/admin.js'), "// refundReport moved to the ledger\nexport const page = 'refundReport'\n")
  commitAll(d, 'report')
  gitIn(d, 'checkout', '-qb', 'chore/no-report')
  fs.writeFileSync(path.join(d, 'src/report.js'), 'export const keep = 1\n')
  commitAll(d, 'drop refundReport')
  const st = localStatus(d, { base: 'main' })
  assert.deepEqual([st.state.want, st.state.removal], [1, true])
  assert.match(stateWords(st.state, st).line, /^3 code lines removed · 1 question, ~1 min\.$/)
  const out = script(d, 'start', '--base', 'main').out
  assert.match(out, /^EVIDENCE \(search at [0-9a-f]{7}\): refundReport: 2 hits \(src\/admin\.js:1, src\/admin\.js:2\)$/m)
  assert.match(out, /e\.g\. "refundReport is still named in src\/admin\.js \(search: 2 hits\) — what happens there now\?"/)
  // CI says the same size.
  const r = await ci(d, gitlabEnv(d, undefined, { CI_MERGE_REQUEST_SOURCE_BRANCH_NAME: 'chore/no-report' }))
  assert.match(r.lines[0], /\(1 question, about 1 min\)/)
})
