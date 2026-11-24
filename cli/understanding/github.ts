// GitHub: the pull request API, its diff links, the job's comment and the review threads (review comments on the
// diff, issue comments off it; what is no longer flagged gets one "No longer flagged." reply, since resolving a
// review thread needs GraphQL, and the reply goes when it is flagged again).
import { createHash } from 'node:crypto'
import { request, type CiContext, type Forge, type OwnThread, type SyncLog, type ThreadOps } from './forge'
import { closedIdOf, closedMarker, concernIdOf, isOwnComment } from './markers'

/** A GitHub thread: its first comment, and whether it is a review comment (on the diff) or an issue comment. */
interface GithubThread extends OwnThread { c: any; review: boolean }

const headers = (token: string | undefined): Record<string, string> => ({
  authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'content-type': 'application/json', 'user-agent': 'understanding-check',
})
const api = (ctx: CiContext, method: string, url: string, body?: unknown): Promise<any> => request(ctx, headers(ctx.token), method, url, body)
/** A comment's link on the pull request page. */
const commentUrl = (ctx: CiContext, c: any, review: boolean): string => `${ctx.web}/pull/${ctx.mr}#${review ? `discussion_r${c.id}` : `issuecomment-${c.id}`}`

export const github: Forge = {
  tokenVar: 'GITHUB_TOKEN',
  // The recipe runs the job again on a review.
  rerun: '',
  headers,
  // GitHub's diff anchors: the file's sha256, then R<new line>.
  diffLink(ctx, q) {
    const whole = q.target === 'file' || !q.start
    const h = createHash('sha256').update(q.file, 'utf8').digest('hex')
    return `${ctx.web}/pull/${ctx.mr}/files#diff-${h}${whole ? '' : `R${q.start}${q.end! > q.start! ? `-R${q.end}` : ''}`}`
  },
  async mrInfo(ctx) {
    const p = await api(ctx, 'GET', `/repos/${ctx.project}/pulls/${ctx.mr}`)
    return { labels: (p.labels ?? []).map((l: any) => l.name), author: p.user?.login }
  },
  // Reviews whose latest state (comments aside) is APPROVED.
  async approvers(ctx) {
    const reviews = await api(ctx, 'GET', `/repos/${ctx.project}/pulls/${ctx.mr}/reviews?per_page=100`)
    const last = new Map<string, string>()
    for (const r of reviews ?? []) if (r.user?.login && r.state !== 'COMMENTED') last.set(r.user.login, r.state)
    return [...last].filter(([, s]) => s === 'APPROVED').map(([u]) => u)
  },
  async upsertComment(ctx, body) {
    const list = await api(ctx, 'GET', `/repos/${ctx.project}/issues/${ctx.mr}/comments?per_page=100`)
    const mine = (list ?? []).find((c: any) => isOwnComment(c.body))
    if (mine) { await api(ctx, 'PATCH', `/repos/${ctx.project}/issues/comments/${mine.id}`, { body }); return 'updated' }
    await api(ctx, 'POST', `/repos/${ctx.project}/issues/${ctx.mr}/comments`, { body })
    return 'created'
  },
  threads: (ctx, log, head) => githubThreads(ctx, log, head) as ThreadOps<OwnThread>,
}

/** GitHub's review threads: review comments (side RIGHT) at the head commit, else issue comments. */
function githubThreads(ctx: CiContext, { safe }: SyncLog, head: string | undefined): ThreadOps<GithubThread> {
  const repoUrl = `/repos/${ctx.project}`
  const pr = `${repoUrl}/pulls/${ctx.mr}`
  // Filled by list(): the review comments, and each question's "No longer flagged." marker (a reply or a comment).
  let review: any[] = []
  const closed = new Map<string, any>()
  const url = (c: any, rv: boolean): { url?: string } => (c?.id !== undefined ? { url: commentUrl(ctx, c, rv) } : {})
  // A person replied to the review thread: theirs now.
  const replied = (c: any): boolean => review.some((x) => x.in_reply_to_id === c.id && !closedIdOf(x.body) && x.user?.login !== c.user?.login)
  return {
    async list() {
      const rv = await safe('read the review comments', () => api(ctx, 'GET', `${pr}/comments?per_page=100`))
      const notes = await safe('read the comments', () => api(ctx, 'GET', `${repoUrl}/issues/${ctx.mr}/comments?per_page=100`))
      if (!Array.isArray(rv) || !Array.isArray(notes)) return undefined
      review = rv
      const out: GithubThread[] = []
      for (const c of rv) {
        const raw = concernIdOf(c.body)
        if (raw && !c.in_reply_to_id) out.push({ raw, body: c.body, onLine: true, url: commentUrl(ctx, c, true), c, review: true })
      }
      for (const c of notes) {
        const raw = concernIdOf(c.body)
        if (raw) out.push({ raw, body: c.body, onLine: false, url: commentUrl(ctx, c, false), c, review: false })
      }
      for (const c of [...rv, ...notes]) {
        const id = closedIdOf(c.body)
        if (id) closed.set(id, c)
      }
      return out
    },
    update: (t, body) => api(ctx, 'PATCH', `${repoUrl}/${t.review ? 'pulls' : 'issues'}/comments/${t.c.id}`, { body }),
    // Flagged again: the "No longer flagged." reply goes.
    again(t, id) {
      const gone = closed.get(id)
      if (!gone || !t.review) return undefined
      return { doing: 'remove a reply', run: () => api(ctx, 'DELETE', `${repoUrl}/pulls/comments/${gone.id}`), said: `Concern flagged again (${id}).` }
    },
    async postOnLine(body, p) {
      if (!head) return undefined
      // A line outside the diff is refused: then an issue comment, quietly (no error in the log).
      try {
        return url(await api(ctx, 'POST', `${pr}/comments`, { body, commit_id: head, path: p.file, line: p.line, side: 'RIGHT' }), true)
      } catch {
        return undefined
      }
    },
    postNote: async (body) => url(await api(ctx, 'POST', `${repoUrl}/issues/${ctx.mr}/comments`, { body }), false),
    noteWord: 'a comment',
    settled: (t, id) => (t.review ? closed.has(id) || replied(t.c) : !!closedIdOf(t.body)),
    close(t, id) {
      const reply = `${closedMarker(id)}\nNo longer flagged.`
      return t.review
        ? { doing: 'reply to a concern', run: () => api(ctx, 'POST', `${pr}/comments/${t.c.id}/replies`, { body: reply }), said: `Concern no longer flagged (${id}).` }
        : { doing: 'mark a concern', run: () => api(ctx, 'PATCH', `${repoUrl}/issues/comments/${t.c.id}`, { body: `${t.c.body}\n\n${reply}` }), said: `Concern no longer flagged (${id}).` }
    },
  }
}
