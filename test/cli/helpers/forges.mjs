// Fake GitLab and GitHub APIs (local HTTP servers, helpers/servers.mjs) for `understanding ci`: the parts the job
// reads and writes, kept in memory so a test can look at what was posted. Side by side, they show which behaviours one
// forge has and the other lacks: GitLab has approvals and resolvable discussions; GitHub has reviews, review comments
// with replies, and issue comments.
import { fakeServer } from './servers.mjs'

/** GitLab users: the bot (the token's user) and a reviewer. */
export const BOT = { id: 1, username: 'understanding-ci' }
export const BOB = { id: 2, username: 'bob' }

/** The merge request's API path (IID 7 of grp/shop, as gitlabEnv sets it). */
export const MR = '/projects/grp%2Fshop/merge_requests/7'

/** The highest note id among `discussions` (new ones are numbered after it). */
const lastNoteId = (discussions) => Math.max(0, ...discussions.flatMap((d) => d.notes.map((n) => n.id)))

/**
 * GitLab's merge request API for MR 7 of grp/shop:
 * - `labels`, `author` (a username) and `approvals` (the usernames that approved);
 * - the merge request's notes (`notes`: the bot's comment is one of them);
 * - its discussions (`discussions`: threads, each `{ id, notes }`, the bot's note first), unless `threads` is false
 *   (then the discussions API answers 404); a position past line `diffLines` is not in the diff (400, as GitLab does).
 * Returns { url, close, calls, notes, discussions }.
 */
export async function fakeGitlab({ labels = [], author = 'ada', approvals = [], threads = true, discussions = [], diffLines = 500 } = {}) {
  const notes = []
  let n = lastNoteId(discussions)
  const discussion = (id) => discussions.find((x) => x.id === id)
  const api = await fakeServer((m, p, b) => {
    if (m === 'GET' && p === MR) return [200, { labels, author: { username: author }, diff_refs: { base_sha: 'b1', start_sha: 's1', head_sha: 'h1' } }]
    if (m === 'GET' && p === `${MR}/approvals`) return [200, { approved_by: approvals.map((username) => ({ user: { username } })) }]
    if (m === 'GET' && p === `${MR}/notes`) return [200, notes]
    if (m === 'POST' && p === `${MR}/notes`) {
      const note = { id: 900 + notes.length, body: b.body }
      notes.push(note)
      return [201, note]
    }
    const own = new RegExp(`^${MR}/notes/(\\d+)$`).exec(p)
    if (m === 'PUT' && own) {
      const note = notes.find((x) => x.id === Number(own[1]))
      note.body = b.body
      return [200, note]
    }
    if (!threads) return undefined
    if (m === 'GET' && p === `${MR}/discussions`) return [200, discussions]
    if (m === 'POST' && p === `${MR}/discussions`) {
      if (b.position && b.position.new_line > diffLines) return [400, { message: 'line_code can\'t be blank' }]
      const d = { id: `d${++n}`, notes: [{ id: n, body: b.body, resolved: false, position: b.position, author: BOT }] }
      discussions.push(d)
      return [201, d]
    }
    const reply = /discussions\/(d\d+)\/notes\/(\d+)$/.exec(p)
    if (m === 'PUT' && reply) {
      const first = discussion(reply[1]).notes[0]
      first.body = b.body
      return [200, first]
    }
    const resolve = /discussions\/(d\d+)$/.exec(p)
    if (m === 'PUT' && resolve) {
      const d = discussion(resolve[1])
      d.notes[0].resolved = b.resolved
      d.notes[0].resolved_by = b.resolved ? BOT : null
      return [200, d]
    }
  })
  return { ...api, notes, discussions }
}

/**
 * GitHub's API for pull request 5 of o/shop:
 * - `labels`, `author` (a login) and `reviews` ({ by, state } each, oldest first);
 * - the issue comments (`issue`: the bot's comment is one of them; `comments` are there before the job runs);
 * - the review comments on lines (`review`), with replies; a line past `diffLines` is not in the diff (422).
 * `api.broken = true` makes the review comments API fail (500). Returns { url, close, calls, issue, review, broken }.
 */
export async function fakeGithub({ labels = [], author = 'ada', reviews = [], comments = [], diffLines = 500 } = {}) {
  const issue = [...comments]
  const review = []
  let n = Math.max(0, ...issue.map((c) => c.id))
  const pr = '/repos/o/shop/pulls/5'
  const fake = { issue, review, broken: false }
  const api = await fakeServer((m, p, b) => {
    if (fake.broken && p === `${pr}/comments`) return [500, { message: 'down' }]
    if (m === 'GET' && p === pr) return [200, { labels: labels.map((name) => ({ name })), user: { login: author } }]
    if (m === 'GET' && p === `${pr}/reviews`) return [200, reviews.map((r) => ({ user: { login: r.by }, state: r.state }))]
    if (m === 'GET' && p === '/repos/o/shop/issues/5/comments') return [200, issue]
    if (m === 'POST' && p === '/repos/o/shop/issues/5/comments') {
      const c = { id: ++n, body: b.body }
      issue.push(c)
      return [201, c]
    }
    const ic = /^\/repos\/o\/shop\/issues\/comments\/(\d+)$/.exec(p)
    if (m === 'PATCH' && ic) {
      const c = issue.find((x) => x.id === Number(ic[1]))
      c.body = b.body
      return [200, c]
    }
    if (m === 'GET' && p === `${pr}/comments`) return [200, review]
    if (m === 'POST' && p === `${pr}/comments`) {
      if (b.line > diffLines) return [422, { message: 'line must be part of the diff' }]
      const c = { id: ++n, body: b.body, path: b.path, line: b.line, side: b.side, commit_id: b.commit_id }
      review.push(c)
      return [201, c]
    }
    const rep = new RegExp(`^${pr}/comments/(\\d+)/replies$`).exec(p)
    if (m === 'POST' && rep) {
      const c = { id: ++n, body: b.body, in_reply_to_id: Number(rep[1]) }
      review.push(c)
      return [201, c]
    }
    const rc = /^\/repos\/o\/shop\/pulls\/comments\/(\d+)$/.exec(p)
    if (m === 'PATCH' && rc) {
      const c = review.find((x) => x.id === Number(rc[1]))
      c.body = b.body
      return [200, c]
    }
  })
  return Object.assign(fake, api)
}
