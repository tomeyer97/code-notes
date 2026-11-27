// What the CI job needs from the forge (GitLab or GitHub), as one interface: gitlab.ts and github.ts implement it,
// platform.ts picks one (forgeOf). Nothing else in the CLI asks which platform it is on.
import type { Question } from './types'

/** Where CI runs and what it is checking (platform.ts ciContext); `local` outside CI. */
export interface CiContext {
  platform: 'gitlab' | 'github' | 'local'
  branch?: string
  head?: string
  base?: string
  baseRef?: string
  mr?: string
  labels?: string[]
  author?: string
  api?: string
  project?: string
  token?: string
  web?: string
}

/** The forge context a diff link needs (ci's ctx, with the head commit). */
export interface LinkCtx { platform?: string; web?: string; mr?: string | number; head?: string }
/** Where a link points: a question, or a line range of a file. */
export type Spot = Pick<Question, 'file' | 'start' | 'end' | 'target'>
/** A line of a file; `moved`: not the line it is about. */
export interface Place { file: string; line: number; moved?: boolean }

/** What syncThreads logs through: `say(line)`, `safe(what, fn)` (a failed API call said, undefined). */
export interface SyncLog { lines: string[]; say: (s: string) => boolean; safe: <T>(what: string, fn: () => Promise<T>) => Promise<T | undefined> }

/** One of the bot's review threads as a forge lists it: its marker's id (`raw`), its first comment's text, its link. */
export interface OwnThread {
  /** The id in its concern marker (an earlier version's `discuss-<id>` included). */
  raw: string
  body: string
  /** On a line of the diff (not a plain note or comment). */
  onLine: boolean
  url: string
}
/** An API call to make through SyncLog.safe: what it does (for the log on failure), the call, and what to log after. */
export interface ThreadStep { doing: string; run: () => Promise<unknown>; said: string }

/**
 * A forge's review threads (threads.ts syncThreads drives them): `list` the bot's threads (undefined: couldn't
 * read them), `update` one's text, `again` (flagged again: what to undo, if anything), `postOnLine` (a thread on a
 * line of the diff: its url, or undefined when the forge refused the line), `postNote` (a plain note, off the diff),
 * `settled` (the reviewer's now, or closed already), `close` (no longer flagged).
 */
export interface ThreadOps<T extends OwnThread> {
  list(): Promise<T[] | undefined>
  update(t: T, body: string): Promise<unknown>
  again(t: T, id: string, isConcern: boolean, what: string): ThreadStep | undefined
  postOnLine(body: string, p: Place): Promise<{ url?: string } | undefined>
  postNote(body: string): Promise<{ url?: string }>
  /** How the log says a note was posted: "a note" (GitLab), "a comment" (GitHub). */
  noteWord: string
  settled(t: T, id: string): boolean
  close(t: T, id: string): ThreadStep
}

/** A forge: its API, its links, its comment and threads, and the words that depend on it. */
export interface Forge {
  /** The variable that holds the job's API token (said when it is missing). */
  tokenVar: string
  /** What the author does after a reviewer approves: re-run the job (GitHub re-runs it on a review by itself). */
  rerun: string
  headers(token: string | undefined): Record<string, string>
  /** A link to a question's lines in the merge request's diff, or the file at the head commit; undefined: none. */
  diffLink(ctx: LinkCtx, q: Spot, diff: string | undefined): string | undefined
  mrInfo(ctx: CiContext): Promise<{ labels: string[]; author?: string }>
  approvers(ctx: CiContext): Promise<string[]>
  upsertComment(ctx: CiContext, body: string): Promise<'created' | 'updated'>
  /** The review threads, or undefined: none on this forge. */
  threads(ctx: CiContext, log: SyncLog, head: string | undefined): ThreadOps<OwnThread> | undefined
}

/** One API request: JSON in and out, a 30 s limit; an error names the call and the forge's answer. */
export async function request(ctx: Pick<CiContext, 'api'>, headers: Record<string, string>, method: string, url: string, body?: unknown): Promise<any> {
  const res = await fetch(`${ctx.api!.replace(/\/$/, '')}${url}`, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30_000) })
  const text = await res.text()
  if (!res.ok) throw new Error(`${method} ${url}: ${res.status} ${text.slice(0, 200)}`)
  return text ? JSON.parse(text) : undefined
}
