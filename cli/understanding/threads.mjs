// Review items (flagged concerns, "may be a bug", "Worth discussing") as threads on the merge request's diff.
import { git } from './git.mjs'
import { nearestChanged } from './diff.mjs'
import { api, glMr } from './platform.mjs'
import { changedText, concernLink, inline, isConcernItem, reviewItems } from './mrComment.mjs'

const concernMarker = (id) => `<!-- understanding-concern:${id} -->`
const closedMarker = (id) => `<!-- understanding-concern-closed:${id} -->`
const concernIdOf = (body) => /<!-- understanding-concern:([\w-]+) -->/.exec(String(body ?? ''))?.[1]
const closedIdOf = (body) => /<!-- understanding-concern-closed:([\w-]+) -->/.exec(String(body ?? ''))?.[1]

/**
 * Where a flagged concern goes: the code the concern names (its grade's link, found again by its line's text when it
 * moved: `lines(file)` gives the file at the commit), else the last line of its question's range, else the first code
 * link of the attempt that raised it (or of the question). `{ file, line }`, or undefined (then a plain note).
 */
export function concernPlace(q, lines) {
  const own = concernLink(q)
  if (own) {
    const ls = lines?.(own.file)
    let line = own.start
    if (ls && typeof own.text === 'string' && ls[line - 1] !== own.text) {
      const hits = ls.map((t, i) => (t === own.text ? i + 1 : 0)).filter(Boolean)
      if (hits.length) line = hits.reduce((a, b) => (Math.abs(b - own.start) < Math.abs(a - own.start) ? b : a))
    }
    return { file: own.file, line }
  }
  if (q.target !== 'file' && Number.isInteger(q.end)) return { file: q.file, line: q.end }
  const as = [...(q.attempts ?? [])].reverse()
  const l = (as.find((x) => x.concern && x.links?.length) ?? as.find((x) => x.links?.length))?.links?.[0] ?? q.links?.[0]
  return l && typeof l.file === 'string' && Number.isInteger(l.start) ? { file: l.file, line: l.start } : undefined
}



/**
 * A thread's text: short, mentions inert, the marker hidden. A concern: who flagged it (or "May be a bug"), the
 * concern, and the question's "Worth discussing" line when it has one; else "Worth discussing" with the correct point
 * (and the grader's concern on it, if any). `where`: a link to the line the concern names, when the thread is not on it.
 * `changed`: the commit that changed the concern's line since (see concernChangedIn).
 */
export function threadBody(check, it, where, { changed } = {}) {
  const tail = where ? ` · ${where}` : ''
  const out = [concernMarker(it.id)]
  if (isConcernItem(it)) {
    const who = it.q.concern?.by ?? check.answeredBy
    const name = who?.name || who?.email
    out.push(it.flagged ? `⚠ **Found during the understanding check**${name ? ` (flagged by ${inline(name)})` : ''}` : '⚠ **May be a bug** (understanding check)', `${inline(it.concern)}${tail}`)
    if (it.d) out.push('', `💬 Worth discussing: ${inline(it.d.topic)}${it.d.point ? ` · ${it.d.point}` : ''}`)
    if (changed !== undefined) out.push('', `_${changedText(changed).replace(/^l/, 'L')}_ In VS Code: Mark fixed.`)
  } else {
    out.push(`💬 **Worth discussing** (understanding check): ${inline(it.d.topic)}`, `${it.d.point || ''}${where ? `${it.d.point ? ' · ' : ''}${where}` : ''}`)
    if (it.concern) out.push('', `⚠ ${inline(it.concern)}`)
  }
  return out.join('\n')
}
/** A flagged concern's thread text (threadBody for one question). */
export const concernBody = (check, q, where, o = {}) => threadBody(check, { id: q.id, q, concern: q.concern.text, flagged: true }, where, o.changed ? { changed: typeof o.changed === 'string' ? o.changed : '' } : {})

/**
 * Puts each review item (reviewItems: flagged concerns, "may be a bug", "Worth discussing"; one per question) on the
 * code as a resolvable thread: a GitLab discussion with a diff position (the merge request's diff_refs), a GitHub
 * review comment (side RIGHT), on the line it is about or the nearest changed line of its hunk (`diff`). A line the
 * diff doesn't have falls back to a plain merge request note with a file:line link. Each thread is found again by a
 * hidden marker with its question's id: never posted twice, its text updated when it changed.
 * The reviewer's decisions win: a thread a person resolved is never reopened, and one a person replied to is never
 * resolved. Only a concern that is no longer flagged (or whose question is gone) is closed by the bot: GitLab resolves
 * it, GitHub gets one "No longer flagged." reply (resolving a review thread needs GraphQL); flagged again, the bot
 * reopens only what it resolved itself. "Worth discussing" threads are left to the reviewer. Returns log lines; never throws.
 */
export async function syncConcerns(ctx, check, { head, link = () => undefined, urls = new Map(), repo, items = reviewItems(check), diff, changed = new Map() } = {}) {
  const lines = []
  // The file at the head commit, for a concern's line that moved since it was graded.
  const fileAt = (f) => { try { return repo && head ? git(repo, ['show', `${head}:${f}`]).split(/\r?\n/) : undefined } catch { return undefined } }
  const want = new Map(items.map((it) => [it.id, it]))
  // The line it is about: a concern's own line, else the question's first line; then the nearest line of the diff.
  const aboutOf = (it) => (isConcernItem(it) ? concernPlace(it.q, fileAt) : it.q.target === 'file' || !Number.isInteger(it.q.start) ? undefined : { file: it.q.file, line: it.q.start })
  const placeOf = (it) => {
    const p = aboutOf(it)
    if (!p || diff === undefined) return p
    const line = nearestChanged(diff, p.file, p.line)
    return line === undefined ? p : { ...p, line, ...(line !== p.line ? { moved: true } : {}) }
  }
  const whereAt = (p) => { if (!p) return undefined; const u = link({ file: p.file, start: p.line, end: p.line }); return u ? `[\`${p.file}:${p.line}\`](${u})` : `\`${p.file}:${p.line}\`` }
  // On a line of the diff: the text says where it is about only when that is another line.
  const bodyOf = (it, onLine) => threadBody(check, it, onLine ? (placeOf(it)?.moved ? whereAt(aboutOf(it)) : undefined) : whereAt(aboutOf(it)), isConcernItem(it) && changed.has(it.id) ? { changed: changed.get(it.id) } : {})
  const say = (s) => { lines.push(`  ${s}`); return true }
  const safe = async (what, fn) => { try { return await fn() } catch (e) { lines.push(`  (couldn't ${what}: ${String(e.message).slice(0, 160)})`); return undefined } }
  const what = (it) => (isConcernItem(it) ? 'Concern' : 'Worth discussing')
  // A thread of a question: its id, or the id an earlier version gave a "Worth discussing" thread.
  const idOf = (raw) => raw.replace(/^discuss-/, '')

  if (ctx.platform === 'gitlab') {
    const mr = glMr(ctx)
    const discussions = await safe('read the merge request threads', () => api(ctx, 'GET', `${mr}/discussions?per_page=100`))
    if (!Array.isArray(discussions)) return lines
    const mine = new Map()
    for (const d of discussions) {
      const n = d.notes?.[0], raw = concernIdOf(n?.body)
      if (!raw) continue
      const id = idOf(raw), had = mine.get(id)
      if (!had || (had.raw !== id && raw === id)) mine.set(id, { d, n, raw })
    }
    const sameUser = (a, b) => !!a && !!b && (a.id !== undefined && b.id !== undefined ? a.id === b.id : a.username === b.username)
    // A person replied in the thread: theirs now.
    const touched = (d, n) => (d.notes ?? []).slice(1).some((x) => !x.system && !sameUser(x.author, n.author))
    const noteUrl = (nid) => `${ctx.web}/-/merge_requests/${ctx.mr}#note_${nid}`
    let refs
    for (const [id, it] of want) {
      const had = mine.get(id)
      if (had) {
        urls.set(id, noteUrl(had.n.id))
        const body = bodyOf(it, !!had.n.position || had.n.type === 'DiffNote').replace(concernMarker(id), concernMarker(had.raw))
        if (had.n.body !== body && await safe('update a thread', () => api(ctx, 'PUT', `${mr}/discussions/${had.d.id}/notes/${had.n.id}`, { body }).then(() => true))) say(`${what(it)} updated (${id}).`)
        // Flagged again after the bot resolved it: reopened. Resolved by a person: left as it is.
        if (had.n.resolved && isConcernItem(it) && sameUser(had.n.resolved_by, had.n.author) && await safe('reopen a thread', () => api(ctx, 'PUT', `${mr}/discussions/${had.d.id}`, { resolved: false }).then(() => true))) say(`${what(it)} reopened (${id}).`)
        continue
      }
      const p = placeOf(it)
      if (p && refs === undefined) refs = await safe('read the diff refs', async () => (await api(ctx, 'GET', mr))?.diff_refs ?? null) ?? null
      const position = p && refs?.base_sha ? { position_type: 'text', base_sha: refs.base_sha, start_sha: refs.start_sha, head_sha: refs.head_sha, new_path: p.file, new_line: p.line } : undefined
      // A line outside the diff is rejected: then a plain note, quietly (no error in the log).
      let ok = false
      const posted = (d) => { const nid = d?.notes?.[0]?.id; if (nid !== undefined) urls.set(id, noteUrl(nid)); return true }
      if (position) { try { posted(await api(ctx, 'POST', `${mr}/discussions`, { body: bodyOf(it, true), position })); ok = true } catch { /* not in the diff */ } }
      if (ok) { say(`${what(it)} posted on ${p.file}:${p.line} (${id}).`); continue }
      if (await safe('post a thread', () => api(ctx, 'POST', `${mr}/discussions`, { body: bodyOf(it, false) }).then(posted))) say(`${what(it)} posted as a note (${id}).`)
    }
    for (const [id, { d, n, raw }] of mine) {
      // Only the bot's own concern threads that nobody replied to; "Worth discussing" is the reviewer's to resolve.
      if (want.has(id) || n.resolved || raw !== id || !/\n⚠/.test(n.body) || touched(d, n)) continue
      if (await safe('resolve a thread', () => api(ctx, 'PUT', `${mr}/discussions/${d.id}`, { resolved: true }).then(() => true))) say(`Concern resolved (${id}): no longer flagged.`)
    }
    return lines
  }

  if (ctx.platform !== 'github') return lines
  const repoUrl = `/repos/${ctx.project}`
  const pr = `${repoUrl}/pulls/${ctx.mr}`
  const review = await safe('read the review comments', () => api(ctx, 'GET', `${pr}/comments?per_page=100`))
  const notes = await safe('read the comments', () => api(ctx, 'GET', `${repoUrl}/issues/${ctx.mr}/comments?per_page=100`))
  if (!Array.isArray(review) || !Array.isArray(notes)) return lines
  const mine = new Map(), closed = new Map()
  const keep = (id, x) => { const had = mine.get(id); if (!had || (had.raw !== id && x.raw === id)) mine.set(id, x) }
  for (const c of review) { const raw = concernIdOf(c.body); if (raw && !c.in_reply_to_id) keep(idOf(raw), { c, review: true, raw }) }
  for (const c of notes) { const raw = concernIdOf(c.body); if (raw) keep(idOf(raw), { c, review: false, raw }) }
  for (const c of review) { const id = closedIdOf(c.body); if (id) closed.set(id, c) }
  for (const c of notes) { if (closedIdOf(c.body)) closed.set(closedIdOf(c.body), c) }
  // A person replied to the review thread: theirs now.
  const replied = (c) => review.some((x) => x.in_reply_to_id === c.id && !closedIdOf(x.body) && x.user?.login !== c.user?.login)
  for (const [id, it] of want) {
    const had = mine.get(id)
    const ghUrl = (c, rv) => `${ctx.web}/pull/${ctx.mr}#${rv ? `discussion_r${c.id}` : `issuecomment-${c.id}`}`
    if (had) {
      urls.set(id, ghUrl(had.c, had.review))
      const body = bodyOf(it, had.review).replace(concernMarker(id), concernMarker(had.raw))
      if (had.c.body !== body && await safe('update a thread', () => api(ctx, 'PATCH', `${repoUrl}/${had.review ? 'pulls' : 'issues'}/comments/${had.c.id}`, { body }).then(() => true))) say(`${what(it)} updated (${id}).`)
      // Flagged again: the "No longer flagged." reply goes.
      const gone = closed.get(id)
      if (gone && had.review && await safe('remove a reply', () => api(ctx, 'DELETE', `${repoUrl}/pulls/comments/${gone.id}`).then(() => true))) say(`Concern flagged again (${id}).`)
      continue
    }
    const p = placeOf(it)
    let ok = false
    if (p && head) { try { const c = await api(ctx, 'POST', `${pr}/comments`, { body: bodyOf(it, true), commit_id: head, path: p.file, line: p.line, side: 'RIGHT' }); if (c?.id !== undefined) urls.set(id, ghUrl(c, true)); ok = true } catch { /* not in the diff */ } }
    if (ok) { say(`${what(it)} posted on ${p.file}:${p.line} (${id}).`); continue }
    if (await safe('post a thread', () => api(ctx, 'POST', `${repoUrl}/issues/${ctx.mr}/comments`, { body: bodyOf(it, false) }).then((c) => { if (c?.id !== undefined) urls.set(id, ghUrl(c, false)); return true }))) say(`${what(it)} posted as a comment (${id}).`)
  }
  for (const [id, { c, review: rv, raw }] of mine) {
    if (want.has(id) || raw !== id || !/\n⚠/.test(c.body) || (rv && (closed.has(id) || replied(c))) || (!rv && closedIdOf(c.body))) continue
    const reply = `${closedMarker(id)}\nNo longer flagged.`
    const ok = rv ? await safe('reply to a concern', () => api(ctx, 'POST', `${pr}/comments/${c.id}/replies`, { body: reply }).then(() => true))
      : await safe('mark a concern', () => api(ctx, 'PATCH', `${repoUrl}/issues/comments/${c.id}`, { body: `${c.body}\n\n${reply}` }).then(() => true))
    if (ok) say(`Concern no longer flagged (${id}).`)
  }
  return lines
}
