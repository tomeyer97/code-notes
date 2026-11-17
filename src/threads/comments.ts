// What a note's thread shows: its messages (as markdown with links and suggestions), its status changes, and the
// rows the extension adds (the code changed, Claude answering or failed, the check's grading and concerns).

import * as vscode from 'vscode'
import * as os from 'os'
import { lineDiff } from '../anchor'
import { linkify } from '../answerLinks'
import { byId, cmdLink, systemMarkdown, understanding } from '../app'
import { askErrors, asking } from '../ask'
import { codeLinkMarkup, linkPhrases, PH, PH_RE } from '../codeLinkText'
import { isAgent, mine, otherBranch } from '../identity'
import { escapeTags } from '../journeyModel'
import { seenCount, visitFrom } from '../seen'
import { journeyOfNote, stepLinkOf } from '../sidebar/journeyRows'
import { Note } from '../store'
import { qDone, seeAlsoLink } from '../tour/checkTour'
import { tour, walk } from '../tour/tour'
import { docUri, missing, openDoc, pastEnd } from './anchoring'
import { syncThread } from './threads'
import { docLines } from '../wfs'

export function threadRange(n: Note): vscode.Range {
  return new vscode.Range(n.data.range.start - 1, 0, n.data.range.end - 1, 0)
}

export function lines(n: Note): string {
  if (n.data.target) return n.data.target === 'folder' ? 'folder' : 'whole file'
  return n.data.range.start === n.data.range.end ? `L${n.data.range.start}` : `L${n.data.range.start}–${n.data.range.end}`
}

const FENCE = /(```[\s\S]*?```)/g

const SUGGESTION = /^```suggestion[ \t]*\r?\n([\s\S]*?)\r?\n?```$/

/** The k-th ```suggestion block of a message. */
export function suggestionOf(body: string, k: number): string | undefined {
  return body.split(FENCE).map((seg) => SUGGESTION.exec(seg)?.[1]).filter((x): x is string => x !== undefined)[k]
}

/**
 * Markdown of a message: relative links and `path:line` references open the file (C84); images become links (C87).
 * `mi`: the message's index, for an agent's message: its ```suggestion blocks get an Apply link.
 */
/**
 * The line a question asked from a step ends with (askStep writes it): the step by its id, or (older notes) by its
 * number. Group 1 / group 2: the journey's title.
 */
const ABOUT_STEP_BY_ID = /_About the step “[^”]*” \(id [^)]*\) of the journey “([^”]*)”_\s*$/
const ABOUT_STEP_BY_NUMBER = /_About step (\d+) of the journey “([^”]*)”: ([^\n]*)_\s*$/
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
  const back = (title: string) => `[↩ Step ${i >= 0 ? i + 1 : sl.n}${walking ? '' : ` · ${title}`}](command:codeNotes.openStepLink?${encodeURIComponent(JSON.stringify([sl.id, sl.step ?? '', sl.n]))} "Open this step on the journey's map")`
  return md.replace(ABOUT_STEP_BY_NUMBER, (_m, _n: string, title: string) => back(title)).replace(ABOUT_STEP_BY_ID, (_m, title: string) => back(title))
}

function messageMarkdown(n: Note, body: string, mi?: number, index = mi): vscode.MarkdownString {
  const link = (text: string, file: string, line?: string) =>
    `[${text.replace(/[[\]]/g, '\\$&')}](command:codeNotes.openAt?${encodeURIComponent(JSON.stringify([n.folder.uri.toString(), file, Number(line) || 1]))})`
  const home = os.homedir()
  // An answer in a check thread is shown as typed: its markdown and HTML never render (a "---" or "# …" in it).
  if (index !== undefined && understanding?.isCheck(n) && n.data.messages[index] && !isAgent(n.data.messages[index])) {
    // Markdown punctuation escaped, tags as text, each line its own (spaces kept, so long answers still wrap).
    const lit = body.split('\n').map((l) => l.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] as string)
      .replace(/[\\`*_{}[\]()#+\-!~|:]/g, '\\$&')).join('  \n')
    return new vscode.MarkdownString(lit)
  }
  // A check thread's code links (the question's, a grade's): phrases marked here, the markup goes in after escapeTags.
  const clinks = index !== undefined ? understanding?.linksIn(n, index) ?? [] : []
  if (clinks.length) body = linkPhrases(body, clinks, new Set<number>(), PH)
  const parts = body.split(FENCE)
  let k = 0
  const out = parts.map((seg) => {
    if (seg.startsWith('```')) {
      const sug = mi !== undefined && !n.data.target ? SUGGESTION.exec(seg) : null
      if (!sug) return seg
      return `\`\`\`\n${sug[1]}\n\`\`\`\n\n[Apply suggestion](command:codeNotes.applySuggestion?${encodeURIComponent(JSON.stringify([n.data.id, mi, k++]))} "Replace ${lines(n)} with this · Ctrl+Z undoes")`
    }
    // also inside "(…)" and lists; repo-relative labels, never the home folder's path.
    return linkify(seg, n.folder.uri.fsPath, home, link)
  }).join('')
  // Asked from a journey step: the line saying so links back to that step on the map.
  const linked = index === 0 ? withStepLink(n, out) : out
  const key = `check|${n.data.id}|${index}`
  const md = new vscode.MarkdownString(clinks.length ? escapeTags(linked).replace(PH_RE, (_m, i: string, phrase: string) => codeLinkMarkup(key, Number(i), clinks[Number(i)], phrase, undefined, 'show this code')) : linked)
  md.isTrusted = { enabledCommands: ['codeNotes.openAt', 'codeNotes.expandThread', 'codeNotes.applySuggestion', 'codeNotes.openStepLink', 'codeNotes.codeLink'] }
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
  const md = new vscode.MarkdownString(staleText(n))
  md.isTrusted = { enabledCommands: ['codeNotes.acceptCode', 'codeNotes.moveToSelection'] }
  return [systemRow(md, 'Code Notes')]
}

/** Replies always shown at the end of a long thread, besides the new ones. */
const LAST_SHOWN = 3
/** A clock this far off (ms) is not believed. */
const SKEW_MS = 60_000

/** The messages, with status changes where they happened. Long threads: the first message, "N earlier replies", then
 *  the last few and everything new. */
function messageComments(n: Note, thread: vscode.CommentThread): vscode.Comment[] {
  const out: vscode.Comment[] = []
  const from = visitFrom.get(n.data.id) ?? seenCount(n)
  const total = n.data.messages.length
  const hideFrom = 1
  let hideTo = 1
  if (total > COLLAPSE_OVER && !expanded.has(n.data.id)) {
    hideTo = Math.min(total - LAST_SHOWN, from)
    if (hideTo - hideFrom < 2) hideTo = hideFrom
  }
  const toggle = (label: string, command: string) => out.push(systemRow(systemMarkdown(cmdLink(label, command, n.data.id)), ''))
  // Status changes: a grey line where they happened among the messages, by the person who did it.
  const events = [...(n.data.events ?? [])]
  const flushEvents = (before?: number) => {
    while (events.length) {
      const t = Date.parse(events[0].at)
      if (before !== undefined && !(t < before)) break
      const e = events.shift()!
      out.push({
        body: new vscode.MarkdownString(`_${e.type === 'resolved' ? 'Resolved' : 'Reopened'}_`),
        mode: vscode.CommentMode.Preview, author: { name: e.by }, timestamp: Number.isNaN(t) ? undefined : new Date(t), contextValue: 'event',
      })
    }
  }
  // A check question done while others are open: "Next question ›" under its last grade.
  const nextAt = understanding?.threadStatus(n)?.next ? n.data.messages.map((m) => isAgent(m)).lastIndexOf(true) : -1
  let prevAt = 0
  n.data.messages.forEach((m, i) => {
    const t = m.at ? Date.parse(m.at) : NaN
    if (!Number.isNaN(t)) flushEvents(t)
    if (i >= hideFrom && i < hideTo) {
      if (i === hideFrom) toggle(`Show ${hideTo - hideFrom} earlier repl${hideTo - hideFrom === 1 ? 'y' : 'ies'}`, 'codeNotes.expandThread')
      return
    }
    if (i === 1 && expanded.has(n.data.id) && total > COLLAPSE_OVER) toggle('Show fewer', 'codeNotes.collapseThread')
    // A clock that is off (future, or before the message above): no misleading "now", the stored date instead.
    const skewed = !Number.isNaN(t) && (t > Date.now() + SKEW_MS || t < prevAt - SKEW_MS)
    if (!Number.isNaN(t) && !skewed) prevAt = Math.max(prevAt, t)
    const md = messageMarkdown(n, m.body, isAgent(m) ? i : undefined, i)
    if (i === nextAt) {
      md.appendMarkdown(`\n\n${cmdLink('Next question ›', 'codeNotes.nextCheckQuestion')}`)
      md.isTrusted = { enabledCommands: [...(typeof md.isTrusted === 'object' ? md.isTrusted.enabledCommands : []), 'codeNotes.nextCheckQuestion'] }
    }
    out.push({
      body: md,
      mode: vscode.CommentMode.Preview,
      author: { name: m.author }, // no placeholder avatar: the name says who
      timestamp: !Number.isNaN(t) && !skewed ? new Date(t) : undefined,
      label: [i >= seenCount(n) && !mine(m) ? 'new' : '', skewed ? `dated ${m.at!.slice(0, 10)}` : ''].filter(Boolean).join(' · ') || undefined,
      contextValue: 'message',
      parent: thread,
    } as vscode.Comment)
  })
  flushEvents()
  return out
}

/** After the messages: Claude answering, the check grading or its concern, a journey through the question's code,
 *  and failures (a passing status, not a message: Try again, or Dismiss; never saved). */
function statusRows(n: Note): vscode.Comment[] {
  const id = n.data.id
  const out: vscode.Comment[] = []
  const a = asking.get(id)
  if (a) {
    const secs = Math.round((Date.now() - a.started) / 1000)
    const activity = a.activity ? `${a.text ? '\n\n' : ''}_${a.activity}_` : ''
    const thinking = !a.text && !a.activity ? '_Thinking…_' : ''
    out.push(systemRow(systemMarkdown(`${a.text || ''}${activity}${thinking}\n\n${cmdLink('Cancel', 'codeNotes.cancelClaude', id)}`), 'Claude', secs > 2 ? `answering… ${secs}s` : 'answering…'))
  }
  const chk = understanding?.threadStatus(n)
  if (chk?.checking) out.push(systemRow(systemMarkdown('_Checking your answer…_'), 'Understanding check', 'checking…'))
  if (chk?.concern) out.push(concernRow(id, chk.concern))
  // An open check question whose code a journey of the repository walks: one link to that step.
  const cq = understanding?.isCheck(n) ? understanding.questionOf(n) : undefined
  if (cq && !qDone(understanding!.rowOf(n)?.state ?? '')) {
    const also = seeAlsoLink([cq.file, ...(cq.also ?? []).map((x) => x.file)], cq.start ? { start: n.data.range.start, end: n.data.range.end } : undefined)
    if (also) out.push(systemRow(systemMarkdown(also), 'See also'))
  }
  if (chk?.error) out.push(systemRow(systemMarkdown(`⚠ ${chk.error} ${cmdLink('Try again', 'codeNotes.gradeCheck', id)}`), 'Code Notes'))
  const err = askErrors.get(id)
  if (err) out.push(systemRow(systemMarkdown(`⚠ Claude couldn't answer: ${err}\n\n${cmdLink('Try again', 'codeNotes.askClaude', id)} · ${cmdLink('Dismiss', 'codeNotes.cancelClaude', id)}`), 'Code Notes'))
  return out
}

type Concern = NonNullable<NonNullable<ReturnType<NonNullable<typeof understanding>['threadStatus']>>['concern']>
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
