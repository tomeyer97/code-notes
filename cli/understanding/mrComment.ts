// The merge request comment: the result, what a reviewer can act on, the answers; text made safe to post.
// The other sentences of the CI job are in messages.ts; a phase's headline is in phases.ts.
import { DEFAULTS, DIR, STATE, TOUR_LINE } from './constants'
import { git, gitOk, hasCommit } from './git'
import { sameWho } from './checkFile'
import { stripCourtesy } from './grading'
import { MARKER } from './markers'
import { settingsSentence } from './messages'
import type { Spot } from './forge'
import type { Attempt, Check, Concern, Link, QState, Question, Summary } from './types'

/** A "Worth discussing" item (discussItems). */
interface Discuss { id: string; q: Question; a: Attempt | undefined; topic: string; point: string }
/** A review item (reviewItems): one per question. */
interface ReviewItem { id: string; q: Question; concern?: string; flagged?: boolean; suspect?: boolean; d?: Discuss }
/** Array.prototype.findLast (ES2023), not in the ES2022 lib. */
type FindLast = { findLast(f: (x: Attempt) => boolean): Attempt | undefined }

const MARK: Record<QState, string> = { pass: '✓', restated: '✓', explained: '·', retry: '↻', ungraded: '?', todo: '○' }

// Text from people and the grader is posted on every repository's merge requests: these keep it from pinging anyone,
// linking to anything or rendering as markup. test/cli/mrComment.test.mjs covers each case.
/** A mention: "@carol", "@all", "@group/sub" (not an email's "a@b", not inside code or a word). */
const MENTION = /(^|[^\w.@`])@(?=[\w-])/g
/** A numbered reference: "#12" issue, "!3" merge request, "~5" label, "%2" milestone, "$7" snippet, "&4" epic. */
const REFERENCE = /(^|[^\w&\u2060])([#!~%$&])(?=\d)/g
/** The word joiner (U+2060): invisible, it breaks the "@" or "#" from what follows. */
const JOINER = '\u2060'
/** HTML's own characters: "<b>", "</blockquote>", "&amp;". */
const HTML_CHAR = /[&<>]/g
const HTML_ENTITY: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;' }
/** Markdown's inline characters: "*bold*", "`code`", "[link](…)", "| table |", ":emoji:", "~~strike~~", "#", "!". */
const MARKDOWN_CHAR = /[\\`*_[\]|~#:!]/g
/** A line that starts a list, a rule or a heading underline: "- item", "+ item", "---", "===". */
const LINE_MARK = /^(\s*)([-+=])/
/** A line that starts a numbered list: "1. item", "2) item". */
const NUMBERED = /^(\s*\d+)([.)])/

/**
 * Makes @mentions and numbered references inert: a word joiner after the "@" or "#" keeps the text as it reads but
 * GitLab and GitHub no longer notify anyone or link it, also when the comment is edited later. Emails stay as they are.
 */
export const inert = (s: unknown): string => String(s ?? '').replace(MENTION, `$1@${JOINER}`).replace(REFERENCE, `$1$2${JOINER}`)
/**
 * Text written by a person or the grader, shown exactly as typed in a comment: HTML and markdown made literal (a
 * "---" under a line, "### ✅ waived", "</blockquote>", a table row, `:emoji:` or a link never render), line by line.
 */
export function literal(s: unknown): string {
  return String(s ?? '').split('\n').map((l) => l
    .replace(HTML_CHAR, (c) => HTML_ENTITY[c])
    .replace(MARKDOWN_CHAR, '\\$&')
    .replace(LINE_MARK, '$1\\$2')
    .replace(NUMBERED, '$1\\$2')).join('\n')
}
const quote = (s: unknown): string => literal(inert(String(s).trim())).split('\n').map((l) => (l.trim() ? `> ${l}` : '>')).join('\n')
const loc = (q: Spot): string => (q.target === 'file' ? q.file : `${q.file}:${q.start}-${q.end}`)

/** Text from the grader or the author, safe on one markdown line. */
const inline = (s: unknown): string => literal(inert(String(s ?? '').replace(/\s+/g, ' ').trim()))
/** A question's text for the comment: literal, its `names` as code spans (written by the question writer). */
export const questionText = (t: unknown): string => String(t ?? '').replace(/\s+/g, ' ').trim().split('`').map((part, k) => (k % 2 ? (part ? `\`${part}\`` : '') : literal(inert(part)))).join('')
/** At most `n` words ("…" when cut). */
export function clipWords(s: unknown, n: number): string {
  const w = inline(s).split(' ').filter(Boolean)
  return w.length > n ? `${w.slice(0, n).join(' ').replace(/[,;:.]$/, '')}…` : w.join(' ')
}
/** The grader's reasoning for the reviewer, at most 15 words: its `note`, else its feedback without the "Right.". */
export function reasonOf(a: Attempt | undefined): string {
  if (!a) return ''
  return clipWords(stripCourtesy(String(a.note || a.feedback || '')), 15)
}
/** The one-line correct explanation of an explained question: the grader's `note`, else the first sentence of its explanation. */
export function explanationOf(a: Attempt | undefined): string {
  if (!a) return ''
  return clipWords(a.note || (/^.*?[.!?](?=\s|$)/.exec(inline(a.feedback))?.[0] ?? a.feedback), 30)
}

/**
 * The code a question's concern is about: the first link of the attempt that raised it whose phrase is in the concern's
 * own words (`{ phrase, file, start, end, text? }`), else undefined.
 */
export function concernLink(q: Question): Link | undefined {
  const a = [...(q.attempts ?? [])].reverse().find((x) => x.concern && x.links?.length)
  const words = String(q.concern?.text ?? a?.concern ?? '')
  const l = a?.links?.find((x) => x && words.includes(x.phrase))
  return l && typeof l.file === 'string' && Number.isInteger(l.start) ? l : undefined
}

/** A question's concern while it stands: not dismissed, not marked fixed, with text. Else undefined. */
const liveConcern = (q: Question): Concern | undefined => (q.concern && !q.concern.dismissed && !q.concern.fixed && inline(q.concern.text) ? q.concern : undefined)

/** Concerns the author flagged for the reviewer (`questions[].concern` with `flagged: true`). */
export function flaggedConcerns(check: Check): { q: Question; text: string }[] {
  return (check.questions ?? []).filter((q) => liveConcern(q)?.flagged).map((q) => ({ q, text: q.concern!.text }))
}

/**
 * What a done check holds for the reviewer to talk about: explained questions and partial passes, each with its topic
 * and the correct point in one line (the author's wrong guesses are never posted).
 */
export function discussItems(check: Check, sum: Summary): Discuss[] {
  const out: Discuss[] = []
  check.questions.forEach((q, i) => {
    const s = sum.states[i], as = q.attempts ?? []
    if (s === STATE.explained || s === STATE.restated) {
      const a = as.find((x) => x.verdict === STATE.explained)
      out.push({ id: `discuss-${q.id}`, q, a, topic: a?.topic || q.text, point: explanationOf(a) })
      return
    }
    const a = (as as Attempt[] & FindLast).findLast((x) => x.verdict === STATE.pass)
    if (a?.partial) out.push({ id: `discuss-${q.id}`, q, a, topic: a.topic || q.text, point: explanationOf(a) || clipWords(String(a.feedback ?? '').replace(/^\s*mostly right[.!:,]?\s*/i, ''), 30) })
  })
  return out
}

/**
 * What the merge request puts in front of the reviewer: one item per question at most (one problem, one line, one
 * thread). A concern the author flagged; once done, a concern raised on a question asked as "may be a bug"
 * (`suspect`), and "Worth discussing" (explained questions, partial passes), which joins the question's concern when it
 * has one. Ranked: "may be a bug" first, then flagged concerns, then the rest, each in question order.
 * `{ id (the question's), q, concern?, flagged?, suspect?, d? }`.
 */
export function reviewItems(check: Check, sum?: Summary, { qa = false }: { qa?: boolean } = {}): ReviewItem[] {
  const ds = new Map(qa && sum ? discussItems(check, sum).map((d): [string, Discuss] => [d.q.id, d]) : [])
  const out: ReviewItem[] = []
  for (const q of check.questions ?? []) {
    const c = liveConcern(q), d = ds.get(q.id)
    const suspect = !!(qa && q.suspect && c)
    if (c && (c.flagged || suspect)) out.push({ id: q.id, q, concern: c.text, flagged: !!c.flagged, suspect, ...(d ? { d } : {}) })
    else if (d) out.push({ id: q.id, q, d, ...(c ? { concern: c.text } : {}) })
  }
  const rank = (it: ReviewItem): number => (it.suspect ? 0 : it.flagged ? 1 : 2)
  return out.map((it, i) => ({ it, i })).sort((x, y) => rank(x.it) - rank(y.it) || x.i - y.i).map((x) => x.it)
}
/** An item shown as a concern (⚠), not as "Worth discussing". */
const isConcernItem = (it: ReviewItem): boolean => !!(it.concern && (it.flagged || it.suspect))

/** Concerns the grader raised that nobody flagged, dismissed or fixed and no item shows: "Also noticed while grading". */
export function noticedConcerns(check: Check, items: ReviewItem[] = []): Question[] {
  const shown = new Set(items.map((it) => it.q.id))
  return (check.questions ?? []).filter((q) => liveConcern(q) && !q.concern!.flagged && !shown.has(q.id))
}

/**
 * Whether a concern's code changed since it was graded: the line its grade linked is no longer in the file at the
 * commit (`lines(file)`): possibly fixed. Undefined when it can't tell.
 */
export function concernChanged(q: Question, lines?: (file: string) => string[] | undefined): boolean | undefined {
  const own = concernLink(q)
  const ls = own && typeof own.text === 'string' ? lines?.(own.file) : undefined
  return ls ? !ls.includes(own!.text!) : undefined
}

/**
 * The commit that changed a concern's line since `from` (the questions' commit), short; '' when the line changed but
 * the commit can't be told; undefined when it didn't change.
 */
export function concernChangedIn(repo: string, q: Question, from: string | undefined, head: string): string | undefined {
  const fileAt = (f: string): string[] | undefined => { try { return git(repo, ['show', `${head}:${f}`]).split(/\r?\n/) } catch { return undefined } }
  if (!concernChanged(q, fileAt)) return undefined
  const own = concernLink(q)!
  const range = from && hasCommit(repo, from) ? `${from}..${head}` : head
  return gitOk(repo, ['log', '-1', '--format=%h', `-S${own.text}`, range, '--', own.file]) || gitOk(repo, ['log', '-1', '--format=%h', range, '--', own.file]) || ''
}
/** "lines changed in abc1234 · fixed?" */
const changedText = (sha: string | undefined): string => `lines changed in ${sha || 'a later commit'} · fixed?`

/** At most `n` characters of an answer, cut at a word, then "… (full answer in the check file)". */
export function clipAnswer(s: unknown, n = 300): string {
  const t = String(s ?? '').trim()
  if (t.length <= n + 40) return t
  const cut = t.slice(0, n).replace(/\s+\S*$/, '')
  return `${cut || t.slice(0, n)}… (full answer in the check file)`
}

/**
 * The merge request comment, short: `head` (the result, or what is missing), then one line per item a reviewer can act
 * on (reviewItems: "may be a bug", flagged concerns, "Worth discussing"), each a link to its diff thread (`threads`:
 * id → url) or, without one, the text and a file link; "lines changed in <sha> · fixed?" when a concern's line changed
 * since (`changed`: id → sha); once done, concerns no item shows ("Also noticed while grading"), the tour line, and
 * every answer once in a collapsed "All answers" (long ones cut). It never grades in public (`qa` only once done).
 */
export function commentBody(check: Check, sum: Summary, head: string, link: (q: Spot) => string | undefined = () => undefined, { qa = false, threads = new Map(), changed = new Map(), items = reviewItems(check, sum, { qa }) }: { qa?: boolean; threads?: Map<string, string>; changed?: Map<string, string>; items?: ReviewItem[] } = {}): string {
  const text: ItemText = { check, link, changed }
  const out = [MARKER, head]
  if (items.length) out.push('', ...items.map((it) => itemLine(it, threads.get(it.id), text)))
  if (check.journey) out.push('', TOUR_LINE)
  if (!qa) return out.join('\n')
  const noticed = noticedConcerns(check, items)
  if (noticed.length) out.push('', '**Also noticed while grading**', ...noticed.map((q) => `- ${clipWords(q.concern!.text, 25)} · ${refText(q, link)}${fixedText(q.id, changed)}`))
  out.push('', ...answersSection(check, sum, link))
  return out.join('\n')
}

/** What an item's line needs besides the item: the check, the link to lines, the concerns whose lines changed. */
interface ItemText { check: Check; link: (q: Spot) => string | undefined; changed: Map<string, string> }

/** A question's place as markdown: a link to its lines when there is one, else the place as code. */
function refText(q: Spot, link: (q: Spot) => string | undefined): string {
  const u = link(q)
  return u ? `[\`${loc(q)}\`](${u})` : `\`${loc(q)}\``
}
/** " · lines changed in abc1234 · fixed?" for a concern whose line changed, else ''. */
const fixedText = (id: string, changed: Map<string, string>): string => (changed.has(id) ? ` · ${changedText(changed.get(id))}` : '')
/** Someone other than the check's author answered (a teammate): said, never blocking. */
const byText = (a: Attempt | undefined, check: Check): string => (a?.by && !sameWho(a.by, check.answeredBy) ? ` · answered by ${inline(a.by.name || a.by.email)}` : '')
/** A link's text: clipped, without brackets that would end it. */
const linkText = (t: unknown, n: number): string => clipWords(t, n).replace(/\\?[[\]]/g, '')

/**
 * One review item's line: a concern (⚠, "May be a bug: " unless the author flagged it) or "Worth discussing" (💬).
 * With a thread (`url`), a short link to it; without, the text, a link to the lines and (discussing) the point.
 */
function itemLine(it: ReviewItem, url: string | undefined, { check, link, changed }: ItemText): string {
  if (isConcernItem(it)) {
    const lead = it.flagged ? '' : 'May be a bug: '
    const fixed = fixedText(it.id, changed)
    return url
      ? `- ⚠ ${lead}[${linkText(it.concern, 14)}](${url})${fixed}`
      : `- ⚠ ${lead}${inline(it.concern)} · ${refText(it.q, link)}${fixed}`
  }
  const d = it.d!
  const by = byText(d.a, check)
  if (url) return `- 💬 [Worth discussing: ${linkText(d.topic, 10)}](${url})${by}`
  const point = d.point ? ` · ${d.point}` : ''
  return `- 💬 **Worth discussing: ${inline(d.topic)}** · ${refText(d.q, link)}${by}${point}`
}

/**
 * "All answers", collapsed: each question once, with the answer that counts (a pass's, or a restatement's, marked);
 * an explained one only says so (its point is in "Worth discussing").
 */
function answersSection(check: Check, sum: Summary, link: (q: Spot) => string | undefined): string[] {
  const all: string[] = []
  const answer = (a: Attempt | undefined): string[] => (a?.answer ? [quote(clipAnswer(a.answer))] : [])
  check.questions.forEach((q, i) => {
    const s = sum.states[i], as = (q.attempts ?? []) as Attempt[] & FindLast
    const title = `**${questionText(q.text)}** · ${refText(q, link)}${q.suspect ? ' · may be a bug' : ''}`
    if (s === STATE.restated) {
      const a = as.findLast((x) => x.verdict === STATE.restated)
      all.push('', `${title}${byText(a, check)} · restated after an explanation`, ...answer(a))
    } else if (s === STATE.explained) {
      all.push('', `${title} · explained`)
    } else {
      const good = as.findLast((x) => x.verdict === STATE.pass)
      all.push('', `${title}${byText(good, check)}`, ...answer(good))
    }
  })
  return ['<details><summary>All answers</summary>', ...all, '', '</details>']
}

/**
 * What this change does to the check's own settings (understanding/config.json at `base` vs `head`), as one sentence
 * for the merge request ("mode required → advisory"), or undefined.
 */
export function settingsChange(repo: string, base: string | undefined, head: string | undefined, { plain = false }: { plain?: boolean } = {}): string | undefined {
  const at = (c: string | undefined): Record<string, unknown> | undefined => { try { return JSON.parse(git(repo, ['show', `${c}:${DIR}/config.json`])) } catch { return undefined } }
  const a: Record<string, unknown> = { ...DEFAULTS, ...(at(base) ?? {}) }, b: Record<string, unknown> = { ...DEFAULTS, ...(at(head) ?? {}) }
  const v = (x: unknown): string => (x !== null && typeof x === 'object' ? JSON.stringify(x) : String(x))
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => v(a[k]) !== v(b[k]))
  return keys.length ? settingsSentence(keys.map((k) => (plain ? (x: string) => x : inline)(`${k} ${v(a[k])} → ${v(b[k])}`))) : undefined
}

export { changedText, inline, isConcernItem, liveConcern, MARK }
