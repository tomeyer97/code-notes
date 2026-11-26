// What a note's thread shows: the stale banner, its messages (as Markdown with links and suggestions) and status
// changes, then the rows the features add (rows.ts). Built with what decides a redraw, from the same inputs.

import * as vscode from 'vscode'
import * as os from 'os'
import { lineDiff } from '../core/anchors/staleDiff'
import { codeLinkMarkup } from '../core/codeLinkText'
import { labelSafe } from '../core/escape'
import { plural, rangeLabel, shortQ } from '../core/text'
import { otherBranch } from '../platform/checkout'
import { BANNER_COMMANDS, Cmd, MESSAGE_COMMANDS } from '../platform/commands'
import { docLines, openDoc } from '../platform/documents'
import { checkLinkKey } from '../platform/keys'
import { isAgent, mine } from '../notes/identity'
import { docUri, placement } from '../notes/location'
import { seenCount, visitFrom } from '../notes/seen'
import type { Note } from '../notes/store'
import { diffLines, oldLines, staleText } from './banner'
import { COMMENT_CONTEXT } from './context'
import { Links } from './links'
import { linkedMarkdown, shownKey, systemRow, type MessageShape, type ThreadContributions, type ThreadRow } from './rows'
import { appliedOf, appliedText, messageText, verbatimText } from './text'
import { hiddenReplies, timeline, type TimelineEntry } from './timeline'

export { suggestionOf } from './text'

export function threadRange(n: Note): vscode.Range {
  return new vscode.Range(n.data.range.start - 1, 0, n.data.range.end - 1, 0)
}

/** A message as a comment: it knows its thread (the reply and resolve commands get it). */
export interface NoteComment extends vscode.Comment {
  parent: vscode.CommentThread
}

/** What a thread is drawn from besides the note. */
export interface ThreadInput {
  thread: vscode.CommentThread
  /** The person asked to see the whole thread. */
  expanded: boolean
  contributions: ThreadContributions
}

/** The thread's comments, and a key that changes exactly when what they show does. */
export function commentsOf(n: Note, input: ThreadInput): { comments: vscode.Comment[]; key: string } {
  const rows: ThreadRow[] = [...staleBanner(n), ...messageRows(n, input), ...input.contributions.rows(n)]
  return {
    comments: rows.map((r) => r.comment),
    key: JSON.stringify(rows.map((r) => r.key ?? shownKey(r.comment))),
  }
}

/**
 * The thread's header says only what the gutter can't — a file or folder note, or that its file is missing — then the
 * note's first line (never VS Code's "Start discussion"). Severity, session, "n new" and "resolved" are in the list
 * and VS Code's own state.
 */
export function threadLabel(n: Note): string {
  const { target, file } = n.data
  const firstLine = (n.data.messages[0]?.body ?? '').split('\n').find((l) => l.trim()) ?? ''
  const label = [
    target === 'folder' ? `Folder ${file}/` : target ? 'File note' : '',
    placement.missing(n.data.id) ? `⚠ ${target === 'folder' ? 'folder' : 'file'} not found` : '',
    shortQ(firstLine.replace(/\*\*|`/g, ''), 80),
  ].filter(Boolean).join(' · ')
  return labelSafe(label)
}

// --- The stale banner

/** What a stale note's lines were: only the lines that changed, or the old code when its lines can't be read now. */
function wasText(n: Note): string {
  const a = n.data.anchor.text
  if (!a.trim()) return ''
  const doc = openDoc(docUri(n))
  if (!doc || placement.pastEnd(n.data.id) !== undefined) return oldLines(a.split('\n'))
  const ch = lineDiff(a.split('\n'), docLines(doc).slice(n.data.range.start - 1, n.data.range.end))
  return ch.del.length || ch.ins.length ? diffLines(ch.del, ch.ins) : ''
}

function staleBanner(n: Note): ThreadRow[] {
  if (!n.data.stale) return []
  const id = n.data.id
  const facts = {
    id, file: n.data.file, wholeFile: !!n.data.target, missing: placement.missing(id), pastEnd: placement.pastEnd(id),
    was: wasText(n), branch: otherBranch(n),
  }
  const links = new Links(BANNER_COMMANDS)
  const body = linkedMarkdown(staleText(facts, links), links)
  return [{ comment: { body, mode: vscode.CommentMode.Preview, author: { name: 'Code Notes' }, contextValue: COMMENT_CONTEXT.system } }]
}

// --- Messages

/** A link that opens `file` at `line` of the note's folder. */
function fileLink(n: Note, links: Links, text: string, file: string, line?: string): string {
  return links.to(text.replace(/[[\]]/g, '\\$&'), Cmd.openAt, n.folder.uri.toString(), file, Number(line) || 1)
}

/**
 * Markdown of message `i`: relative links and `path:line` references open the file, images become links; an agent's
 * ```suggestion blocks get Apply; what the features shape (verbatim answers, code links, a last line, a link under).
 */
function messageMarkdown(n: Note, i: number, shapes: MessageShape[]): vscode.MarkdownString {
  const body = n.data.messages[i].body
  const after = (links: Links) => shapes.map((s) => s.after?.(links)).filter(Boolean).map((x) => `\n\n${x}`).join('')
  if (shapes.some((s) => s.verbatim)) {
    const links = new Links([])
    return linkedMarkdown(verbatimText(body) + after(links), links)
  }
  const links = new Links(MESSAGE_COMMANDS)
  let text = body
  let suffix = ''
  for (const s of shapes) {
    const cut = s.lastLine?.(text, links)
    if (cut) { text = cut.body; suffix = cut.suffix }
  }
  const codeLinks = shapes.flatMap((s) => s.codeLinks ?? [])
  const key = checkLinkKey(n.data.id, i)
  const m = n.data.messages[i]
  const applied = (k: number) => appliedOf(m.extra, k)
  const apply = isAgent(m) && !n.data.target
    ? (k: number) => {
      const a = applied(k)
      return a ? appliedText(a) : links.titled('Apply suggestion', `Replace ${rangeLabel(n)} with this · Ctrl+Z undoes`, Cmd.applySuggestion, n.data.id, i, k)
    }
    : undefined
  const md = linkedMarkdown(messageText({
    body: text, suffix, apply, codeLinks,
    // Repo-relative labels, never the home folder's path.
    root: n.folder.uri.fsPath, home: os.homedir(),
    fileLink: (t, file, line) => fileLink(n, links, t, file, line),
    codeLink: (ci, phrase) => codeLinkMarkup(key, ci, codeLinks[ci], phrase, undefined, 'show this code'),
  }) + after(links), links)
  if (codeLinks.length) md.supportHtml = true
  md.baseUri = n.folder.uri
  return md
}

/** "Show N earlier replies" / "Show fewer": a row that runs `command` on the note. */
const toggleRow = (n: Note, label: string, command: typeof Cmd.expandThread | typeof Cmd.collapseThread): ThreadRow =>
  ({ comment: systemRow((l) => l.to(label, command, n.data.id), '') })

function entryRow(n: Note, e: TimelineEntry, input: ThreadInput): ThreadRow {
  switch (e.kind) {
    case 'event':
      // A status change: a grey line where it happened, by the person who did it.
      return {
        comment: {
          body: new vscode.MarkdownString(`_${e.event.type === 'resolved' ? 'Resolved' : 'Reopened'}_`),
          mode: vscode.CommentMode.Preview,
          author: { name: e.event.by },
          timestamp: e.time === undefined ? undefined : new Date(e.time),
          contextValue: COMMENT_CONTEXT.event,
        },
      }
    case 'showEarlier':
      return toggleRow(n, `Show ${plural(e.count, 'earlier reply', 'earlier replies')}`, Cmd.expandThread)
    case 'showFewer':
      return toggleRow(n, 'Show fewer', Cmd.collapseThread)
    case 'message': {
      const m = n.data.messages[e.index]
      const isNew = e.index >= seenCount(n) && !mine(m)
      const comment: NoteComment = {
        body: messageMarkdown(n, e.index, input.contributions.message(n, e.index)),
        mode: vscode.CommentMode.Preview,
        author: { name: m.author }, // no placeholder avatar: the name says who
        timestamp: e.time === undefined ? undefined : new Date(e.time),
        label: [isNew ? 'new' : '', e.dated ? `dated ${e.dated}` : ''].filter(Boolean).join(' · ') || undefined,
        contextValue: COMMENT_CONTEXT.message,
        parent: input.thread,
      }
      return { comment }
    }
  }
}

/** The messages, with status changes where they happened. Long threads: the first message, "N earlier replies", then
 *  the last few and everything new. */
function messageRows(n: Note, input: ThreadInput): ThreadRow[] {
  const messages = n.data.messages
  const hidden = hiddenReplies(messages.length, visitFrom.get(n.data.id) ?? seenCount(n), input.expanded)
  return timeline(messages, n.data.events ?? [], hidden, input.expanded, Date.now()).map((e) => entryRow(n, e, input))
}
