// `understanding ci` on GitLab, against a fake API (helpers/forges.mjs): approvals and the skip label, the merge
// request comment, concern threads and "Worth discussing" threads.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { MARKER, reasonOf } from '../../cli/understanding.mjs'
import { commitAll, concernRepo, editCheck, gitIn, grow, repo, verdicts } from './helpers/repos.mjs'
import { afterMarker, answerAll, ci, EXIT, gitlabEnv, grade, writeQuestions } from './helpers/cli.mjs'
import { BOB, BOT, fakeGitlab } from './helpers/forges.mjs'
import { cliModule } from './helpers/source.mjs'

const { concernMarker } = await cliModule('markers')
const log = (r) => r.lines.join('\n')
const WEB = 'https://gl/grp/shop'
/** The pipeline's variables with the fake's API, a token and the project's web address (for links). */
const env = (d, api) => ({ ...gitlabEnv(d, api.url), GITLAB_TOKEN: 'tok', CI_PROJECT_URL: WEB })
/** The bot's merge request comment. */
const comment = (api) => api.notes[0].body

/** ci with the skip label on alice's merge request, approved by `approvals`, no check file: the result and the API. */
async function skipRequested(approvals) {
  const d = repo()
  const api = await fakeGitlab({ labels: ['skip-understanding'], author: 'alice', approvals })
  try {
    return { r: await ci(d, env(d, api)), api }
  } finally { api.close() }
}

test('skip label, no approval yet: fails, says an approval waives it; the token is sent', async () => {
  const { r, api } = await skipRequested([])
  assert.equal(r.code, EXIT.fail)
  const say = 'Skip requested: an approval from a reviewer waives the understanding check, then re-run this job.'
  assert.equal(r.lines[0], say)
  assert.equal(comment(api), `${MARKER}\n${say}`)
  assert.equal(api.calls[0].headers['private-token'], 'tok')
})

test('skip label, approved only by the author: fails, asks for a reviewer (no ✗ in the comment)', async () => {
  const { r, api } = await skipRequested(['alice'])
  assert.equal(r.code, EXIT.fail)
  assert.equal(r.lines[0], '✗ Approved only by alice (the author). Ask a reviewer to approve, then re-run this job.')
  assert.equal(comment(api), `${MARKER}\nYour own approval doesn't count: ask a reviewer to approve, then re-run this job.`)
})

test('skip label, approved by a reviewer (also one given before the label): waived', async () => {
  const { r, api } = await skipRequested(['alice', 'bob'])
  assert.equal(r.code, EXIT.pass)
  assert.equal(r.lines[0], '✓ Understanding check waived (approved by @bob)')
  assert.equal(api.notes.length, 1)
  assert.equal(comment(api), `${MARKER}\n✓ Understanding check waived (approved by @bob)`)
})

test('skip label, no approval, but the check passes: it passes, no skip message; one comment, updated in place', async () => {
  const d = repo()
  const api = await fakeGitlab({ labels: ['skip-understanding'], author: 'alice' })
  try {
    await ci(d, env(d, api))
    const f = writeQuestions(d)
    answerAll(f, verdicts('pass', 'pass', 'pass'))
    commitAll(d)
    const r = await ci(d, env(d, api))
    assert.equal(r.code, EXIT.pass, log(r))
    assert.match(r.lines[0], /^✓ Understanding check done/)
    assert.match(afterMarker(comment(api)), /^\*\*✓ Understanding check done\*\* · 3 questions/)
    assert.equal(api.notes.length, 1, 'one comment, updated in place')
  } finally { api.close() }
})

/**
 * repo() with its check graded for the merge request comment (no threads API: the comment links the code): q1 passed
 * (feedback with an extra fact), q2 missed once (feedback and a hint that must never show).
 */
function gradedRepo() {
  const d = repo()
  const f = writeQuestions(d)
  editCheck(d, f, (c) => {
    grade(c, c.questions[0], 'It is kept in\na file.', 'pass', { feedback: 'Right. Also the file is rewritten atomically, so a crash leaves the old one in place for readers.' })
    grade(c, c.questions[1], 'WRONG GUESS ONE', 'retry', { feedback: 'Not quite.', hint: 'Look at 12' })
  })
  return { d, f }
}

/** gradedRepo() done: q2 explained with a flagged concern, q3 suspect with a concern, q1's concern nobody flagged. */
function doneRepo() {
  const { d, f } = gradedRepo()
  editCheck(d, f, (c) => {
    grade(c, c.questions[1], 'WRONG GUESS TWO', 'explained', { feedback: 'Each step waits for the one before it, so a slow load delays the rest. See src/app.js:3.', topic: 'loading steps one by one' })
    grade(c, c.questions[2], 'It returns 0.', 'pass', { feedback: 'Right.', note: 'Returns 0 with no steps: the loop body never runs.' })
    c.questions[2].suspect = true
    c.questions[2].concern = { text: 'main reports success when nothing was loaded.', flagged: false }
    c.questions[1].concern = { text: 'load() errors are swallowed: a failed step\nlooks like a success.', flagged: true }
    c.questions[0].concern = { text: 'Not flagged: stays in the editor.', flagged: false }
  })
  return { d, f }
}

/** ci on `d` against a GitLab without the threads API: the result and the bot's comment. */
async function commentOf(d) {
  const api = await fakeGitlab({ author: 'alice', threads: false })
  try {
    const r = await ci(d, env(d, api))
    return { r, body: comment(api), api }
  } finally { api.close() }
}

test('the MR comment never grades in public: until done, one progress line', async () => {
  const { d } = gradedRepo()
  const { r, body } = await commentOf(d)
  assert.equal(r.code, EXIT.fail)
  assert.equal(body, `${MARKER}\n**Understanding check in progress:** 1 of 3 done (about 1 min left).`)
})

test('the MR comment when done: one line per problem ("may be a bug" first, then flagged concerns), then concerns nobody flagged', async () => {
  const { d } = doneRepo()
  const { r, body } = await commentOf(d)
  assert.equal(r.code, EXIT.pass, log(r))
  const lines = body.split('\n')
  assert.equal(lines[1], '**✓ Understanding check done** · 3 questions')
  assert.match(lines[3], /^- ⚠ May be a bug: main reports success when nothing was loaded\. · \[`src\/app\.js`\]/)
  assert.match(lines[4], /^- ⚠ load\(\) errors are swallowed\\: a failed step looks like a success\. · \[`src\/app\.js:10-12`\]\(https:\/\/gl\/grp\/shop\/-\/merge_requests\/7\/diffs#/)
  // q2's "Worth discussing" goes with its concern: one problem, one line.
  assert.equal(lines[5], '')
  assert.doesNotMatch(body, /Worth discussing/)
  assert.match(body, /\n\*\*Also noticed while grading\*\*\n- Not flagged\\: stays in the editor\. · \[`src\/app\.js:3-6`\]/)
  assert.equal(body.split('main reports success').length, 2, 'said once')
})

test('the MR comment when done: all answers collapsed, each once as typed, never the grader\'s words or a miss', async () => {
  const { d } = doneRepo()
  const { body } = await commentOf(d)
  assert.match(body, /\n<details><summary>All answers<\/summary>\n/)
  assert.match(body, /> It is kept in\n> a file\.\n/)
  assert.doesNotMatch(body, /<sub>|Returns 0 with no steps|rewritten atomically|Check: /)
  assert.match(body, /instead of all at once\?\*\* · [^\n]+ · explained\n/)
  assert.match(body, /no steps to load at all\?\*\* · \[`src\/app\.js`\]\([^)]+\) · may be a bug/)
  for (const w of ['WRONG GUESS', 'try again', 'retry', '✗', 'Not quite', 'Look at 12']) assert.ok(!body.includes(w), `the comment must not show "${w}"`)
  assert.ok(body.indexOf('load() errors') < body.indexOf('It is kept in'), 'the items come first')
})

test('the reasoning line of an answer: at most 15 words, the note over the feedback, no bare "Right."', () => {
  assert.ok(reasonOf({ feedback: 'Right. ' + 'word '.repeat(30) }).split(' ').length <= 15)
  assert.equal(reasonOf({ note: 'Right: tick() re-queues it.', feedback: 'Right.' }), 'tick() re-queues it.')
  assert.equal(reasonOf({ feedback: 'Right.' }), '')
})

test('the MR comment after drift: the first line says what is missing, the problems stay below', async () => {
  const { d } = doneRepo()
  grow(d, 45)
  const { r, body } = await commentOf(d)
  assert.equal(r.code, EXIT.fail)
  assert.match(afterMarker(body), /^\*\*Understanding check: needs a top-up\.\*\* The change grew by 45 code lines since the questions; 1–2 questions about the new part are missing\./)
  assert.match(body, /May be a bug/)
})

test('the MR comment for a damaged file: one line, what is wrong', async () => {
  const { d, f } = doneRepo()
  fs.writeFileSync(f, '{ "version": 1, ')
  commitAll(d)
  const { body, api } = await commentOf(d)
  assert.equal(body, `${MARKER}\n**Understanding check:** \`understanding/feat-x.json\` is not valid JSON. Run **Check my understanding** again.`)
  assert.equal(api.notes.length, 1)
})

test('no check yet: the MR comment says what and how in two lines, never a tilde (GitLab reads "~2" as a label)', async () => {
  const d = repo()
  const api = await fakeGitlab()
  try {
    const r = await ci(d, env(d, api))
    assert.equal(r.code, EXIT.fail)
    assert.match(r.lines.at(-1), /comment created/)
    assert.equal(comment(api).split('\n').length, 3)
    assert.match(afterMarker(comment(api)), /^\*\*Understanding check: not done yet\.\*\* A few questions about your change \(3 questions, about 2 min\)/)
    assert.doesNotMatch(comment(api), /~/)
    assert.match(comment(api), /and get a reviewer's approval, then re-run the job\./)
  } finally { api.close() }
})

test('a pass says the room left before a top-up; refs link to the diff; the same comment, now the result', async () => {
  const d = repo()
  const api = await fakeGitlab()
  try {
    await ci(d, env(d, api))
    const f = writeQuestions(d)
    answerAll(f, verdicts('pass', 'pass', 'pass'))
    commitAll(d)
    fs.appendFileSync(path.join(d, 'src/app.js'), 'export const one = 1\nexport const two = 2\n')
    commitAll(d, 'two more')
    const r = await ci(d, env(d, api))
    assert.equal(r.code, EXIT.pass, log(r))
    assert.match(r.lines[0], /done: 3 of 3 passed \(Answer all 3 · 2 must pass\)\. 2 code lines since the check \(top-up at 40\)\.$/)
    assert.equal(api.notes.length, 1, 'the same comment, now the result')
    assert.match(comment(api), /\[`src\/app\.js:3-6`\]\(https:\/\/gl\/grp\/shop\/-\/merge_requests\/7\/diffs#[0-9a-f]{40}_\d+_3\)/)
  } finally { api.close() }
})

test('flagged concerns on GitLab: a thread on the line, never twice, updated, resolved when un-flagged, a note when the line is not in the diff', async (t) => {
  const { d, set } = concernRepo()
  const api = await fakeGitlab()
  /** q1's concern as Bob flagged it, with `text`. */
  const flaggedByBob = (text) => ({ text, flagged: true, by: { name: 'Bob' } })
  /** The first concern thread's first note (the bot's). */
  const thread = () => api.discussions[0].notes[0]
  try {
    await t.test('flagged: a thread on its line, linked at the top of the bot comment, said once', async () => {
      const r = await ci(d, env(d, api))
      assert.equal(r.code, EXIT.pass, log(r))
      assert.ok(r.lines.includes('  Concern posted on src/app.js:6 (q1).'), log(r))
      assert.equal(api.discussions.length, 1)
      assert.deepEqual(thread().position, { position_type: 'text', base_sha: 'b1', start_sha: 's1', head_sha: 'h1', new_path: 'src/app.js', new_line: 6 })
      assert.equal(thread().body, `${concernMarker('q1')}\n⚠ **Found during the understanding check** (flagged by Bob)\nload() errors are swallowed; tell @⁠carol`)
      assert.ok(r.comment.includes(`\n\n- ⚠ [load() errors are swallowed; tell @⁠carol](${WEB}/-/merge_requests/7#note_${thread().id})\n`), 'at the top of the bot comment, as a link to its thread')
      assert.equal(r.comment.split('load() errors').length, 2, 'said once in the comment')
    })
    await t.test('a re-run: nothing new', async () => {
      const r = await ci(d, env(d, api))
      assert.equal(api.discussions.length, 1)
      assert.ok(!r.lines.some((l) => /Concern/.test(l)), log(r))
    })
    await t.test('the text changed: updated in place', async () => {
      set(flaggedByBob('load() errors are swallowed'))
      const r = await ci(d, env(d, api))
      assert.equal(api.discussions.length, 1)
      assert.match(thread().body, /swallowed$/)
      assert.ok(r.lines.includes('  Concern updated (q1).'))
    })
    await t.test('un-flagged: resolved, once; flagged again: reopened', async () => {
      set({ text: 'load() errors are swallowed', flagged: false })
      let r = await ci(d, env(d, api))
      assert.equal(thread().resolved, true)
      assert.ok(r.lines.includes('  Concern resolved (q1): no longer flagged.'))
      r = await ci(d, env(d, api))
      assert.ok(!r.lines.some((l) => /Concern/.test(l)), 'resolved once')
      set(flaggedByBob('load() errors are swallowed'))
      r = await ci(d, env(d, api))
      assert.equal(thread().resolved, false)
      assert.ok(r.lines.includes('  Concern reopened (q1).'))
    })
    await t.test('the reviewer resolves it: never reopened by the bot', async () => {
      Object.assign(thread(), { resolved: true, resolved_by: BOB })
      const r = await ci(d, env(d, api))
      assert.equal(thread().resolved, true)
      assert.ok(!r.lines.some((l) => /reopened/.test(l)), log(r))
    })
    await t.test('the reviewer replied, then the author un-flags it: the thread is theirs, never resolved by the bot', async () => {
      Object.assign(thread(), { resolved: false, resolved_by: null })
      api.discussions[0].notes.push({ id: 77, body: 'Agreed, fix it.', author: BOB })
      set({ text: 'load() errors are swallowed', flagged: false })
      const r = await ci(d, env(d, api))
      assert.equal(thread().resolved, false)
      assert.ok(!r.lines.some((l) => /resolved/.test(l)), log(r))
    })
    await t.test('the question gone: its thread resolved; a concern whose line is not in the diff: a plain note with a link', async () => {
      // Back to the bot's own thread, flagged.
      api.discussions[0].notes.pop()
      Object.assign(thread(), { resolved: true, resolved_by: BOT })
      set(flaggedByBob('load() errors are swallowed'))
      await ci(d, env(d, api))
      set({ text: 'Off the diff', flagged: true }, (c) => {
        c.questions[0].concern = undefined
        Object.assign(c.questions[1], { start: 900, end: 901, anchor: undefined, concern: { text: 'Off the diff', flagged: true } })
      })
      const r = await ci(d, env(d, api))
      assert.equal(r.code, EXIT.pass, log(r))
      assert.equal(thread().resolved, true)
      assert.equal(api.discussions.length, 2)
      const note = api.discussions[1].notes[0]
      assert.equal(note.position, undefined)
      assert.ok(note.body.startsWith(`${concernMarker('q2')}\n⚠ **Found during the understanding check** (flagged by Ada)\n`), note.body)
      assert.match(note.body, /\nOff the diff · \[`src\/app\.js:901`\]\(https:\/\/gl\/grp\/shop\/-\/merge_requests\/7\/diffs#[0-9a-f]{40}_\d+_901\)$/)
      assert.ok(r.lines.includes('  Concern posted as a note (q2).'))
    })
  } finally { api.close() }
})

/** repo() with q1 passed and its concern flagged (linked to load(3)), q2 explained ("Worth discussing"), q3 passed. */
function discussRepo() {
  const d = repo()
  const f = writeQuestions(d)
  editCheck(d, f, (c) => {
    grade(c, c.questions[0], 'a', 'pass', { concern: 'load() errors are swallowed.', links: [{ phrase: 'load() errors', file: 'src/app.js', start: 5, end: 5, text: '  const v3 = load(3) // step 3' }] })
    c.questions[0].concern = { text: 'load() errors are swallowed.', flagged: true }
    grade(c, c.questions[1], 'no idea', 'explained', { feedback: 'Each step waits for the one before.', topic: 'steps one by one', note: 'Each step waits for the one before.' })
    grade(c, c.questions[2], 'It returns 0.', 'pass')
  })
  return { d, f }
}

test('GitLab: "Worth discussing" items are resolvable threads too, never resolved by the bot; a concern whose code changed says where', async (t) => {
  const { d, f } = discussRepo()
  const api = await fakeGitlab()
  /** The "Worth discussing" thread of q2. */
  const discuss = () => api.discussions.find((x) => x.notes[0].body.includes(concernMarker('q2')))
  try {
    await t.test('a thread per item; the top comment links each (concern first), answers collapsed', async () => {
      const r = await ci(d, env(d, api))
      assert.equal(r.code, EXIT.pass, log(r))
      assert.ok(discuss(), log(r))
      assert.equal(discuss().notes[0].position.new_line, 10)
      assert.match(discuss().notes[0].body, /💬 \*\*Worth discussing\*\* \(understanding check\): steps one by one\nEach step waits for the one before\./)
      const lines = comment(api).split('\n')
      assert.match(lines[3], /^- ⚠ \[load\(\) errors are swallowed\.\]\(https:\/\/gl\/grp\/shop\/-\/merge_requests\/7#note_\d+\)$/)
      assert.match(lines[4], /^- 💬 \[Worth discussing: steps one by one\]\(https:\/\/gl\/grp\/shop\/-\/merge_requests\/7#note_\d+\)$/)
    })
    await t.test('a re-run: never twice', async () => {
      await ci(d, env(d, api))
      assert.equal(api.discussions.length, 2)
    })
    await t.test('the concern\'s code changes (load(3) rewritten): the commit is named, in the comment and in its thread', async () => {
      fs.writeFileSync(path.join(d, 'src/app.js'), fs.readFileSync(path.join(d, 'src/app.js'), 'utf8').replace('load(3) // step 3', 'safeLoad(3) // step 3'))
      commitAll(d, 'fix')
      const short = gitIn(d, 'rev-parse', '--short', 'HEAD').trim()
      await ci(d, env(d, api))
      const first = api.discussions[0].notes[0]
      assert.ok(comment(api).split('\n').includes(`- ⚠ [load() errors are swallowed.](${WEB}/-/merge_requests/7#note_${first.id}) · lines changed in ${short} · fixed?`), comment(api))
      assert.ok(first.body.includes(`Lines changed in ${short} · fixed?`), first.body)
    })
    await t.test('the change grows past the top-up limit: the "Worth discussing" thread stays open (only a person resolves it)', async () => {
      grow(d, 45)
      const r = await ci(d, env(d, api))
      assert.equal(r.code, EXIT.fail)
      assert.equal(discuss().notes[0].resolved, false, log(r))
      assert.match(comment(api), /Worth discussing: steps one by one/)
      gitIn(d, 'reset', '-q', '--hard', 'HEAD~1')
    })
    await t.test('marked fixed in VS Code (flag off, fixed set): its thread is resolved and it leaves the comment', async () => {
      editCheck(d, f, (c) => { c.questions[0].concern = { ...c.questions[0].concern, flagged: false, fixed: { at: 'now' } } }, 'marked fixed')
      await ci(d, env(d, api))
      assert.equal(api.discussions[0].notes[0].resolved, true)
      assert.doesNotMatch(comment(api), /swallowed/)
    })
  } finally { api.close() }
})

test('GitLab: a thread whose line is outside the diff goes on the nearest changed line and names its own; an earlier "Worth discussing" thread is reused', async () => {
  const { d, f, set } = concernRepo()
  // The concern names `return 0` (line 72, unchanged, right after the last added line 71; its link says 73: found by its text).
  set({ text: 'main returns 0 even after a failed step.', flagged: true }, (c) => {
    const last = c.questions[0].attempts.at(-1)
    last.concern = 'main returns 0 even after a failed step.'
    last.links = [{ phrase: 'main returns 0', file: 'src/app.js', start: 73, end: 73, text: '  return 0' }]
  })
  // q2's "Worth discussing" thread from an earlier run (the marker an earlier version wrote: discuss-q2).
  const old = { id: 'd0', notes: [{ id: 50, body: `${concernMarker('discuss-q2')}\n💬 **Worth discussing** (understanding check): old`, resolved: false, position: { new_line: 10 }, author: BOT }] }
  const api = await fakeGitlab({ discussions: [old] })
  try {
    // q2 explained: its "Worth discussing" is the old thread, updated in place (its marker kept), never a second one.
    editCheck(d, f, (c) => {
      c.questions[1].attempts = []
      grade(c, c.questions[1], 'no idea', 'explained', { feedback: 'Each step waits.', topic: 'steps one by one', note: 'Each step waits.' })
    }, 'explained')
    const r = await ci(d, env(d, api))
    assert.equal(r.code, EXIT.pass, log(r))
    // The 0-based index of `return 0` is the 1-based number of the line before it: the last added line.
    const added = fs.readFileSync(path.join(d, 'src/app.js'), 'utf8').split('\n').findIndex((l) => l === '  return 0')
    const posted = api.discussions.find((x) => x.notes[0].body.includes(concernMarker('q1')))
    assert.equal(posted.notes[0].position.new_line, added, log(r))
    assert.match(posted.notes[0].body, /main returns 0 even after a failed step\. · \[`src\/app\.js:72`\]/)
    assert.equal(api.discussions.filter((x) => [concernMarker('q2'), concernMarker('discuss-q2')].some((m) => x.notes[0].body.includes(m))).length, 1)
    assert.ok(api.discussions[0].notes[0].body.startsWith(`${concernMarker('discuss-q2')}\n💬 **Worth discussing** (understanding check): steps one by one`), api.discussions[0].notes[0].body)
  } finally { api.close() }
})
