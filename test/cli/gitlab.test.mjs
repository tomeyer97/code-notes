// `understanding ci` on GitLab, against a fake API (a local HTTP server): approvals and the skip label, the merge
// request comment, concern threads and "Worth discussing" threads.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import * as U from '../../cli/understanding.mjs'
import { gitIn, repo, run, writeQuestions, answerAll, commitAll, fakeApi, gitlabEnv, ci, fakeServer, BOT, BOB, concernRepo } from './helpers.mjs'

test('ci on GitLab: skip label + an approval by a non-author waives; self-approval and no approval say what to do; the comment is updated in place', async () => {
  const d = repo()
  let approvals = []
  const notes = []
  const mr = '/projects/grp%2Fshop/merge_requests/7'
  const api = await fakeApi({
    [`GET ${mr}`]: () => ({ labels: ['skip-understanding'], author: { username: 'alice' } }),
    [`GET ${mr}/approvals`]: () => ({ approved_by: approvals }),
    [`GET ${mr}/notes`]: () => notes,
    [`POST ${mr}/notes`]: (b) => { notes.push({ id: 11, body: b.body }); return notes[0] },
    [`PUT ${mr}/notes/11`]: (b) => { notes[0].body = b.body; return notes[0] },
  })
  try {
    const env = { ...gitlabEnv(d, api.url), GITLAB_TOKEN: 'tok' }
    // Label, no approval yet.
    let r = await ci(d, env)
    assert.equal(r.code, 1)
    assert.equal(r.lines[0], 'Skip requested: an approval from a reviewer waives the understanding check, then re-run this job.')
    assert.equal(notes[0].body, '<!-- understanding-check -->\nSkip requested: an approval from a reviewer waives the understanding check, then re-run this job.')
    assert.equal(api.calls[0].headers['private-token'], 'tok')
    // The author approved their own merge request.
    approvals = [{ user: { username: 'alice' } }]
    r = await ci(d, env)
    assert.equal(r.code, 1)
    assert.equal(r.lines[0], '✗ Approved only by alice (the author). Ask a reviewer to approve, then re-run this job.')
    assert.doesNotMatch(notes[0].body, /✗/, 'no ✗ in the comment')
    assert.equal(notes[0].body, "<!-- understanding-check -->\nYour own approval doesn't count: ask a reviewer to approve, then re-run this job.")
    // A reviewer's approval (any, also one given before the label) waives it.
    approvals = [{ user: { username: 'alice' } }, { user: { username: 'bob' } }]
    r = await ci(d, env)
    assert.equal(r.code, 0)
    assert.equal(r.lines[0], '✓ Understanding check waived (approved by @bob)')
    assert.equal(notes.length, 1)
    assert.equal(notes[0].body, '<!-- understanding-check -->\n✓ Understanding check waived (approved by @bob)')
    // Label set, no approval, but the check itself passes: it passes, no skip message.
    approvals = []
    const f = writeQuestions(d)
    answerAll(f, [{ text: 'a', verdict: 'pass' }, { text: 'b', verdict: 'pass' }, { text: 'c', verdict: 'pass' }])
    commitAll(d)
    r = await ci(d, env)
    assert.equal(r.code, 0, r.lines.join('\n')); assert.match(r.lines[0], /^✓ Understanding check done/)
    assert.match(notes[0].body, /^<!-- understanding-check -->\n\*\*✓ Understanding check done\*\* · 3 questions/)
    assert.equal(notes.length, 1, 'one comment, updated in place')
  } finally { api.close() }
})

test('the MR comment never grades in public: one progress line until done; then Q&A, worth discussing, flagged concerns, short reasoning', async () => {
  const d = repo()
  const notes = []
  const mr = '/projects/grp%2Fshop/merge_requests/7'
  const api = await fakeApi({
    [`GET ${mr}`]: () => ({ labels: [], author: { username: 'alice' } }), [`GET ${mr}/notes`]: () => notes,
    [`POST ${mr}/notes`]: (b) => { notes.push({ id: 11, body: b.body }); return notes[0] }, [`PUT ${mr}/notes/11`]: (b) => { notes[0].body = b.body; return notes[0] },
  })
  const env = () => ({ ...gitlabEnv(d, api.url), GITLAB_TOKEN: 'tok', CI_PROJECT_URL: 'https://gl/grp/shop' })
  const grade = (q, answer, verdict, extra = {}) => { const a = U.addAttempt({ answeredBy: { name: 'Ada' } }, q, answer); Object.assign(a, { verdict, feedback: '', ...extra }); a.hash = U.attemptHash(q, a) }
  try {
    const f = writeQuestions(d)
    let c = U.readCheck(f)
    grade(c.questions[0], 'It is kept in\na file.', 'pass', { feedback: 'Right. Also the file is rewritten atomically, so a crash leaves the old one in place for readers.' })
    grade(c.questions[1], 'WRONG GUESS ONE', 'retry', { feedback: 'Not quite.', hint: 'Look at 12' })
    U.writeCheck(f, c); commitAll(d)
    let r = await ci(d, env())
    assert.equal(r.code, 1)
    assert.equal(notes[0].body, '<!-- understanding-check -->\n**Understanding check in progress:** 1 of 3 done (about 1 min left).')
    // Done: an explained question with a flagged concern, a suspect question with a concern, a concern nobody flagged.
    c = U.readCheck(f)
    grade(c.questions[1], 'WRONG GUESS TWO', 'explained', { feedback: 'Each step waits for the one before it, so a slow load delays the rest. See src/app.js:3.', topic: 'loading steps one by one' })
    grade(c.questions[2], 'It returns 0.', 'pass', { feedback: 'Right.', note: 'Returns 0 with no steps: the loop body never runs.' })
    c.questions[2].suspect = true
    c.questions[2].concern = { text: 'main reports success when nothing was loaded.', flagged: false }
    c.questions[1].concern = { text: 'load() errors are swallowed: a failed step\nlooks like a success.', flagged: true }
    c.questions[0].concern = { text: 'Not flagged: stays in the editor.', flagged: false }
    U.writeCheck(f, c); commitAll(d)
    r = await ci(d, env())
    assert.equal(r.code, 0, r.lines.join('\n'))
    const body = notes[0].body
    const lines = body.split('\n')
    assert.equal(lines[1], '**✓ Understanding check done** · 3 questions')
    // Short: one line per problem ("may be a bug" first, then flagged concerns), then concerns nobody flagged, then all answers collapsed.
    assert.match(lines[3], /^- ⚠ May be a bug: main reports success when nothing was loaded\. · \[`src\/app\.js`\]/)
    assert.match(lines[4], /^- ⚠ load\(\) errors are swallowed\\: a failed step looks like a success\. · \[`src\/app\.js:10-12`\]\(https:\/\/gl\/grp\/shop\/-\/merge_requests\/7\/diffs#/)
    // q2's "Worth discussing" goes with its concern: one problem, one line.
    assert.equal(lines[5], '')
    assert.doesNotMatch(body, /Worth discussing/)
    assert.match(body, /\n\*\*Also noticed while grading\*\*\n- Not flagged\\: stays in the editor\. · \[`src\/app\.js:3-6`\]/)
    assert.equal(body.split('main reports success').length, 2, 'said once')
    assert.match(body, /\n<details><summary>All answers<\/summary>\n/)
    // Each answer once, as typed; never the grader's words as an answer.
    assert.match(body, /> It is kept in\n> a file\.\n/)
    assert.doesNotMatch(body, /<sub>|Returns 0 with no steps|rewritten atomically|Check: /)
    assert.match(body, /instead of all at once\?\*\* · [^\n]+ · explained\n/)
    assert.match(body, /no steps to load at all\?\*\* · \[`src\/app\.js`\]\([^)]+\) · may be a bug/)
    for (const w of ['WRONG GUESS', 'try again', 'retry', '✗', 'Not quite', 'Look at 12']) assert.ok(!body.includes(w), `the comment must not show "${w}"`)
    assert.ok(body.indexOf('load() errors') < body.indexOf('It is kept in'), 'the items come first')
    // The reasoning line is at most 15 words.
    assert.ok(U.reasonOf({ feedback: 'Right. ' + 'word '.repeat(30) }).split(' ').length <= 15)
    assert.equal(U.reasonOf({ note: 'Right: tick() re-queues it.', feedback: 'Right.' }), 'tick() re-queues it.')
    assert.equal(U.reasonOf({ feedback: 'Right.' }), '')
    // Drift: the first line says what is missing, the answers stay below.
    fs.appendFileSync(path.join(d, 'src/app.js'), Array.from({ length: 45 }, (_, i) => `export const z${i} = ${i}`).join('\n') + '\n')
    commitAll(d, 'more')
    r = await ci(d, env())
    assert.equal(r.code, 1)
    assert.match(notes[0].body, /^<!-- understanding-check -->\n\*\*Understanding check: needs a top-up\.\*\* The change grew by 45 code lines since the questions; 1–2 questions about the new part are missing\./)
    assert.match(notes[0].body, /May be a bug/)
    // A damaged file: one line, what is wrong.
    fs.writeFileSync(f, '{ "version": 1, '); commitAll(d)
    r = await ci(d, env())
    assert.equal(notes[0].body, '<!-- understanding-check -->\n**Understanding check:** `understanding/feat-x.json` is not valid JSON. Run **Check my understanding** again.')
    assert.equal(notes.length, 1)
  } finally { api.close() }
})

test('ci: no check yet posts the MR comment (what and how, in two lines); a pass says the room left before a top-up; refs link to the diff', async () => {
  const d = repo()
  const notes = []
  const mr = '/projects/grp%2Fshop/merge_requests/7'
  const api = await fakeApi({
    [`GET ${mr}`]: () => ({ labels: [], author: { username: 'ada' } }), [`GET ${mr}/notes`]: () => notes,
    [`POST ${mr}/notes`]: (b) => { notes.push({ id: 11, body: b.body }); return notes[0] }, [`PUT ${mr}/notes/11`]: (b) => { notes[0].body = b.body; return notes[0] },
  })
  try {
    let r = await ci(d, { ...gitlabEnv(d, api.url), GITLAB_TOKEN: 'tok', CI_PROJECT_URL: 'https://gl/grp/shop' })
    assert.equal(r.code, 1); assert.match(r.lines.at(-1), /comment created/)
    assert.equal(notes[0].body.split('\n').length, 3)
    assert.match(notes[0].body, /^<!-- understanding-check -->\n\*\*Understanding check: not done yet\.\*\* A few questions about your change \(3 questions, about 2 min\)/)
    // GitLab reads "~2" as a label: the bot never writes a tilde.
    assert.doesNotMatch(notes[0].body, /~/)
    assert.match(notes[0].body, /and get a reviewer's approval, then re-run the job\./)
    const f = writeQuestions(d)
    answerAll(f, [{ text: 'a', verdict: 'pass' }, { text: 'b', verdict: 'pass' }, { text: 'c', verdict: 'pass' }])
    commitAll(d)
    fs.appendFileSync(path.join(d, 'src/app.js'), 'export const one = 1\nexport const two = 2\n')
    commitAll(d, 'two more')
    r = await ci(d, { ...gitlabEnv(d, api.url), GITLAB_TOKEN: 'tok', CI_PROJECT_URL: 'https://gl/grp/shop' })
    assert.equal(r.code, 0, r.lines.join('\n'))
    assert.match(r.lines[0], /done: 3 of 3 passed \(Answer all 3 · 2 must pass\)\. 2 code lines since the check \(top-up at 40\)\.$/)
    assert.equal(notes.length, 1, 'the same comment, now the result')
    assert.match(notes[0].body, /\[`src\/app\.js:3-6`\]\(https:\/\/gl\/grp\/shop\/-\/merge_requests\/7\/diffs#[0-9a-f]{40}_\d+_3\)/)
  } finally { api.close() }
})

test('flagged concerns on GitLab: a thread on the line, never twice, updated, resolved when un-flagged, a note when the line is not in the diff', async (t) => {
  const { d, set } = concernRepo()
  const mr = '/projects/grp%2Fshop/merge_requests/7'
  const discussions = []
  let n = 0
  const api = await fakeServer((m, p, b) => {
    if (m === 'GET' && p === mr) return [200, { labels: [], author: { username: 'ada' }, diff_refs: { base_sha: 'b1', start_sha: 's1', head_sha: 'h1' } }]
    if (p === `${mr}/notes`) return [200, m === 'GET' ? [] : { id: 1 }]
    if (m === 'GET' && p === `${mr}/discussions`) return [200, discussions]
    if (m === 'POST' && p === `${mr}/discussions`) {
      if (b.position && b.position.new_line > 500) return [400, { message: 'line_code can\'t be blank' }]
      const dsc = { id: `d${++n}`, notes: [{ id: n, body: b.body, resolved: false, position: b.position, author: BOT }] }
      discussions.push(dsc)
      return [201, dsc]
    }
    const note = /discussions\/(d\d+)\/notes\/(\d+)$/.exec(p)
    if (m === 'PUT' && note) {
      const x = discussions.find((y) => y.id === note[1])
      x.notes[0].body = b.body
      return [200, x.notes[0]]
    }
    const res = /discussions\/(d\d+)$/.exec(p)
    if (m === 'PUT' && res) {
      const x = discussions.find((y) => y.id === res[1])
      x.notes[0].resolved = b.resolved
      x.notes[0].resolved_by = b.resolved ? BOT : null
      return [200, x]
    }
  })
  const env = () => ({ ...gitlabEnv(d, api.url), GITLAB_TOKEN: 'tok', CI_PROJECT_URL: 'https://gl/grp/shop' })
  /** q1's concern as Bob flagged it, with `text`. */
  const flaggedByBob = (text) => ({ text, flagged: true, by: { name: 'Bob' } })
  /** The first concern thread's first note (the bot's). */
  const thread = () => discussions[0].notes[0]
  const log = (r) => r.lines.join('\n')
  try {
    await t.test('flagged: a thread on its line, linked at the top of the bot comment, said once', async () => {
      const r = await ci(d, env())
      assert.equal(r.code, 0, log(r))
      assert.ok(r.lines.includes('  Concern posted on src/app.js:6 (q1).'), log(r))
      assert.equal(discussions.length, 1)
      assert.deepEqual(thread().position, { position_type: 'text', base_sha: 'b1', start_sha: 's1', head_sha: 'h1', new_path: 'src/app.js', new_line: 6 })
      assert.equal(thread().body, '<!-- understanding-concern:q1 -->\n⚠ **Found during the understanding check** (flagged by Bob)\nload() errors are swallowed; tell @⁠carol')
      assert.match(r.comment, /\n\n- ⚠ \[load\(\) errors are swallowed; tell @⁠carol\]\(https:\/\/gl\/grp\/shop\/-\/merge_requests\/7#note_1\)\n/, 'at the top of the bot comment, as a link to its thread')
      assert.equal(r.comment.split('load() errors').length, 2, 'said once in the comment')
    })
    await t.test('a re-run: nothing new', async () => {
      const r = await ci(d, env())
      assert.equal(discussions.length, 1)
      assert.ok(!r.lines.some((l) => /Concern/.test(l)), log(r))
    })
    await t.test('the text changed: updated in place', async () => {
      set(flaggedByBob('load() errors are swallowed'))
      const r = await ci(d, env())
      assert.equal(discussions.length, 1)
      assert.match(thread().body, /swallowed$/)
      assert.ok(r.lines.includes('  Concern updated (q1).'))
    })
    await t.test('un-flagged: resolved, once; flagged again: reopened', async () => {
      set({ text: 'load() errors are swallowed', flagged: false })
      let r = await ci(d, env())
      assert.equal(thread().resolved, true)
      assert.ok(r.lines.includes('  Concern resolved (q1): no longer flagged.'))
      r = await ci(d, env())
      assert.ok(!r.lines.some((l) => /Concern/.test(l)), 'resolved once')
      set(flaggedByBob('load() errors are swallowed'))
      r = await ci(d, env())
      assert.equal(thread().resolved, false)
      assert.ok(r.lines.includes('  Concern reopened (q1).'))
    })
    await t.test('the reviewer resolves it: never reopened by the bot', async () => {
      Object.assign(thread(), { resolved: true, resolved_by: BOB })
      const r = await ci(d, env())
      assert.equal(thread().resolved, true)
      assert.ok(!r.lines.some((l) => /reopened/.test(l)), log(r))
    })
    await t.test('the reviewer replied, then the author un-flags it: the thread is theirs, never resolved by the bot', async () => {
      Object.assign(thread(), { resolved: false, resolved_by: null })
      discussions[0].notes.push({ id: 77, body: 'Agreed, fix it.', author: BOB })
      set({ text: 'load() errors are swallowed', flagged: false })
      const r = await ci(d, env())
      assert.equal(thread().resolved, false)
      assert.ok(!r.lines.some((l) => /resolved/.test(l)), log(r))
    })
    await t.test('the question gone: its thread resolved; a concern whose line is not in the diff: a plain note with a link', async () => {
      // Back to the bot's own thread, flagged.
      discussions[0].notes.pop()
      Object.assign(thread(), { resolved: true, resolved_by: BOT })
      set(flaggedByBob('load() errors are swallowed'))
      await ci(d, env())
      set({ text: 'Off the diff', flagged: true }, (c) => {
        c.questions[0].concern = undefined
        c.questions[1].start = 900
        c.questions[1].end = 901
        c.questions[1].anchor = undefined
        c.questions[1].concern = { text: 'Off the diff', flagged: true }
      })
      const r = await ci(d, env())
      assert.equal(r.code, 0, log(r))
      assert.equal(thread().resolved, true)
      assert.equal(discussions.length, 2)
      assert.equal(discussions[1].notes[0].position, undefined)
      assert.match(discussions[1].notes[0].body, /^<!-- understanding-concern:q2 -->\n⚠ \*\*Found during the understanding check\*\* \(flagged by Ada\)\nOff the diff · \[`src\/app\.js:901`\]\(https:\/\/gl\/grp\/shop\/-\/merge_requests\/7\/diffs#[0-9a-f]{40}_\d+_901\)$/)
      assert.ok(r.lines.includes('  Concern posted as a note (q2).'))
    })
  } finally { api.close() }
})

test('GitLab: "Worth discussing" items are resolvable threads too, never resolved by the bot; a concern whose code changed says where', async () => {
  const d = repo()
  const f = writeQuestions(d)
  const c = U.readCheck(f)
  const grade = (q, answer, verdict, extra = {}) => { const a = U.addAttempt(c, q, answer); Object.assign(a, { verdict, feedback: '', ...extra }); a.hash = U.attemptHash(q, a) }
  grade(c.questions[0], 'a', 'pass', { concern: 'load() errors are swallowed.', links: [{ phrase: 'load() errors', file: 'src/app.js', start: 5, end: 5, text: '  const v3 = load(3) // step 3' }] })
  c.questions[0].concern = { text: 'load() errors are swallowed.', flagged: true }
  grade(c.questions[1], 'no idea', 'explained', { feedback: 'Each step waits for the one before.', topic: 'steps one by one', note: 'Each step waits for the one before.' })
  grade(c.questions[2], 'It returns 0.', 'pass')
  U.writeCheck(f, c); commitAll(d)
  const mr = '/projects/grp%2Fshop/merge_requests/7'
  const discussions = [], notes = []
  let n = 0
  const api = await fakeServer((m, p, b) => {
    if (m === 'GET' && p === mr) return [200, { labels: [], author: { username: 'ada' }, diff_refs: { base_sha: 'b1', start_sha: 's1', head_sha: 'h1' } }]
    if (p === `${mr}/notes`) { if (m === 'GET') return [200, notes]; notes.push({ id: 900, body: b.body }); return [201, notes[0]] }
    if (m === 'PUT' && p === `${mr}/notes/900`) { notes[0].body = b.body; return [200, notes[0]] }
    if (m === 'GET' && p === `${mr}/discussions`) return [200, discussions]
    if (m === 'POST' && p === `${mr}/discussions`) { const x = { id: `d${++n}`, notes: [{ id: n, body: b.body, resolved: false, position: b.position, author: BOT }] }; discussions.push(x); return [201, x] }
    const note = /discussions\/(d\d+)\/notes\/(\d+)$/.exec(p)
    if (m === 'PUT' && note) { const x = discussions.find((y) => y.id === note[1]); x.notes[0].body = b.body; return [200, x.notes[0]] }
    const res = /discussions\/(d\d+)$/.exec(p)
    if (m === 'PUT' && res) { const x = discussions.find((y) => y.id === res[1]); x.notes[0].resolved = b.resolved; return [200, x] }
  })
  const env = () => ({ ...gitlabEnv(d, api.url), GITLAB_TOKEN: 'tok', CI_PROJECT_URL: 'https://gl/grp/shop' })
  try {
    let r = await ci(d, env())
    assert.equal(r.code, 0, r.lines.join('\n'))
    const disc = discussions.find((x) => x.notes[0].body.includes('understanding-concern:q2'))
    assert.ok(disc, r.lines.join('\n'))
    assert.equal(disc.notes[0].position.new_line, 10)
    assert.match(disc.notes[0].body, /💬 \*\*Worth discussing\*\* \(understanding check\): steps one by one\nEach step waits for the one before\./)
    // The top comment: the status line, one link per thread (concern first), the answers collapsed.
    const lines = notes[0].body.split('\n')
    assert.match(lines[3], /^- ⚠ \[load\(\) errors are swallowed\.\]\(https:\/\/gl\/grp\/shop\/-\/merge_requests\/7#note_\d+\)$/)
    assert.match(lines[4], /^- 💬 \[Worth discussing: steps one by one\]\(https:\/\/gl\/grp\/shop\/-\/merge_requests\/7#note_\d+\)$/)
    // Never twice.
    r = await ci(d, env())
    assert.equal(discussions.length, 2)
    // The concern's code changes (load(3) rewritten): the commit is named, in the comment and in its thread.
    fs.writeFileSync(path.join(d, 'src/app.js'), fs.readFileSync(path.join(d, 'src/app.js'), 'utf8').replace('load(3) // step 3', 'safeLoad(3) // step 3'))
    commitAll(d, 'fix')
    const sha = gitIn(d, 'rev-parse', '--short', 'HEAD').trim()
    r = await ci(d, env())
    assert.ok(notes[0].body.split('\n').includes(`- ⚠ [load() errors are swallowed.](https://gl/grp/shop/-/merge_requests/7#note_1) · lines changed in ${sha} · fixed?`), notes[0].body)
    assert.match(discussions[0].notes[0].body, new RegExp(`Lines changed in ${sha} · fixed\\?`))
    // The change grows past the top-up limit: the "Worth discussing" thread stays open (only a person resolves it).
    fs.appendFileSync(path.join(d, 'src/app.js'), Array.from({ length: 45 }, (_, i) => `export const z${i} = ${i}`).join('\n') + '\n')
    commitAll(d, 'more')
    r = await ci(d, env())
    assert.equal(r.code, 1)
    assert.equal(disc.notes[0].resolved, false, r.lines.join('\n'))
    assert.match(notes[0].body, /Worth discussing: steps one by one/)
    gitIn(d, 'reset', '-q', '--hard', 'HEAD~1')
    // Marked fixed in VS Code (flag off, fixed set): its thread is resolved and it leaves the comment.
    const c2 = U.readCheck(f); c2.questions[0].concern = { ...c2.questions[0].concern, flagged: false, fixed: { at: 'now' } }; U.writeCheck(f, c2); commitAll(d, 'marked fixed')
    r = await ci(d, env())
    assert.equal(discussions[0].notes[0].resolved, true)
    assert.doesNotMatch(notes[0].body, /swallowed/)
  } finally { api.close() }
})

test('GitLab: a thread whose line is outside the diff goes on the nearest changed line and names its own; an earlier "Worth discussing" thread is reused', async () => {
  const { d, set } = concernRepo()
  // The concern names `return 0` (line 72, unchanged, right after the last added line 71; its link says 73: found by its text).
  set({ text: 'main returns 0 even after a failed step.', flagged: true }, (c) => { c.questions[0].attempts.at(-1).concern = 'main returns 0 even after a failed step.'; c.questions[0].attempts.at(-1).links = [{ phrase: 'main returns 0', file: 'src/app.js', start: 73, end: 73, text: '  return 0' }] })
  const mr = '/projects/grp%2Fshop/merge_requests/7'
  const discussions = [{ id: 'd0', notes: [{ id: 50, body: '<!-- understanding-concern:discuss-q2 -->\n💬 **Worth discussing** (understanding check): old', resolved: false, position: { new_line: 10 }, author: BOT }] }]
  let n = 100
  const api = await fakeServer((m, p, b) => {
    if (m === 'GET' && p === mr) return [200, { labels: [], author: { username: 'ada' }, diff_refs: { base_sha: 'b1', start_sha: 's1', head_sha: 'h1' } }]
    if (p === `${mr}/notes`) return [200, m === 'GET' ? [] : { id: 1 }]
    if (m === 'GET' && p === `${mr}/discussions`) return [200, discussions]
    if (m === 'POST' && p === `${mr}/discussions`) { const x = { id: `d${++n}`, notes: [{ id: n, body: b.body, resolved: false, position: b.position, author: BOT }] }; discussions.push(x); return [201, x] }
    const note = /discussions\/(d\d+)\/notes\/(\d+)$/.exec(p)
    if (m === 'PUT' && note) { const x = discussions.find((y) => y.id === note[1]); x.notes[0].body = b.body; return [200, x.notes[0]] }
    const res = /discussions\/(d\d+)$/.exec(p)
    if (m === 'PUT' && res) { const x = discussions.find((y) => y.id === res[1]); x.notes[0].resolved = b.resolved; return [200, x] }
  })
  const env = () => ({ ...gitlabEnv(d, api.url), GITLAB_TOKEN: 'tok', CI_PROJECT_URL: 'https://gl/grp/shop' })
  try {
    // q2 explained: its "Worth discussing" is the old thread, updated in place (its marker kept), never a second one.
    const c = U.readCheck(path.join(d, 'understanding/feat-x.json'))
    c.questions[1].attempts = []
    const a = U.addAttempt(c, c.questions[1], 'no idea'); Object.assign(a, { verdict: 'explained', feedback: 'Each step waits.', topic: 'steps one by one', note: 'Each step waits.' }); a.hash = U.attemptHash(c.questions[1], a)
    U.writeCheck(path.join(d, 'understanding/feat-x.json'), c); commitAll(d, 'explained')
    const r = await ci(d, env())
    assert.equal(r.code, 0, r.lines.join('\n'))
    const added = Number(fs.readFileSync(path.join(d, 'src/app.js'), 'utf8').split('\n').findIndex((l) => l === '  return 0')) // 0-based index = the last added line's number
    const posted = discussions.find((x) => x.notes[0].body.includes('understanding-concern:q1'))
    assert.equal(posted.notes[0].position.new_line, added, r.lines.join('\n'))
    assert.match(posted.notes[0].body, /main returns 0 even after a failed step\. · \[`src\/app\.js:72`\]/)
    assert.equal(discussions.filter((x) => /understanding-concern:(discuss-)?q2/.test(x.notes[0].body)).length, 1)
    assert.match(discussions[0].notes[0].body, /^<!-- understanding-concern:discuss-q2 -->\n💬 \*\*Worth discussing\*\* \(understanding check\): steps one by one/)
  } finally { api.close() }
})
