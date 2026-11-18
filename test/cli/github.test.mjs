// `understanding ci` on GitHub, against a fake API (a local HTTP server): labels and reviews, the pull request
// comment, concern review comments.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { gitIn, repo, run, writeQuestions, answerAll, commitAll, fakeApi, ci, fakeServer, concernRepo } from './helpers.mjs'

test('ci on GitHub: labels and reviews from the API, the comment on the pull request', async () => {
  const d = repo()
  const f = writeQuestions(d)
  answerAll(f, [{ text: 'a', verdict: 'pass' }, { text: 'b', verdict: 'pass' }])
  commitAll(d)
  const ev = path.join(d, '..', `event-${path.basename(d)}.json`)
  fs.writeFileSync(ev, JSON.stringify({ pull_request: { number: 5, head: { sha: gitIn(d, 'rev-parse', 'HEAD').trim(), ref: 'feat/x' }, base: { sha: gitIn(d, 'rev-parse', 'main').trim() }, user: { login: 'ada' }, labels: [] } }))
  let labels = []
  const comments = [{ id: 1, body: 'LGTM' }]
  const api = await fakeApi({
    'GET /repos/o/shop/pulls/5': () => ({ labels: labels.map((name) => ({ name })), user: { login: 'ada' } }),
    'GET /repos/o/shop/pulls/5/reviews': [{ user: { login: 'bo' }, state: 'APPROVED' }, { user: { login: 'bo' }, state: 'CHANGES_REQUESTED' }, { user: { login: 'ada' }, state: 'APPROVED' }],
    'GET /repos/o/shop/issues/5/comments': () => comments,
    'POST /repos/o/shop/issues/5/comments': (b) => { comments.push({ id: 2, body: b.body }); return {} },
    'PATCH /repos/o/shop/issues/comments/2': (b) => { comments[1].body = b.body; return {} },
  })
  try {
    const env = { GITHUB_ACTIONS: 'true', GITHUB_EVENT_PATH: ev, GITHUB_REPOSITORY: 'o/shop', GITHUB_API_URL: api.url, GITHUB_TOKEN: 't' }
    let r = await ci(d, env)
    assert.equal(r.code, 1, r.lines.join('\n')); assert.match(r.lines[0], /2 of 3 done/)
    assert.equal(comments.length, 2); assert.equal(comments[1].body, '<!-- understanding-check -->\n**Understanding check in progress:** 2 of 3 done (about 1 min left).')
    assert.equal(api.calls.find((c) => c.key.startsWith('POST')).headers.authorization, 'Bearer t')
    r = await ci(d, env)
    assert.equal(comments.length, 2, 'updated, not a second comment')
    labels = ['skip-understanding']
    r = await ci(d, env)
    assert.equal(r.code, 1, 'bo\'s latest review is not an approval; the author\'s own does not count')
    // GitHub re-runs the job on the review event: no "re-run" in the messages.
    assert.equal(r.lines[0], '✗ Approved only by ada (the author). Ask a reviewer to approve.')
    assert.equal(comments[1].body, "<!-- understanding-check -->\nYour own approval doesn't count: ask a reviewer to approve.")
  } finally { api.close() }
})

test('flagged concerns on GitHub: a review comment on the line (RIGHT), never twice, "No longer flagged" once, a comment when off the diff; API errors never fail the job', async () => {
  const { d, set } = concernRepo()
  const ev = path.join(d, '..', `event-${path.basename(d)}.json`)
  const writeEv = () => fs.writeFileSync(ev, JSON.stringify({ pull_request: { number: 5, head: { sha: gitIn(d, 'rev-parse', 'HEAD').trim(), ref: 'feat/x' }, base: { sha: gitIn(d, 'rev-parse', 'main').trim() }, user: { login: 'ada' }, labels: [] } }))
  const review = [], issue = []
  let n = 0, broken = false
  const api = await fakeServer((m, p, b) => {
    if (broken && p.endsWith('/pulls/5/comments')) return [500, { message: 'down' }]
    if (m === 'GET' && p === '/repos/o/shop/pulls/5') return [200, { labels: [], user: { login: 'ada' } }]
    if (m === 'GET' && p === '/repos/o/shop/issues/5/comments') return [200, issue]
    if (m === 'POST' && p === '/repos/o/shop/issues/5/comments') { const c = { id: ++n, body: b.body }; issue.push(c); return [201, c] }
    const ic = /issues\/comments\/(\d+)$/.exec(p)
    if (m === 'PATCH' && ic) { const c = issue.find((x) => x.id === Number(ic[1])); c.body = b.body; return [200, c] }
    if (m === 'GET' && p === '/repos/o/shop/pulls/5/comments') return [200, review]
    if (m === 'POST' && p === '/repos/o/shop/pulls/5/comments') {
      if (b.line > 500) return [422, { message: 'line must be part of the diff' }]
      const c = { id: ++n, body: b.body, path: b.path, line: b.line, side: b.side, commit_id: b.commit_id }; review.push(c); return [201, c]
    }
    const rep = /pulls\/5\/comments\/(\d+)\/replies$/.exec(p)
    if (m === 'POST' && rep) { const c = { id: ++n, body: b.body, in_reply_to_id: Number(rep[1]) }; review.push(c); return [201, c] }
    const rc = /pulls\/comments\/(\d+)$/.exec(p)
    if (m === 'PATCH' && rc) { const c = review.find((x) => x.id === Number(rc[1])); c.body = b.body; return [200, c] }
  })
  const env = { GITHUB_ACTIONS: 'true', GITHUB_EVENT_PATH: ev, GITHUB_REPOSITORY: 'o/shop', GITHUB_API_URL: api.url, GITHUB_TOKEN: 't' }
  try {
    writeEv()
    let r = await ci(d, env)
    assert.equal(r.code, 0, r.lines.join('\n'))
    assert.equal(review.length, 1)
    assert.deepEqual([review[0].path, review[0].line, review[0].side, review[0].commit_id], ['src/app.js', 6, 'RIGHT', gitIn(d, 'rev-parse', 'HEAD').trim()])
    assert.match(review[0].body, /^<!-- understanding-concern:q1 -->\n⚠ \*\*Found during the understanding check\*\* \(flagged by Bob\)\n/)
    r = await ci(d, env)
    assert.equal(review.length, 1, 'never twice')
    set({ text: 'load() errors are swallowed', flagged: false }); writeEv()
    r = await ci(d, env)
    assert.equal(review.length, 2); assert.equal(review[1].in_reply_to_id, review[0].id); assert.match(review[1].body, /No longer flagged\.$/)
    r = await ci(d, env)
    assert.equal(review.length, 2, 'the reply once')
    // Off the diff: an issue comment with a link.
    set(undefined, (c) => { c.questions[1].start = 900; c.questions[1].end = 901; c.questions[1].anchor = undefined; c.questions[1].concern = { text: 'Off the diff', flagged: true } }); writeEv()
    r = await ci(d, env)
    const note = issue.find((c) => c.body.includes('understanding-concern:q2'))
    assert.ok(note); assert.match(note.body, /Off the diff · \[`src\/app\.js:901`\]\(.*\/pull\/5\/files#diff-[0-9a-f]{64}R901\)/)
    assert.ok(r.lines.includes('  Concern posted as a comment (q2).'))
    // The API fails: the job's result doesn't change.
    broken = true
    r = await ci(d, env)
    assert.equal(r.code, 0, r.lines.join('\n')); assert.ok(r.lines.some((l) => /couldn't read the review comments/.test(l)))
  } finally { api.close() }
})
