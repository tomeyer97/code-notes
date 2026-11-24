// `understanding ci` on GitHub, against a fake API (helpers/forges.mjs): labels and reviews, the pull request
// comment, concern review comments.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MARKER } from '../../cli/understanding.mjs'
import { checkedRepo, concernRepo, sha, verdicts } from './helpers/repos.mjs'
import { ci, EXIT, githubEnv } from './helpers/cli.mjs'
import { fakeGithub } from './helpers/forges.mjs'
import { cliModule } from './helpers/source.mjs'

const { concernMarker } = await cliModule('markers')
const log = (r) => r.lines.join('\n')
/** Bo approved, then asked for changes; Ada (the author) approved her own pull request. */
const REVIEWS = [{ by: 'bo', state: 'APPROVED' }, { by: 'bo', state: 'CHANGES_REQUESTED' }, { by: 'ada', state: 'APPROVED' }]

test('ci on GitHub: the comment on the pull request, with the token; updated in place, never a second one', async () => {
  const { d } = checkedRepo(verdicts('pass', 'pass'))
  const api = await fakeGithub({ reviews: REVIEWS, comments: [{ id: 1, body: 'LGTM' }] })
  try {
    const r = await ci(d, githubEnv(d, api.url))
    assert.equal(r.code, EXIT.fail, log(r))
    assert.match(r.lines[0], /2 of 3 done/)
    assert.equal(api.issue.length, 2)
    assert.equal(api.issue[1].body, `${MARKER}\n**Understanding check in progress:** 2 of 3 done (about 1 min left).`)
    assert.equal(api.calls.find((c) => c.method === 'POST').headers.authorization, 'Bearer t')
    await ci(d, githubEnv(d, api.url))
    assert.equal(api.issue.length, 2, 'updated, not a second comment')
  } finally { api.close() }
})

test('ci on GitHub: the skip label, with only the author\'s approval and a later "changes requested": not waived', async () => {
  const { d } = checkedRepo(verdicts('pass', 'pass'))
  const api = await fakeGithub({ labels: ['skip-understanding'], reviews: REVIEWS })
  try {
    const r = await ci(d, githubEnv(d, api.url))
    assert.equal(r.code, EXIT.fail, 'bo\'s latest review is not an approval; the author\'s own does not count')
    // GitHub re-runs the job on the review event: no "re-run" in the messages.
    assert.equal(r.lines[0], '✗ Approved only by ada (the author). Ask a reviewer to approve.')
    assert.equal(api.issue[0].body, `${MARKER}\nYour own approval doesn't count: ask a reviewer to approve.`)
  } finally { api.close() }
})

test('flagged concerns on GitHub: review comments on the line, replies, comments off the diff; API errors never fail the job', async (t) => {
  const { d, set } = concernRepo()
  const api = await fakeGithub()
  const env = () => githubEnv(d, api.url)
  try {
    await t.test('flagged: a review comment on its line (RIGHT side, the head commit)', async () => {
      const r = await ci(d, env())
      assert.equal(r.code, EXIT.pass, log(r))
      assert.equal(api.review.length, 1)
      const [c] = api.review
      assert.deepEqual([c.path, c.line, c.side, c.commit_id], ['src/app.js', 6, 'RIGHT', sha(d)])
      assert.ok(c.body.startsWith(`${concernMarker('q1')}\n⚠ **Found during the understanding check** (flagged by Bob)\n`), c.body)
    })
    await t.test('a re-run: never twice', async () => {
      await ci(d, env())
      assert.equal(api.review.length, 1)
    })
    await t.test('un-flagged: one reply, "No longer flagged.", once', async () => {
      set({ text: 'load() errors are swallowed', flagged: false })
      await ci(d, env())
      assert.equal(api.review.length, 2)
      assert.equal(api.review[1].in_reply_to_id, api.review[0].id)
      assert.match(api.review[1].body, /No longer flagged\.$/)
      await ci(d, env())
      assert.equal(api.review.length, 2, 'the reply once')
    })
    await t.test('a concern whose line is not in the diff: an issue comment with a link', async () => {
      set(undefined, (c) => {
        Object.assign(c.questions[1], { start: 900, end: 901, anchor: undefined, concern: { text: 'Off the diff', flagged: true } })
      })
      const r = await ci(d, env())
      const note = api.issue.find((c) => c.body.includes(concernMarker('q2')))
      assert.ok(note, log(r))
      assert.match(note.body, /Off the diff · \[`src\/app\.js:901`\]\(.*\/pull\/5\/files#diff-[0-9a-f]{64}R901\)/)
      assert.ok(r.lines.includes('  Concern posted as a comment (q2).'))
    })
    await t.test('the review comments API fails: the job\'s result doesn\'t change', async () => {
      api.broken = true
      const r = await ci(d, env())
      assert.equal(r.code, EXIT.pass, log(r))
      assert.ok(r.lines.some((l) => /couldn't read the review comments/.test(l)))
    })
  } finally { api.close() }
})
