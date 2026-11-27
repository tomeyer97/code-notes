// CI on GitLab or GitHub: where the job runs (ciContext, from the CI variables) and its forge (forgeOf: gitlab.ts,
// github.ts). The functions below are the CLI's API for the merge request; they ask the forge.
import fs from 'node:fs'
import type { CiContext, Forge, LinkCtx, Spot } from './forge'
import { github } from './github'
import { gitlab } from './gitlab'

/** Outside CI: no merge request, no API. It says GITLAB_TOKEN when a token is missing, as the job always has. */
const local: Forge = {
  tokenVar: 'GITLAB_TOKEN',
  rerun: gitlab.rerun,
  headers: () => ({}),
  diffLink: () => undefined,
  mrInfo: () => Promise.reject(new Error('no merge request outside CI')),
  approvers: () => Promise.reject(new Error('no merge request outside CI')),
  upsertComment: () => Promise.reject(new Error('no merge request outside CI')),
  threads: () => undefined,
}

/** The forge a context is on (`local`: none). */
export const forgeOf = (ctx: { platform?: string } | undefined): Forge => (ctx?.platform === 'gitlab' ? gitlab : ctx?.platform === 'github' ? github : local)

/** Where CI runs and what it is checking: platform, branch, base and head commits, the merge request. */
export function ciContext(env: NodeJS.ProcessEnv = process.env): CiContext {
  if (env.GITLAB_CI) return gitlabContext(env)
  if (env.GITHUB_ACTIONS) return githubContext(env)
  return { platform: 'local' }
}

/** GitLab's predefined variables (a merge request pipeline has the CI_MERGE_REQUEST_ ones). */
function gitlabContext(env: NodeJS.ProcessEnv): CiContext {
  const target = env.CI_MERGE_REQUEST_TARGET_BRANCH_NAME
  return {
    platform: 'gitlab',
    branch: env.CI_MERGE_REQUEST_SOURCE_BRANCH_NAME || env.CI_COMMIT_REF_NAME,
    head: env.CI_COMMIT_SHA,
    base: env.CI_MERGE_REQUEST_DIFF_BASE_SHA,
    baseRef: target && `origin/${target}`,
    mr: env.CI_MERGE_REQUEST_IID,
    labels: env.CI_MERGE_REQUEST_LABELS ? env.CI_MERGE_REQUEST_LABELS.split(',').map((x) => x.trim()).filter(Boolean) : [],
    api: env.CI_API_V4_URL,
    project: env.CI_PROJECT_ID,
    token: env.GITLAB_TOKEN,
    web: env.CI_MERGE_REQUEST_PROJECT_URL || env.CI_PROJECT_URL,
  }
}

/** GitHub Actions' variables and, for a pull request, its event payload (GITHUB_EVENT_PATH). */
function githubContext(env: NodeJS.ProcessEnv): CiContext {
  const pr = pullRequestOf(env.GITHUB_EVENT_PATH)
  const server = (env.GITHUB_SERVER_URL || 'https://github.com').replace(/\/$/, '')
  return {
    platform: 'github',
    branch: pr.head?.ref || env.GITHUB_HEAD_REF || env.GITHUB_REF_NAME,
    head: pr.head?.sha || env.GITHUB_SHA,
    base: pr.base?.sha,
    baseRef: env.GITHUB_BASE_REF && `origin/${env.GITHUB_BASE_REF}`,
    mr: pr.number ? String(pr.number) : undefined,
    labels: (pr.labels ?? []).map((l: any) => l.name),
    author: pr.user?.login,
    api: env.GITHUB_API_URL || 'https://api.github.com',
    project: env.GITHUB_REPOSITORY,
    token: env.GITHUB_TOKEN,
    web: env.GITHUB_REPOSITORY && `${server}/${env.GITHUB_REPOSITORY}`,
  }
}

/** The event's pull request, or {} when the job doesn't run for one (no event file, or another event). */
function pullRequestOf(eventPath: string | undefined): any {
  if (!eventPath || !fs.existsSync(eventPath)) return {}
  try {
    return JSON.parse(fs.readFileSync(eventPath, 'utf8')).pull_request ?? {}
  } catch (e) {
    console.error(`(couldn't read the GitHub event ${eventPath}: ${(e as Error).message})`)
    return {}
  }
}

/** The merge request's labels and author, fresh from the API when there is a token (a re-run job keeps its old variables). */
export async function mrInfo(ctx: CiContext): Promise<{ labels: string[]; author?: string }> {
  if (!ctx.token || !ctx.mr || !ctx.api) return { labels: ctx.labels ?? [], author: ctx.author }
  return forgeOf(ctx).mrInfo(ctx)
}

/**
 * Who approved, the author included (GitLab approvals; GitHub reviews whose latest state is APPROVED). Any approval
 * counts, also one given before the skip label was added.
 */
export const approvers = (ctx: CiContext): Promise<string[]> => forgeOf(ctx).approvers(ctx)

/** Writes the comment, or updates the one this tool wrote before (found by its marker). Returns 'created' | 'updated'. */
export const upsertComment = (ctx: CiContext, body: string): Promise<'created' | 'updated'> => forgeOf(ctx).upsertComment(ctx, body)

/** A link to a question's lines in the merge request's diff (GitLab, GitHub); the file at the head commit when it isn't in the diff. */
export function refLink(ctx: LinkCtx | undefined, q: Spot, diff?: string): string | undefined {
  if (!ctx?.web || !ctx.mr) return undefined
  return forgeOf(ctx).diffLink(ctx, q, diff)
}

export type { CiContext }
