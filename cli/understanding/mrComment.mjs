// The merge request comment: the result, what a reviewer can act on, the answers; text made safe to post.
import { createHash } from 'node:crypto'
import { DEFAULTS, DIR, MARKER, TOUR_LINE } from './constants.mjs'
import { git, gitOk, hasCommit } from './git.mjs'
import { oldLineOf } from './diff.mjs'
import { sameWho } from './checkFile.mjs'

const MARK = { pass: '✓', restated: '✓', explained: '·', retry: '↻', ungraded: '?', todo: '○' }
/**
 * Makes @mentions inert (`@carol`, `@all`, `@group/sub`, `@org/team`): a word joiner after the "@" keeps the text as it
 * reads but GitLab and GitHub no longer notify anyone, also when the comment is edited later. Emails stay as they are.
 * Numbered references too (`#12` issue, `!3` merge request, `~5` label, `%2` milestone, `$7` snippet, `&4` epic): quoted
 * text never turns into a link to something else.
 */
export const inert = (s) => String(s ?? '').replace(/(^|[^\w.@`])@(?=[\w-])/g, '$1@\u2060').replace(/(^|[^\w&\u2060])([#!~%$&])(?=\d)/g, '$1$2\u2060')
/**
 * Text written by a person or the grader, shown exactly as typed in a comment: HTML and markdown made literal (a
 * "---" under a line, "### ✅ waived", "</blockquote>", a table row, `:emoji:` or a link never render), line by line.
 */
export function literal(s) {
  return String(s ?? '').split('\n').map((l) => l
    .replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c])
    .replace(/[\\`*_[\]|~#:!]/g, '\\$&')
    .replace(/^(\s*)([-+=])/, '$1\\$2')
    .replace(/^(\s*\d+)([.)])/, '$1\\$2')).join('\n')
}
const quote = (s) => literal(inert(String(s).trim())).split('\n').map((l) => (l.trim() ? `> ${l}` : '>')).join('\n')
const loc = (q) => (q.target === 'file' ? q.file : `${q.file}:${q.start}-${q.end}`)



/** A link to a question's lines in the merge request's diff (GitLab, GitHub); the file at the head commit when it isn't in the diff. */
export function refLink(ctx, q, diff) {
  if (!ctx?.web || !ctx.mr) return undefined
  const file = q.target === 'file' || !q.start
  if (ctx.platform === 'github') {
    const h = createHash('sha256').update(q.file, 'utf8').digest('hex')
    return `${ctx.web}/pull/${ctx.mr}/files#diff-${h}${file ? '' : `R${q.start}${q.end > q.start ? `-R${q.end}` : ''}`}`
  }
  if (ctx.platform !== 'gitlab') return undefined
  const h = createHash('sha1').update(q.file, 'utf8').digest('hex')
  const old = oldLineOf(diff ?? '', q.file, q.start ?? 1)
  if (old === undefined) return ctx.head ? `${ctx.web}/-/blob/${ctx.head}/${q.file.split('/').map(encodeURIComponent).join('/')}${file ? '' : `#L${q.start}-${q.end}`}` : undefined
  return `${ctx.web}/-/merge_requests/${ctx.mr}/diffs#${h}${file ? '' : `_${old}_${q.start}`}`
}

/** Text from the grader or the author, safe on one markdown line. */
const inline = (s) => literal(inert(String(s ?? '').replace(/\s+/g, ' ').trim()))
/** A question's text for the comment: literal, its `names` as code spans (written by the question writer). */
export const questionText = (t) => String(t ?? '').replace(/\s+/g, ' ').trim().split('`').map((part, k) => (k % 2 ? (part ? `\`${part}\`` : '') : literal(inert(part)))).join('')
/** At most `n` words ("…" when cut). */
export function clipWords(s, n) {
  const w = inline(s).split(' ').filter(Boolean)
  return w.length > n ? `${w.slice(0, n).join(' ').replace(/[,;:.]$/, '')}…` : w.join(' ')
}
/** The grader's reasoning for the reviewer, at most 15 words: its `note`, else its feedback without the "Right.". */
export function reasonOf(a) {
  if (!a) return ''
  return clipWords(String(a.note || a.feedback || '').replace(/^\s*(right|correct|yes)[.!:,]\s*/i, ''), 15)
}
/** The one-line correct explanation of an explained question: the grader's `note`, else the first sentence of its explanation. */
export function explanationOf(a) {
  if (!a) return ''
  return clipWords(a.note || (/^.*?[.!?](?=\s|$)/.exec(inline(a.feedback))?.[0] ?? a.feedback), 30)
}

/**
 * The code a question's concern is about: the first link of the attempt that raised it whose phrase is in the concern's
 * own words (`{ phrase, file, start, end, text? }`), else undefined.
 */
export function concernLink(q) {
  const a = [...(q.attempts ?? [])].reverse().find((x) => x.concern && x.links?.length)
  const words = String(q.concern?.text ?? a?.concern ?? '')
  const l = a?.links?.find((x) => x && words.includes(x.phrase))
  return l && typeof l.file === 'string' && Number.isInteger(l.start) ? l : undefined
}

/** A question's concern while it stands: not dismissed, not marked fixed, with text. Else undefined. */
const liveConcern = (q) => (q.concern && !q.concern.dismissed && !q.concern.fixed && inline(q.concern.text) ? q.concern : undefined)

/** Concerns the author flagged for the reviewer (`questions[].concern` with `flagged: true`). */
export function flaggedConcerns(check) {
  return (check.questions ?? []).filter((q) => liveConcern(q)?.flagged).map((q) => ({ q, text: q.concern.text }))
}

/**
 * What a done check holds for the reviewer to talk about: explained questions and partial passes, each with its topic
 * and the correct point in one line (the author's wrong guesses are never posted).
 */
export function discussItems(check, sum) {
  const out = []
  check.questions.forEach((q, i) => {
    const s = sum.states[i], as = q.attempts ?? []
    if (s === 'explained' || s === 'restated') {
      const a = as.find((x) => x.verdict === 'explained')
      out.push({ id: `discuss-${q.id}`, q, a, topic: a?.topic || q.text, point: explanationOf(a) })
      return
    }
    const a = as.findLast((x) => x.verdict === 'pass')
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
export function reviewItems(check, sum, { qa = false } = {}) {
  const ds = new Map(qa && sum ? discussItems(check, sum).map((d) => [d.q.id, d]) : [])
  const out = []
  for (const q of check.questions ?? []) {
    const c = liveConcern(q), d = ds.get(q.id)
    const suspect = !!(qa && q.suspect && c)
    if (c && (c.flagged || suspect)) out.push({ id: q.id, q, concern: c.text, flagged: !!c.flagged, suspect, ...(d ? { d } : {}) })
    else if (d) out.push({ id: q.id, q, d, ...(c ? { concern: c.text } : {}) })
  }
  const rank = (it) => (it.suspect ? 0 : it.flagged ? 1 : 2)
  return out.map((it, i) => ({ it, i })).sort((x, y) => rank(x.it) - rank(y.it) || x.i - y.i).map((x) => x.it)
}
/** An item shown as a concern (⚠), not as "Worth discussing". */
const isConcernItem = (it) => !!(it.concern && (it.flagged || it.suspect))

/** Concerns the grader raised that nobody flagged, dismissed or fixed and no item shows: "Also noticed while grading". */
export function noticedConcerns(check, items = []) {
  const shown = new Set(items.map((it) => it.q.id))
  return (check.questions ?? []).filter((q) => liveConcern(q) && !q.concern.flagged && !shown.has(q.id))
}

/**
 * Whether a concern's code changed since it was graded: the line its grade linked is no longer in the file at the
 * commit (`lines(file)`): possibly fixed. Undefined when it can't tell.
 */
export function concernChanged(q, lines) {
  const own = concernLink(q)
  const ls = own && typeof own.text === 'string' ? lines?.(own.file) : undefined
  return ls ? !ls.includes(own.text) : undefined
}

/**
 * The commit that changed a concern's line since `from` (the questions' commit), short; '' when the line changed but
 * the commit can't be told; undefined when it didn't change.
 */
export function concernChangedIn(repo, q, from, head) {
  const fileAt = (f) => { try { return git(repo, ['show', `${head}:${f}`]).split(/\r?\n/) } catch { return undefined } }
  if (!concernChanged(q, fileAt)) return undefined
  const own = concernLink(q)
  const range = from && hasCommit(repo, from) ? `${from}..${head}` : head
  return gitOk(repo, ['log', '-1', '--format=%h', `-S${own.text}`, range, '--', own.file]) || gitOk(repo, ['log', '-1', '--format=%h', range, '--', own.file]) || ''
}
/** "lines changed in abc1234 · fixed?" */
const changedText = (sha) => `lines changed in ${sha || 'a later commit'} · fixed?`

/** At most `n` characters of an answer, cut at a word, then "… (full answer in the check file)". */
export function clipAnswer(s, n = 300) {
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
export function commentBody(check, sum, head, link = () => undefined, { qa = false, threads = new Map(), changed = new Map(), items = reviewItems(check, sum, { qa }) } = {}) {
  const ref = (q) => { const u = link(q); return u ? `[\`${loc(q)}\`](${u})` : `\`${loc(q)}\`` }
  const linkText = (t, n) => clipWords(t, n).replace(/\\?[[\]]/g, '')
  // Someone other than the check's author answered (a teammate): said, never blocking.
  const by = (a) => (a?.by && !sameWho(a.by, check.answeredBy) ? ` · answered by ${inline(a.by.name || a.by.email)}` : '')
  const fixed = (id) => (changed.has(id) ? ` · ${changedText(changed.get(id))}` : '')
  const out = [MARKER, head]
  const lines = items.map((it) => {
    const u = threads.get(it.id)
    if (isConcernItem(it)) {
      const lead = it.flagged ? '' : 'May be a bug: '
      return u ? `- ⚠ ${lead}[${linkText(it.concern, 14)}](${u})${fixed(it.id)}` : `- ⚠ ${lead}${inline(it.concern)} · ${ref(it.q)}${fixed(it.id)}`
    }
    const d = it.d
    return u ? `- 💬 [Worth discussing: ${linkText(d.topic, 10)}](${u})${by(d.a)}` : `- 💬 **Worth discussing: ${inline(d.topic)}** · ${ref(d.q)}${by(d.a)}${d.point ? ` · ${d.point}` : ''}`
  })
  if (lines.length) out.push('', ...lines)
  if (check.journey) out.push('', TOUR_LINE)
  if (!qa) return out.join('\n')
  const noticed = noticedConcerns(check, items)
  if (noticed.length) out.push('', '**Also noticed while grading**', ...noticed.map((q) => `- ${clipWords(q.concern.text, 25)} · ${ref(q)}${fixed(q.id)}`))
  const all = []
  check.questions.forEach((q, i) => {
    const s = sum.states[i], as = q.attempts ?? []
    const title = `**${questionText(q.text)}** · ${ref(q)}${q.suspect ? ' · may be a bug' : ''}`
    // Explained, then said back: the author's own words, marked. Explained only: the point is in "Worth discussing".
    if (s === 'restated') { const a = as.findLast((x) => x.verdict === 'restated'); all.push('', `${title}${by(a)} · restated after an explanation`, ...(a?.answer ? [quote(clipAnswer(a.answer))] : [])); return }
    if (s === 'explained') { all.push('', `${title} · explained`); return }
    const good = as.findLast((x) => x.verdict === 'pass')
    all.push('', `${title}${by(good)}`, ...(good?.answer ? [quote(clipAnswer(good.answer))] : []))
  })
  out.push('', '<details><summary>All answers</summary>', ...all, '', '</details>')
  return out.join('\n')
}

/** The merge request comment while there is no check yet: what it is and what to do, in two lines. */
export function missingBody(rel, cfg = DEFAULTS, rerun = ', then re-run the job', { quiet = false, size = 'about 5 min' } = {}) {
  return [MARKER, `**Understanding check: not done yet.** A few questions about your change (${size}): run **Code Notes: Check my understanding** in VS Code, then commit \`${rel}\` and push.`,
    ...(quiet ? [] : [`<sub>Or add the label \`${cfg.skipLabel}\` and get a reviewer's approval${rerun}.</sub>`])].join('\n')
}


/**
 * What this change does to the check's own settings (understanding/config.json at `base` vs `head`), as one sentence
 * for the merge request ("mode required → advisory"), or undefined.
 */
export function settingsChange(repo, base, head, { plain = false } = {}) {
  const at = (c) => { try { return JSON.parse(git(repo, ['show', `${c}:${DIR}/config.json`])) } catch { return undefined } }
  const a = { ...DEFAULTS, ...(at(base) ?? {}) }, b = { ...DEFAULTS, ...(at(head) ?? {}) }
  const v = (x) => (x !== null && typeof x === 'object' ? JSON.stringify(x) : String(x))
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => v(a[k]) !== v(b[k]))
  return keys.length ? `This merge request changes the understanding check's settings: ${keys.map((k) => (plain ? (x) => x : inline)(`${k} ${v(a[k])} → ${v(b[k])}`)).join(', ')}.` : undefined
}
/** The settings change as the comment's headline: it applies once merged; this merge request is judged by the target's. */
const settingsHeadline = (line) => `**⚠ ${line.replace(/\.$/, '')}** (from the merge on; this merge request follows the current settings)`

/** Why no check is needed: only exempt files changed, or no code lines (comments, blank lines). */
export function noCheckLine(change) {
  if (change.exemptOnly) {
    const f = change.exempt
    return `✓ No check needed: only exempt files changed (${f.slice(0, 3).join(', ')}${f.length > 3 ? `, +${f.length - 3} more` : ''}).`
  }
  return '✓ No check needed: no code lines changed (only comments or blank lines).'
}

export { changedText, inline, isConcernItem, liveConcern, MARK, settingsHeadline }
