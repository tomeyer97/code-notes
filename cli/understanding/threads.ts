// Review items (flagged concerns, "may be a bug", "Worth discussing") as threads on the merge request's diff.
import { git } from './git'
import { nearestChanged } from './diff'
import { forgeOf } from './platform'
import { changedText, concernLink, inline, isConcernItem, reviewItems } from './mrComment'
import { concernMarker, isConcernThread } from './markers'
import type { CiContext, OwnThread, Place, SyncLog, ThreadOps } from './forge'
import type { Check, Question } from './types'

/** A review item (mrComment's reviewItems). */
type ReviewItem = ReturnType<typeof reviewItems>[number]
/** The file's lines at a commit, or undefined. */
type LinesAt = (file: string) => string[] | undefined
/** A link to lines of a file (platform's refLink). */
type LinkOf = (q: { file: string; start?: number; end?: number }) => string | undefined
/**
 * An item's thread, worked out before any API call: where it goes (`place`: the line it is about, moved to the
 * nearest line of the diff), its text on that line (`onLine`) and off the diff (`offLine`: a plain note), `what` it
 * is in the log, and whether it shows as a concern.
 */
interface ThreadPlan { place: Place | undefined; onLine: string; offLine: string; what: string; concern: boolean }

/**
 * Where a flagged concern goes: the code the concern names (its grade's link, found again by its line's text when it
 * moved: `lines(file)` gives the file at the commit), else the last line of its question's range, else the first code
 * link of the attempt that raised it (or of the question). `{ file, line }`, or undefined (then a plain note).
 */
export function concernPlace(q: Question, lines?: LinesAt): Place | undefined {
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
  if (q.target !== 'file' && Number.isInteger(q.end)) return { file: q.file, line: q.end! }
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
export function threadBody(check: Check, it: ReviewItem, where: string | undefined, { changed }: { changed?: string } = {}): string {
  const tail = where ? ` · ${where}` : ''
  const out = [concernMarker(it.id)]
  if (isConcernItem(it)) {
    const who = it.q.concern?.by ?? check.answeredBy
    const name = who?.name || who?.email
    out.push(it.flagged ? `⚠ **Found during the understanding check**${name ? ` (flagged by ${inline(name)})` : ''}` : '⚠ **May be a bug** (understanding check)', `${inline(it.concern)}${tail}`)
    if (it.d) out.push('', `💬 Worth discussing: ${inline(it.d.topic)}${it.d.point ? ` · ${it.d.point}` : ''}`)
    if (changed !== undefined) out.push('', `_${changedText(changed).replace(/^l/, 'L')}_ In VS Code: Mark fixed.`)
  } else {
    out.push(`💬 **Worth discussing** (understanding check): ${inline(it.d!.topic)}`, `${it.d!.point || ''}${where ? `${it.d!.point ? ' · ' : ''}${where}` : ''}`)
    if (it.concern) out.push('', `⚠ ${inline(it.concern)}`)
  }
  return out.join('\n')
}
/** A flagged concern's thread text (threadBody for one question). */
export const concernBody = (check: Check, q: Question, where: string | undefined, o: { changed?: string | boolean } = {}): string => threadBody(check, { id: q.id, q, concern: q.concern!.text, flagged: true }, where, o.changed ? { changed: typeof o.changed === 'string' ? o.changed : '' } : {})

/** syncConcerns' options. */
interface SyncOptions {
  /** The head commit: threads go on its lines; concerns' files are read at it. */
  head?: string
  /** A link to lines of a file (platform's refLink). */
  link?: LinkOf
  /** Filled in: each item's thread link. */
  urls?: Map<string, string>
  repo?: string
  /** The items to put on the code (default: reviewItems(check)). */
  items?: ReviewItem[]
  /** The merge request's diff: a thread goes on its nearest changed line. */
  diff?: string
  /** Concerns whose line changed since (id → commit). */
  changed?: Map<string, string>
}

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
export async function syncConcerns(ctx: CiContext, check: Check, opts: SyncOptions = {}): Promise<string[]> {
  const { head, link = () => undefined, urls = new Map(), repo, items = reviewItems(check), diff, changed = new Map() } = opts
  const log = syncLog()
  const ops = forgeOf(ctx).threads(ctx, log, head)
  if (!ops) return log.lines
  const want = new Map(items.map((it): [string, ReviewItem] => [it.id, it]))
  const plans = threadPlans(check, items, { head, link, repo, diff, changed })
  await syncThreads(ops, want, plans, { urls, log })
  return log.lines
}

/** What syncConcerns says: `say(line)` (true, for chains of `&&`), `safe(what, fn)` (a failed API call said, undefined). */
function syncLog(): SyncLog {
  const lines: string[] = []
  return {
    lines,
    say: (s: string) => { lines.push(`  ${s}`); return true },
    safe: async <T>(what: string, fn: () => Promise<T>): Promise<T | undefined> => {
      try {
        return await fn()
      } catch (e) {
        lines.push(`  (couldn't ${what}: ${String((e as Error).message).slice(0, 160)})`)
        return undefined
      }
    },
  }
}

/**
 * Each item's thread (ThreadPlan), the same on both forges. Reads the files at `head` (git show) for a concern whose
 * line moved since it was graded; nothing after this reads git.
 */
type PlanInput = Required<Pick<SyncOptions, 'link' | 'changed'>> & Pick<SyncOptions, 'head' | 'repo' | 'diff'>

function threadPlans(check: Check, items: ReviewItem[], { head, link, repo, diff, changed }: PlanInput): Map<string, ThreadPlan> {
  const files = new Map<string, string[] | undefined>()
  const fileAt = (f: string): string[] | undefined => {
    if (!files.has(f)) files.set(f, linesAt(repo, head, f))
    return files.get(f)
  }
  const whereAt = (p: Place | undefined): string | undefined => {
    if (!p) return undefined
    const u = link({ file: p.file, start: p.line, end: p.line })
    return u ? `[\`${p.file}:${p.line}\`](${u})` : `\`${p.file}:${p.line}\``
  }
  const plans = new Map<string, ThreadPlan>()
  for (const it of items) {
    const concern = isConcernItem(it)
    const about = aboutPlace(it, concern, fileAt)
    const place = onDiff(about, diff)
    const opts = concern && changed.has(it.id) ? { changed: changed.get(it.id) } : {}
    plans.set(it.id, {
      place,
      // On a line of the diff the text says where it is about only when that is another line.
      onLine: threadBody(check, it, place?.moved ? whereAt(about) : undefined, opts),
      offLine: threadBody(check, it, whereAt(about), opts),
      what: concern ? 'Concern' : 'Worth discussing',
      concern,
    })
  }
  return plans
}

/** The line an item is about: a concern's own line, else the question's first line (none for a whole file). */
function aboutPlace(it: ReviewItem, concern: boolean, fileAt: LinesAt): Place | undefined {
  if (concern) return concernPlace(it.q, fileAt)
  if (it.q.target === 'file') return undefined
  if (!Number.isInteger(it.q.start)) return undefined
  return { file: it.q.file, line: it.q.start! }
}

/** Where its thread goes: the nearest line of the diff (`moved` when that is another line), else the line itself. */
function onDiff(about: Place | undefined, diff: string | undefined): Place | undefined {
  if (!about) return undefined
  if (diff === undefined) return about
  const near = nearestChanged(diff, about.file, about.line)
  if (near === undefined) return about
  if (near === about.line) return { ...about, line: near }
  return { ...about, line: near, moved: true }
}

/** A file's lines at a commit (git show), or undefined. */
function linesAt(repo: string | undefined, head: string | undefined, file: string): string[] | undefined {
  if (!repo || !head) return undefined
  try {
    return git(repo, ['show', `${head}:${file}`]).split(/\r?\n/)
  } catch {
    return undefined
  }
}

/** A thread of a question: its id, or the id an earlier version gave a "Worth discussing" thread. */
const idOf = (raw: string): string => raw.replace(/^discuss-/, '')
/** Keeps one thread per question in `mine`: the one with its own id rather than an earlier version's. */
function keepThread<X extends { raw: string }>(mine: Map<string, X>, id: string, x: X): void {
  const had = mine.get(id)
  if (!had || (had.raw !== id && x.raw === id)) mine.set(id, x)
}

/**
 * The threads brought in line with the items (`want`), on any forge (`ops`): each item's thread updated (and undone
 * when it was closed and is flagged again) or posted, on its line or as a plain note; then the bot's own concern
 * threads that are no longer wanted, and nobody took over, closed. `urls`: each item's thread link, filled in.
 */
async function syncThreads(
  ops: ThreadOps<OwnThread>,
  want: Map<string, ReviewItem>,
  plans: Map<string, ThreadPlan>,
  { urls, log }: { urls: Map<string, string>; log: SyncLog },
): Promise<void> {
  const { say, safe } = log
  const step = async (s: { doing: string; run: () => Promise<unknown>; said: string }): Promise<void> => {
    if (await safe(s.doing, () => s.run().then(() => true))) say(s.said)
  }
  const listed = await ops.list()
  if (!listed) return
  const mine = new Map<string, OwnThread>()
  for (const t of listed) keepThread(mine, idOf(t.raw), t)
  for (const id of want.keys()) {
    const plan = plans.get(id)!
    const had = mine.get(id)
    if (had) {
      urls.set(id, had.url)
      const body = (had.onLine ? plan.onLine : plan.offLine).replace(concernMarker(id), concernMarker(had.raw))
      if (had.body !== body) {
        await step({ doing: 'update a thread', run: () => ops.update(had, body), said: `${plan.what} updated (${id}).` })
      }
      const again = ops.again(had, id, plan.concern, plan.what)
      if (again) await step(again)
      continue
    }
    const p = plan.place
    const onLine = p ? await ops.postOnLine(plan.onLine, p) : undefined
    if (onLine) {
      if (onLine.url) urls.set(id, onLine.url)
      say(`${plan.what} posted on ${p!.file}:${p!.line} (${id}).`)
      continue
    }
    const note = await safe('post a thread', () => ops.postNote(plan.offLine))
    if (!note) continue
    if (note.url) urls.set(id, note.url)
    say(`${plan.what} posted as ${ops.noteWord} (${id}).`)
  }
  for (const [id, t] of mine) {
    // Only the bot's own concern threads; "Worth discussing" is the reviewer's to resolve.
    if (want.has(id) || t.raw !== id || !isConcernThread(t.body) || ops.settled(t, id)) continue
    await step(ops.close(t, id))
  }
}
