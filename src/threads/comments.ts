// What a note's thread shows: its messages (as markdown with links and suggestions), its status changes, and the
// rows the extension adds (the code changed, Claude answering or failed, the check's grading and concerns).

import * as vscode from 'vscode'
import * as os from 'os'
import { lineDiff } from '../anchor'
import { linkify } from '../answerLinks'
import { alsoAllow, BANNER_COMMANDS, byId, cmdLink, MESSAGE_COMMANDS, systemMarkdown, titledCmdLink, trustedMarkdown, understanding } from '../app'
import { askErrors, asking } from '../ask'
import type { ThreadStatus } from '../check/index'
import { codeLinkMarkup, linkPhrases, PH, PH_RE } from '../codeLinkText'
import { isAgent, mine, otherBranch } from '../identity'
import { escapeTags } from '../journeyModel'
import { seenCount, visitFrom } from '../seen'
import { journeyOfNote, stepLinkOf } from '../sidebar/journeyRows'
import { NoteEvent } from '../noteModel'
import { Note } from '../store'
import { plural, rangeLabel } from '../text'
import { qDone, seeAlsoLink } from '../tour/checkTour'
import { tour, walk } from '../tour/tour'
import { docUri, missing, openDoc, pastEnd } from '../notes/location'
import { syncThread } from './sync'
import { docLines } from '../wfs'

export function threadRange(n: Note): vscode.Range {
  return new vscode.Range(n.data.range.start - 1, 0, n.data.range.end - 1, 0)
}

const FENCE = /(```[\s\S]*?```)/g

const SUGGESTION = /^```suggestion[ \t]*\r?\n([\s\S]*?)\r?\n?```$/

/** The k-th ```suggestion block of a message. */
export function suggestionOf(body: string, k: number): string | undefined {
  return body.split(FENCE).map((seg) => SUGGESTION.exec(seg)?.[1]).filter((x): x is string => x !== undefined)[k]
}

/**
 * The line a question asked from a step ends with (askStep writes it): the step by its id, or (older notes) by its
 * number. Group 1 / group 2: the journey's title.
 */
// _About the step “Read the config” (id `s3`) of the journey “Start-up”_
const ABOUT_STEP_BY_ID = /_About the step “[^”]*” \(id [^)]*\) of the journey “([^”]*)”_\s*$/
// _About step 3 of the journey “Start-up”: Read the config_
const ABOUT_STEP_BY_NUMBER = /_About step (\d+) of the journey “([^”]*)”: ([^\n]*)_\s*$/
// Either one, with the blank lines before it.
const ABOUT_STEP_LINE = new RegExp(`\\n*(?:${ABOUT_STEP_BY_NUMBER.source}|${ABOUT_STEP_BY_ID.source})`)

/** A question's "_About the step …_" line as a link back to that step ("↩ Step 3 · <journey>"); none on that very step,
 *  where the card is right there. */
function withStepLink(n: Note, md: string): string {
  const sl = stepLinkOf(n)
  if (!sl) return md
  const lj = journeyOfNote(n)
  const walking = !!lj && walk.touring() && tour.key === lj.key
  if (walking && (sl.step ? tour.stepId === sl.step : tour.step === sl.n)) return md.replace(ABOUT_STEP_LINE, '')
  // The step's number now (found by id), else the one it had.
  const i = lj && sl.step ? lj.j.steps.findIndex((x) => x.id === sl.step) : -1
  const back = (title: string) => titledCmdLink(
    `↩ Step ${i >= 0 ? i + 1 : sl.n}${walking ? '' : ` · ${title}`}`, "Open this step on the journey's map",
    'codeNotes.openStepLink', sl.id, sl.step ?? '', sl.n,
  )
  return md.replace(ABOUT_STEP_BY_NUMBER, (_m, _n: string, title: string) => back(title)).replace(ABOUT_STEP_BY_ID, (_m, title: string) => back(title))
}

/** An answer typed in a check thread, shown as typed: its markdown and HTML never render (a "---" or "# …" in it). */
const isCheckAnswer = (n: Note, index: number) =>
  !!understanding?.isCheck(n) && !!n.data.messages[index] && !isAgent(n.data.messages[index])

const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;' }

/** Text as it was typed: tags as text, Markdown punctuation escaped, each line its own (spaces kept, so long answers
 *  still wrap). */
function verbatim(body: string): vscode.MarkdownString {
  const line = (l: string) => l.replace(/[&<>]/g, (c) => HTML_ESCAPES[c]).replace(/[\\`*_{}[\]()#+\-!~|:]/g, '\\$&')
  return new vscode.MarkdownString(body.split('\n').map(line).join('  \n'))
}

/** A link that opens `file` at `line` of the note's folder. */
function fileLink(n: Note, text: string, file: string, line?: string): string {
  return cmdLink(text.replace(/[[\]]/g, '\\$&'), 'codeNotes.openAt', n.folder.uri.toString(), file, Number(line) || 1)
}

/** Apply under the `k`-th suggestion of message `mi`. */
function applyLink(n: Note, mi: number, k: number): string {
  return titledCmdLink('Apply suggestion', `Replace ${rangeLabel(n)} with this · Ctrl+Z undoes`, 'codeNotes.applySuggestion', n.data.id, mi, k)
}

/** A message's text outside code blocks with its links; its ```suggestion blocks (an agent's: `mi`) with Apply. */
function withLinksAndApply(n: Note, body: string, mi: number | undefined): string {
  const home = os.homedir()
  let k = 0
  return body.split(FENCE).map((seg) => {
    if (seg.startsWith('```')) {
      const sug = mi !== undefined && !n.data.target ? SUGGESTION.exec(seg) : null
      if (!sug) return seg
      return `\`\`\`\n${sug[1]}\n\`\`\`\n\n${applyLink(n, mi!, k++)}`
    }
    // also inside "(…)" and lists; repo-relative labels, never the home folder's path.
    return linkify(seg, n.folder.uri.fsPath, home, (text, file, line) => fileLink(n, text, file, line))
  }).join('')
}

/**
 * Markdown of a message: relative links and `path:line` references open the file (C84); images become links (C87).
 * `mi`: the message's index, for an agent's message: its ```suggestion blocks get an Apply link.
 */
function messageMarkdown(n: Note, body: string, mi?: number, index = mi): vscode.MarkdownString {
  if (index !== undefined && isCheckAnswer(n, index)) return verbatim(body)
  // A check thread's code links (the question's, a grade's): phrases marked here, the markup goes in after escapeTags.
  const clinks = index !== undefined ? understanding?.linksIn(n, index) ?? [] : []
  if (clinks.length) body = linkPhrases(body, clinks, new Set<number>(), PH)
  const out = withLinksAndApply(n, body, mi)
  // Asked from a journey step: the line saying so links back to that step on the map.
  const linked = index === 0 ? withStepLink(n, out) : out
  const key = `check|${n.data.id}|${index}`
  const codeLink = (i: string, phrase: string) => codeLinkMarkup(key, Number(i), clinks[Number(i)], phrase, undefined, 'show this code')
  const text = clinks.length ? escapeTags(linked).replace(PH_RE, (_m, i: string, phrase: string) => codeLink(i, phrase)) : linked
  const md = trustedMarkdown(text, MESSAGE_COMMANDS)
  if (clinks.length) md.supportHtml = true
  md.baseUri = n.folder.uri
  return md
}

/** Notes whose whole thread the person asked to see; others hide older read replies (C86 C107). */
export const expanded = new Set<string>()

const COLLAPSE_OVER = 6

/** What a note's thread shows: the stale banner, its messages and status changes, then the rows of what is going on. */
export function commentsOf(n: Note, thread: vscode.CommentThread): vscode.Comment[] {
  return [...staleBanner(n), ...messageComments(n, thread), ...statusRows(n)]
}

/** A row the extension writes (not a message), by `author`. */
const systemRow = (body: vscode.MarkdownString, author: string, label?: string): vscode.Comment =>
  ({ body, mode: vscode.CommentMode.Preview, author: { name: author }, ...(label ? { label } : {}), contextValue: 'system' })

/** Lines of code shown in a stale note's banner before "… n more". */
const SHOWN_LINES = 3

/** What a stale note's lines were: only the lines that changed (a one-word change is visible, a 15-line note is not
 *  repeated), or the old code when its lines can't be read now. */
function wasText(n: Note): string {
  const a = n.data.anchor.text
  if (!a.trim()) return ''
  const short = (l: string[]) => (l.length > SHOWN_LINES ? [...l.slice(0, SHOWN_LINES), `… ${l.length - SHOWN_LINES} more`] : l)
  const doc = openDoc(docUri(n))
  if (!doc || pastEnd.has(n.data.id)) return `\`\`\`\n${short(a.split('\n')).join('\n')}\n\`\`\``
  const cur = docLines(doc).slice(n.data.range.start - 1, n.data.range.end)
  const ch = lineDiff(a.split('\n'), cur)
  if (!ch.del.length && !ch.ins.length) return ''
  return `\`\`\`diff\n${[...short(ch.del).map((l) => `- ${l.trim()}`), ...short(ch.ins).map((l) => `+ ${l.trim()}`)].join('\n')}\n\`\`\``
}

/** The banner's words: the file is gone, it is shorter than the note's lines, or the code changed. */
function staleText(n: Note): string {
  const id = n.data.id
  const move = cmdLink('Move', 'codeNotes.moveToSelection', id)
  const gone = `**\`${n.data.file}\` no longer exists.**`
  if (missing.has(id) && n.data.target) return gone
  const was = wasText(n)
  const wasPart = was ? `\n\n${was}` : '' // a code block starts on its own line
  if (missing.has(id)) return `${gone}${wasPart}\n\n${move}`
  const end = pastEnd.get(id)
  if (end !== undefined) return `**The code changed since this note** (the file has ${end} lines now).\n\n${move}`
  // One wording; the branch only as a fact. Two buttons, one wording: Keep here · Move.
  const branch = otherBranch(n)
  return `**The code changed since this note**${branch ? ` (written on \`${branch}\`)` : ''}.${wasPart}\n\n${cmdLink('Keep here', 'codeNotes.acceptCode', id)} · ${move}`
}

function staleBanner(n: Note): vscode.Comment[] {
  if (!n.data.stale) return []
  return [systemRow(trustedMarkdown(staleText(n), BANNER_COMMANDS), 'Code Notes')]
}

/** Replies always shown at the end of a long thread, besides the new ones. */
const LAST_SHOWN = 3
/** A clock this far off (ms) is not believed. */
const SKEW_MS = 60_000

/** The messages a long thread hides (`hideFrom` up to before `hideTo`): the read replies between the first message and
 *  the last few; none while expanded, or when it would hide fewer than two. */
function collapsedRange(n: Note): { hideFrom: number; hideTo: number } {
  const from = visitFrom.get(n.data.id) ?? seenCount(n)
  const total = n.data.messages.length
  const hideFrom = 1
  let hideTo = 1
  if (total > COLLAPSE_OVER && !expanded.has(n.data.id)) {
    hideTo = Math.min(total - LAST_SHOWN, from)
    if (hideTo - hideFrom < 2) hideTo = hideFrom
  }
  return { hideFrom, hideTo }
}

/** "Show N earlier replies" / "Show fewer": a row that runs `command` on the note. */
const toggleRow = (n: Note, label: string, command: string) => systemRow(systemMarkdown(cmdLink(label, command, n.data.id)), '')

/**
 * Status changes: a grey line where they happened among the messages, by the person who did it. Takes from `events`
 * the ones before time `before` (all that are left, without it).
 */
function eventRows(events: NoteEvent[], before?: number): vscode.Comment[] {
  const out: vscode.Comment[] = []
  while (events.length) {
    const t = Date.parse(events[0].at)
    if (before !== undefined && !(t < before)) break
    const e = events.shift()!
    out.push({
      body: new vscode.MarkdownString(`_${e.type === 'resolved' ? 'Resolved' : 'Reopened'}_`),
      mode: vscode.CommentMode.Preview,
      author: { name: e.by },
      timestamp: Number.isNaN(t) ? undefined : new Date(t),
      contextValue: 'event',
    })
  }
  return out
}

/** Message `i` as a comment; `skewed`: its time is not believed; `next`: "Next question ›" goes under it. */
function messageRow(n: Note, i: number, thread: vscode.CommentThread, skewed: boolean, next: boolean): vscode.Comment {
  const m = n.data.messages[i]
  const t = m.at ? Date.parse(m.at) : NaN
  const md = messageMarkdown(n, m.body, isAgent(m) ? i : undefined, i)
  if (next) {
    md.appendMarkdown(`\n\n${cmdLink('Next question ›', 'codeNotes.nextCheckQuestion')}`)
    alsoAllow(md, 'codeNotes.nextCheckQuestion')
  }
  const isNew = i >= seenCount(n) && !mine(m)
  return {
    body: md,
    mode: vscode.CommentMode.Preview,
    author: { name: m.author }, // no placeholder avatar: the name says who
    timestamp: !Number.isNaN(t) && !skewed ? new Date(t) : undefined,
    label: [isNew ? 'new' : '', skewed ? `dated ${m.at!.slice(0, 10)}` : ''].filter(Boolean).join(' · ') || undefined,
    contextValue: 'message',
    parent: thread,
  } as vscode.Comment
}

/** The messages, with status changes where they happened. Long threads: the first message, "N earlier replies", then
 *  the last few and everything new. */
function messageComments(n: Note, thread: vscode.CommentThread): vscode.Comment[] {
  const out: vscode.Comment[] = []
  const total = n.data.messages.length
  const { hideFrom, hideTo } = collapsedRange(n)
  const events = [...(n.data.events ?? [])]
  // A check question done while others are open: "Next question ›" under its last grade.
  const nextAt = understanding?.threadStatus(n)?.next ? n.data.messages.map((m) => isAgent(m)).lastIndexOf(true) : -1
  let prevAt = 0
  n.data.messages.forEach((m, i) => {
    const t = m.at ? Date.parse(m.at) : NaN
    if (!Number.isNaN(t)) out.push(...eventRows(events, t))
    if (i >= hideFrom && i < hideTo) {
      const label = `Show ${plural(hideTo - hideFrom, 'earlier reply', 'earlier replies')}`
      if (i === hideFrom) out.push(toggleRow(n, label, 'codeNotes.expandThread'))
      return
    }
    if (i === 1 && expanded.has(n.data.id) && total > COLLAPSE_OVER) out.push(toggleRow(n, 'Show fewer', 'codeNotes.collapseThread'))
    // A clock that is off (future, or before the message above): no misleading "now", the stored date instead.
    const skewed = !Number.isNaN(t) && (t > Date.now() + SKEW_MS || t < prevAt - SKEW_MS)
    if (!Number.isNaN(t) && !skewed) prevAt = Math.max(prevAt, t)
    out.push(messageRow(n, i, thread, skewed, i === nextAt))
  })
  out.push(...eventRows(events))
  return out
}

/** Claude at work on the note: what it wrote so far and is doing, with Cancel. */
function askingRow(id: string, a: NonNullable<ReturnType<typeof asking.get>>): vscode.Comment {
  const secs = Math.round((Date.now() - a.started) / 1000)
  const activity = a.activity ? `${a.text ? '\n\n' : ''}_${a.activity}_` : ''
  const thinking = !a.text && !a.activity ? '_Thinking…_' : ''
  const text = `${a.text || ''}${activity}${thinking}\n\n${cmdLink('Cancel', 'codeNotes.cancelClaude', id)}`
  return systemRow(systemMarkdown(text), 'Claude', secs > 2 ? `answering… ${secs}s` : 'answering…')
}

/** After the messages: Claude answering, the check grading or its concern, a journey through the question's code,
 *  and failures (a passing status, not a message: Try again, or Dismiss; never saved). */
function statusRows(n: Note): vscode.Comment[] {
  const id = n.data.id
  const out: vscode.Comment[] = []
  const a = asking.get(id)
  if (a) out.push(askingRow(id, a))
  const chk = understanding?.threadStatus(n)
  if (chk?.checking) out.push(systemRow(systemMarkdown('_Checking your answer…_'), 'Understanding check', 'checking…'))
  if (chk?.concern) out.push(concernRow(id, chk.concern))
  // An open check question whose code a journey of the repository walks: one link to that step.
  const cq = understanding?.isCheck(n) ? understanding.questionOf(n) : undefined
  if (cq && !qDone(understanding!.rowOf(n)?.state ?? '')) {
    const files = [cq.file, ...(cq.also ?? []).map((x) => x.file)]
    const also = seeAlsoLink(files, cq.start ? { start: n.data.range.start, end: n.data.range.end } : undefined)
    if (also) out.push(systemRow(systemMarkdown(also), 'See also'))
  }
  if (chk?.error) {
    const text = `⚠ ${chk.error} ${cmdLink('Try again', 'codeNotes.gradeCheck', id)}`
    out.push(systemRow(systemMarkdown(text), 'Code Notes'))
  }
  const err = askErrors.get(id)
  if (err) {
    const actions = `${cmdLink('Try again', 'codeNotes.askClaude', id)} · ${cmdLink('Dismiss', 'codeNotes.cancelClaude', id)}`
    out.push(systemRow(systemMarkdown(`⚠ Claude couldn't answer: ${err}\n\n${actions}`), 'Code Notes'))
  }
  return out
}

type Concern = NonNullable<ThreadStatus['concern']>

/** A concern the grader found: Suggest a fix, Add TODO, Flag for reviewer; quiet: Mark fixed once it is flagged (it
 *  leaves the merge request), Dismiss with a reason when it is wrong. */
function concernRow(id: string, c: Concern): vscode.Comment {
  const act = (label: string, action: string) => cmdLink(label, 'codeNotes.checkConcern', id, action)
  const acts = [
    act('Suggest a fix', 'fix'),
    c.todo ? `TODO added at ${c.todo}` : act('Add TODO', 'todo'),
    act(c.flagged ? (c.by ? `Flagged by ${c.by} ✓` : 'Flagged ✓') : 'Flag for reviewer', 'flag'),
    ...(c.flagged ? [act('Mark fixed', 'fixed')] : []),
    act('Dismiss', 'dismiss'),
  ]
  return systemRow(systemMarkdown(`⚠ ${c.text}\n\n${acts.join(' · ')}`), c.suspect ? 'Understanding check' : 'Found while grading')
}

export const expandThread = (id: string) => { expanded.add(id); const n = byId(id); if (n) syncThread(n) }

export const collapseThread = (id: string) => { expanded.delete(id); const n = byId(id); if (n) syncThread(n) }
