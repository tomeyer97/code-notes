// CI on GitLab or GitHub: where the job runs, and the platform's API (the merge request, approvals, the comment).
import fs from 'node:fs'
import { MARKER } from './constants.mjs'

/** Where CI runs and what it is checking: platform, branch, base and head commits, the merge request. */
export function ciContext(env = process.env) {
  if (env.GITLAB_CI) {
    return {
      platform: 'gitlab', branch: env.CI_MERGE_REQUEST_SOURCE_BRANCH_NAME || env.CI_COMMIT_REF_NAME, head: env.CI_COMMIT_SHA,
      base: env.CI_MERGE_REQUEST_DIFF_BASE_SHA, baseRef: env.CI_MERGE_REQUEST_TARGET_BRANCH_NAME && `origin/${env.CI_MERGE_REQUEST_TARGET_BRANCH_NAME}`,
      mr: env.CI_MERGE_REQUEST_IID, labels: env.CI_MERGE_REQUEST_LABELS ? env.CI_MERGE_REQUEST_LABELS.split(',').map((x) => x.trim()).filter(Boolean) : [],
      api: env.CI_API_V4_URL, project: env.CI_PROJECT_ID, token: env.GITLAB_TOKEN, web: env.CI_MERGE_REQUEST_PROJECT_URL || env.CI_PROJECT_URL,
    }
  }
  if (env.GITHUB_ACTIONS) {
    let ev = {}
    try { ev = JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, 'utf8')) } catch { /* not a pull request event */ }
    const pr = ev.pull_request ?? {}
    return {
      platform: 'github', branch: pr.head?.ref || env.GITHUB_HEAD_REF || env.GITHUB_REF_NAME, head: pr.head?.sha || env.GITHUB_SHA, base: pr.base?.sha,
      baseRef: env.GITHUB_BASE_REF && `origin/${env.GITHUB_BASE_REF}`, mr: pr.number ? String(pr.number) : undefined,
      labels: (pr.labels ?? []).map((l) => l.name), author: pr.user?.login, api: env.GITHUB_API_URL || 'https://api.github.com', project: env.GITHUB_REPOSITORY, token: env.GITHUB_TOKEN,
      web: env.GITHUB_REPOSITORY && `${(env.GITHUB_SERVER_URL || 'https://github.com').replace(/\/$/, '')}/${env.GITHUB_REPOSITORY}`,
    }
  }
  return { platform: 'local' }
}

async function api(ctx, method, url, body) {
  const headers = ctx.platform === 'gitlab'
    ? { 'PRIVATE-TOKEN': ctx.token, 'content-type': 'application/json' }
    : { authorization: `Bearer ${ctx.token}`, accept: 'application/vnd.github+json', 'content-type': 'application/json', 'user-agent': 'understanding-check' }
  const res = await fetch(`${ctx.api.replace(/\/$/, '')}${url}`, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30_000) })
  const text = await res.text()
  if (!res.ok) throw new Error(`${method} ${url}: ${res.status} ${text.slice(0, 200)}`)
  return text ? JSON.parse(text) : undefined
}
const glMr = (ctx) => `/projects/${encodeURIComponent(ctx.project)}/merge_requests/${ctx.mr}`

/** The merge request's labels and author, fresh from the API when there is a token (a re-run job keeps its old variables). */
export async function mrInfo(ctx) {
  if (!ctx.token || !ctx.mr || !ctx.api) return { labels: ctx.labels ?? [], author: ctx.author }
  if (ctx.platform === 'gitlab') { const m = await api(ctx, 'GET', glMr(ctx)); return { labels: m.labels ?? [], author: m.author?.username } }
  const p = await api(ctx, 'GET', `/repos/${ctx.project}/pulls/${ctx.mr}`)
  return { labels: (p.labels ?? []).map((l) => l.name), author: p.user?.login }
}

/**
 * Who approved, the author included (GitLab approvals; GitHub reviews whose latest state is APPROVED). Any approval
 * counts, also one given before the skip label was added.
 */
export async function approvers(ctx) {
  if (ctx.platform === 'gitlab') {
    const a = await api(ctx, 'GET', `${glMr(ctx)}/approvals`)
    return (a.approved_by ?? []).map((x) => x.user?.username).filter(Boolean)
  }
  const reviews = await api(ctx, 'GET', `/repos/${ctx.project}/pulls/${ctx.mr}/reviews?per_page=100`)
  const last = new Map()
  for (const r of reviews ?? []) if (r.user?.login && r.state !== 'COMMENTED') last.set(r.user.login, r.state)
  return [...last].filter(([, s]) => s === 'APPROVED').map(([u]) => u)
}

/** Writes the comment, or updates the one this tool wrote before (found by its marker). Returns 'created' | 'updated'. */
export async function upsertComment(ctx, body) {
  if (ctx.platform === 'gitlab') {
    const notes = await api(ctx, 'GET', `${glMr(ctx)}/notes?per_page=100&sort=desc&order_by=updated_at`)
    const mine = (notes ?? []).find((n) => typeof n.body === 'string' && n.body.includes(MARKER))
    if (mine) { await api(ctx, 'PUT', `${glMr(ctx)}/notes/${mine.id}`, { body }); return 'updated' }
    await api(ctx, 'POST', `${glMr(ctx)}/notes`, { body })
    return 'created'
  }
  const list = await api(ctx, 'GET', `/repos/${ctx.project}/issues/${ctx.mr}/comments?per_page=100`)
  const mine = (list ?? []).find((c) => typeof c.body === 'string' && c.body.includes(MARKER))
  if (mine) { await api(ctx, 'PATCH', `/repos/${ctx.project}/issues/comments/${mine.id}`, { body }); return 'updated' }
  await api(ctx, 'POST', `/repos/${ctx.project}/issues/${ctx.mr}/comments`, { body })
  return 'created'
}

export { api, glMr }
