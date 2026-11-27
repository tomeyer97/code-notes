// How each row of the Code Notes view looks (a note's row also in the Journeys view, under its step). The counts and
// the grouping come in as RowFacts (noteGroups.ts); a builder only draws.

import * as vscode from 'vscode'
import { journeys } from './ports'
import { askErrors, asking } from '../ask/run'
import { mine } from '../notes/identity'
import { unread } from '../notes/seen'
import { Note } from '../notes/store'
import { ago, isolate, plain, plural, rangeLabel } from '../core/text'
import { placement } from '../notes/location'
import { journeyOfNote, stepLinkOf } from '../notes/model/journeyLink'
import { hiddenSessions, lastMessage } from '../notes/model'
import { baseName } from '../core/paths'
import { Severity } from '../core/format/noteModel'
import { Cmd } from '../platform/commands'
import { BrokenNode, FileNode, NoteNode, NoteRowNode, SessionNode } from './noteNodes'
import { FileCounts, RowFacts, SessionCounts } from './noteGroups'
import { rowContext } from './rowContext'
import { shortDir, whereLabel } from './rowText'

export const SEV_ICON: Record<Severity, [string, string]> = {
  high: ['flame', 'charts.red'], medium: ['triangle-up', 'charts.orange'], low: ['triangle-down', 'charts.blue'], nit: ['dash', 'descriptionForeground'],
}

/** A row of the Code Notes view. */
export function notesRowItem(node: NoteNode, facts: RowFacts): vscode.TreeItem {
  switch (node.kind) {
    case 'session': return sessionItem(node, facts.session(node.name))
    case 'file': return fileItem(node, facts.file(node.key))
    case 'note': return noteItem(node, facts.alone(node.note))
    case 'broken': return brokenItem(node)
  }
}

const description = (parts: string[]) => parts.filter(Boolean).join(' · ')

function sessionItem(node: SessionNode, c: SessionCounts): vscode.TreeItem {
  const hidden = hiddenSessions().has(node.name)
  const fold = hidden ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.Expanded
  const item = new vscode.TreeItem(node.name || 'Notes', fold)
  item.id = `session:${node.name}`
  item.description = description([
    `${node.notes.length}`,
    c.unread ? `${c.unread} new` : '',
    c.resolved ? `${c.resolved}/${c.total} resolved` : '',
    hidden ? 'hidden' : '',
  ])
  item.iconPath = new vscode.ThemeIcon(hidden ? 'eye-closed' : 'notebook')
  item.contextValue = rowContext({ kind: 'session', hidden, named: !!node.name })
  item.tooltip = hidden ? 'Hidden in the editor' : 'Shown in the editor'
  item.accessibilityInformation = { label: `${node.name || 'Notes'}, ${item.description}, ${hidden ? 'hidden in' : 'shown in'} the editor` }
  return item
}

/** A note file that can't be used. */
function brokenItem(node: BrokenNode): vscode.TreeItem {
  const { known } = node
  const name = baseName(vscode.Uri.parse(node.uri).path)
  const item = new vscode.TreeItem(node.title ? plain(node.title, 50) : name)
  item.id = `broken:${node.uri}`
  item.description = `⚠ ${node.why}`
  const lastGood = known ? `\n\nThe list shows its last good version (\`${known.data.file}\` ${rangeLabel(known)}).` : ''
  item.tooltip = new vscode.MarkdownString(`**${name}**: ${node.why}${lastGood}`)
  item.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('errorForeground'))
  item.contextValue = rowContext({ kind: 'broken', known: !!known })
  // The command gets the row as it was before the title and last version were added to it.
  item.command = { command: Cmd.openBroken, title: 'Open', arguments: [{ kind: 'broken', uri: node.uri, why: node.why }] }
  return item
}

function fileItem(node: FileNode, c: FileCounts): vscode.TreeItem {
  const item = new vscode.TreeItem(baseName(node.file), vscode.TreeItemCollapsibleState.Expanded)
  item.id = `file:${node.key}`
  item.description = description([
    `${node.notes.length}`,
    c.newMessages ? `${c.newMessages} new` : '',
    c.stale ? `${c.stale} stale` : '',
    shortDir(node.file),
  ])
  // A query keeps VS Code's Problems/git decorations off the row while the file icon still follows the extension.
  item.resourceUri = vscode.Uri.joinPath(node.folder.uri, node.file).with({ query: 'code-notes' })
  item.iconPath = node.isFolder ? vscode.ThemeIcon.Folder : vscode.ThemeIcon.File
  item.contextValue = rowContext({ kind: 'file' })
  item.tooltip = node.file
  return item
}

/** What a note's row shows besides its text. */
interface NoteFlags {
  /** Replies not seen yet. */
  unread: number
  /** Its file (or folder) is not found. */
  gone: boolean
  /** No file row above it: the row names the file. */
  alone: boolean
}

function noteItem(node: NoteRowNode, alone: boolean): vscode.TreeItem {
  const n = node.note
  const d = n.data
  const flags: NoteFlags = { unread: unread(n), gone: placement.missing(d.id), alone }
  const item = new vscode.TreeItem({ label: noteLabel(n, flags) })
  item.id = `note:${d.id}`
  item.description = noteDescription(n, flags)
  item.iconPath = noteIcon(n, flags)
  item.tooltip = noteTooltip(n, flags)
  item.command = { command: Cmd.reveal, title: 'Go to Note', arguments: [node] }
  item.contextValue = rowContext({
    kind: 'note', status: d.status,
    flags: { stale: !!d.stale, unread: flags.unread > 0, replied: d.messages.some((m) => !mine(m)), asking: asking.has(d.id) },
  })
  // No checkbox on every row: bulk actions use the list's own multi-select (Ctrl/Shift+click).
  return item
}

/** ⚠ (unread and stale), "Step n ·" (asked from a journey step), then the note's first words. */
function noteLabel(n: Note, f: NoteFlags): string {
  const link = stepLinkOf(n)
  const stale = f.unread && n.data.stale ? '⚠ ' : ''
  const step = link && journeyOfNote(n, journeys().list.values()) ? `Step ${link.n} · ` : ''
  return `${stale}${step}${isolate(plain(n.data.messages[0]?.body ?? '(empty note)', 60))}`
}

/** State first (it must survive truncation at the default sidebar width), then where, then replies. */
function noteDescription(n: Note, f: NoteFlags): string {
  const d = n.data
  const replies = d.messages.length - 1
  return description([
    f.unread ? `${f.unread} new` : '',
    claudeState(d.id),
    f.gone ? 'file not found' : d.stale ? 'stale' : '',
    d.status === 'resolved' ? 'resolved' : '',
    whereLabel(n, f.alone),
    !f.unread && replies > 0 ? plural(replies, 'reply', 'replies') : '',
  ])
}

/** What Claude is doing with the note, for its row. */
function claudeState(id: string): string {
  const a = asking.get(id)
  if (a) return a.activity === 'Queued…' ? 'queued for Claude' : 'Claude is answering…'
  return askErrors.has(id) ? 'Claude failed' : ''
}

/** A note's icon: the first that applies, in this order. */
function noteIcon(n: Note, f: NoteFlags): vscode.ThemeIcon {
  const d = n.data
  const icon = (id: string, color?: string) => new vscode.ThemeIcon(id, color ? new vscode.ThemeColor(color) : undefined)
  if (asking.has(d.id)) return icon('sync~spin')
  if (askErrors.has(d.id)) return icon('error', 'errorForeground')
  // An open finding shows its severity even while unread (a fresh review is all unread; "n new" says so).
  if (d.severity && d.status === 'open' && !d.stale) return icon(...SEV_ICON[d.severity])
  if (f.unread) return icon('circle-filled', 'codeNotes.unreadForeground')
  if (f.gone) return icon('error', 'editorWarning.foreground')
  if (d.stale) return icon('warning', 'editorWarning.foreground')
  if (d.status === 'resolved') return icon('pass', 'testing.iconPassed')
  // Who spoke last: you (waiting on the agent) or an agent (your turn).
  const last = lastMessage(n)
  return last && mine(last) ? icon('person') : icon('sparkle')
}

/** The newest reply first (it is what changed; the row itself stays the question), then the question, the last status
 *  change, the severity, and whether the code is still there. */
function noteTooltip(n: Note, f: NoteFlags): vscode.MarkdownString {
  const tip = new vscode.MarkdownString()
  for (const part of [lastReplyPart(n), questionPart(n), eventPart(n), severityPart(n), stalePart(n, f.gone)]) {
    if (part) tip.appendMarkdown(part)
  }
  return tip
}

/** The newest reply, when there is one. */
function lastReplyPart(n: Note): string {
  const last = lastMessage(n)
  if (!last || last === n.data.messages[0]) return ''
  return `**${last.author}** ${ago(last.at)}\n\n${plain(last.body, 300)}\n\n---\n\n`
}

/** The question (the first message), and how many messages are not shown. */
function questionPart(n: Note): string {
  const d = n.data
  const first = d.messages[0]
  if (!first) return ''
  const more = d.messages.length > 2 ? `_${d.messages.length - 2} more · _` : ''
  return `${more}**${first.author}** ${ago(first.at)}\n\n${plain(first.body, 300)}\n\n`
}

/** Who resolved or reopened it last, and when. */
function eventPart(n: Note): string {
  const ev = n.data.events?.[n.data.events.length - 1]
  return ev ? `_${ev.type === 'resolved' ? 'Resolved' : 'Reopened'} by ${ev.by} ${ago(ev.at)}_\n\n` : ''
}

function severityPart(n: Note): string {
  return n.data.severity ? `Severity: ${n.data.severity}\n\n` : ''
}

/** A stale note: its file or folder is gone, or the code changed. */
function stalePart(n: Note, gone: boolean): string {
  const d = n.data
  if (!d.stale) return ''
  return `---\n\n⚠ ${gone ? `The ${d.target === 'folder' ? 'folder' : 'file'} no longer exists.` : 'The code changed since this note.'}`
}
