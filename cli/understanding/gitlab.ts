// GitLab: the merge request API, its diff links, the job's comment and the review threads (discussions with a diff
// position; the bot resolves what is no longer flagged and reopens what it resolved itself).
import { createHash } from 'node:crypto'
import { oldLineOf } from './diff'
import { request, type CiContext, type Forge, type OwnThread, type SyncLog, type ThreadOps } from './forge'
import { concernIdOf, isOwnComment } from './markers'

/** A GitLab thread: the discussion and its first note. */
interface GitlabThread extends OwnThread { d: any; n: any }

const headers = (token: string | undefined): Record<string, string> => ({ 'PRIVATE-TOKEN': token!, 'content-type': 'application/json' })
const api = (ctx: CiContext, method: string, url: string, body?: unknown): Promise<any> => request(ctx, headers(ctx.token), method, url, body)
/** The merge request's API path. */
const mrPath = (ctx: CiContext): string => `/projects/${encodeURIComponent(ctx.project!)}/merge_requests/${ctx.mr}`
/** A note's link on the merge request page. */
const noteUrl = (ctx: CiContext, nid: unknown): string => `${ctx.web}/-/merge_requests/${ctx.mr}#note_${nid}`
/** The same GitLab user (by id when both have one, else by username). */
const sameUser = (a: any, b: any): boolean => !!a && !!b && (a.id !== undefined && b.id !== undefined ? a.id === b.id : a.username === b.username)

export const gitlab: Forge = {
  tokenVar: 'GITLAB_TOKEN',
  rerun: ', then re-run this job',
  headers,
  // GitLab's diff anchors: the file's sha1, then old_new line numbers; a line the diff doesn't show: the file at head.
  diffLink(ctx, q, diff) {
    const whole = q.target === 'file' || !q.start
    const old = oldLineOf(diff ?? '', q.file, q.start ?? 1)
    if (old === undefined) {
      return ctx.head ? `${ctx.web}/-/blob/${ctx.head}/${q.file.split('/').map(encodeURIComponent).join('/')}${whole ? '' : `#L${q.start}-${q.end}`}` : undefined
    }
    const h = createHash('sha1').update(q.file, 'utf8').digest('hex')
    return `${ctx.web}/-/merge_requests/${ctx.mr}/diffs#${h}${whole ? '' : `_${old}_${q.start}`}`
  },
  async mrInfo(ctx) {
    const m = await api(ctx, 'GET', mrPath(ctx))
    return { labels: m.labels ?? [], author: m.author?.username }
  },
  async approvers(ctx) {
    const a = await api(ctx, 'GET', `${mrPath(ctx)}/approvals`)
    return (a.approved_by ?? []).map((x: any) => x.user?.username).filter(Boolean)
  },
  async upsertComment(ctx, body) {
    const mr = mrPath(ctx)
    const notes = await api(ctx, 'GET', `${mr}/notes?per_page=100&sort=desc&order_by=updated_at`)
    const mine = (notes ?? []).find((n: any) => isOwnComment(n.body))
    if (mine) { await api(ctx, 'PUT', `${mr}/notes/${mine.id}`, { body }); return 'updated' }
    await api(ctx, 'POST', `${mr}/notes`, { body })
    return 'created'
  },
  threads: (ctx, log) => gitlabThreads(ctx, log) as ThreadOps<OwnThread>,
}

/** GitLab's review threads: discussions; on a line with the merge request's diff_refs as its position. */
function gitlabThreads(ctx: CiContext, { safe }: SyncLog): ThreadOps<GitlabThread> {
  const mr = mrPath(ctx)
  // The merge request's diff_refs, read once, on the first thread that goes on a line (null: unknown).
  let refs: any
  const diffRefs = async (): Promise<any> => {
    if (refs === undefined) refs = await safe('read the diff refs', async () => (await api(ctx, 'GET', mr))?.diff_refs ?? null) ?? null
    return refs
  }
  const url = (d: any): { url?: string } => {
    const nid = d?.notes?.[0]?.id
    return nid !== undefined ? { url: noteUrl(ctx, nid) } : {}
  }
  return {
    async list() {
      const discussions: any = await safe('read the merge request threads', () => api(ctx, 'GET', `${mr}/discussions?per_page=100`))
      if (!Array.isArray(discussions)) return undefined
      const out: GitlabThread[] = []
      for (const d of discussions) {
        const n = d.notes?.[0], raw = concernIdOf(n?.body)
        if (raw) out.push({ raw, body: n.body, onLine: !!n.position || n.type === 'DiffNote', url: noteUrl(ctx, n.id), d, n })
      }
      return out
    },
    update: (t, body) => api(ctx, 'PUT', `${mr}/discussions/${t.d.id}/notes/${t.n.id}`, { body }),
    // Flagged again after the bot resolved it: reopened. Resolved by a person: left as it is.
    again(t, id, isConcern, what) {
      const botResolved = t.n.resolved && sameUser(t.n.resolved_by, t.n.author)
      if (!botResolved || !isConcern) return undefined
      return { doing: 'reopen a thread', run: () => api(ctx, 'PUT', `${mr}/discussions/${t.d.id}`, { resolved: false }), said: `${what} reopened (${id}).` }
    },
    async postOnLine(body, p) {
      const r = await diffRefs()
      if (!r?.base_sha) return undefined
      const position = { position_type: 'text', base_sha: r.base_sha, start_sha: r.start_sha, head_sha: r.head_sha, new_path: p.file, new_line: p.line }
      // A line outside the diff is refused: then a plain note, quietly (no error in the log).
      try {
        return url(await api(ctx, 'POST', `${mr}/discussions`, { body, position }))
      } catch {
        return undefined
      }
    },
    postNote: async (body) => url(await api(ctx, 'POST', `${mr}/discussions`, { body })),
    noteWord: 'a note',
    // Resolved already, or a person replied in the thread: theirs now.
    settled: (t) => !!t.n.resolved || (t.d.notes ?? []).slice(1).some((x: any) => !x.system && !sameUser(x.author, t.n.author)),
    close: (t, id) => ({ doing: 'resolve a thread', run: () => api(ctx, 'PUT', `${mr}/discussions/${t.d.id}`, { resolved: true }), said: `Concern resolved (${id}): no longer flagged.` }),
  }
}
