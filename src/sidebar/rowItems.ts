// How each kind of row looks, in either view (ITEMS: one builder per kind of Node). The notes' rows are here; a
// journey's row and its questions' are in journeyRows.ts.

import * as vscode from 'vscode'
import { journeys, notes, store } from '../app'
import { askErrors, asking } from '../ask/run'
import { mine } from '../notes/identity'
import { unread } from '../notes/seen'
import { Note } from '../notes/store'
import { ago, isolate, plain, plural, rangeLabel } from '../core/text'
import { placement } from '../notes/location'
import { tourState, walk } from '../tour/instances'
import { badJourneyItem, journeyItem, questionsItem, showIntro } from './journeyRows'
import { journeyOfNote, stepLinkOf } from '../notes/model/journeyLink'
import { listState } from './listModel'
import { Node, SEV_ICON } from './nodes'
import { ownRow } from './notesFilter'
import { hiddenSessions, lastMessage, sessionOf } from '../notes/model'
import { baseName } from '../core/paths'
import { Cmd } from '../platform/commands'

/** The row of each kind of node. */
const ITEMS: { [K in Node['kind']]: (node: Extract<Node, { kind: K }>) => vscode.TreeItem } = {
  journeys: () => journeysItem(),
  intro: () => introItem(),
  journey: (node) => journeyItem(node.lj, node.group),
  badJourney: (node) => badJourneyItem(node),
  questions: (node) => questionsItem(node),
  session: (node) => sessionItem(node),
  broken: (node) => brokenItem(node),
  file: (node) => fileItem(node),
  jgroup: (node) => jgroupItem(node),
  jmore: (node) => jmoreItem(node),
  note: (node) => noteItem(node),
}

/** A node's row. */
export function itemOf(node: Node): vscode.TreeItem {
  return (ITEMS[node.kind] as (n: Node) => vscode.TreeItem)(node)
}

/** Open the first time (with one quiet line saying what it is), then folded: reading material, not an inbox. */
function journeysItem(): vscode.TreeItem {
  const open = (walk.tourJourney() && tourState.step) || showIntro()
  const item = new vscode.TreeItem('Journeys', open ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed)
  // Its name only: the rows below are the count and the explanation.
  item.id = 'journeys'
  item.contextValue = 'journeys'
  return item
}

function introItem(): vscode.TreeItem {
  const item = new vscode.TreeItem('Journeys explain how the code works')
  item.id = 'journeys-intro'
  item.iconPath = new vscode.ThemeIcon('info', new vscode.ThemeColor('descriptionForeground'))
  item.tooltip = 'Each one answers a question with a map of the code and its steps. Click one to open its map.'
  return item
}

/** A group of the Journeys view (In this file, Continue, All, an area): open unless it is All under other groups;
 *  areas fold when there are many of them (a handful stay open). Its count: the journeys in it. */
function jgroupItem(node: Extract<Node, { kind: 'jgroup' }>): vscode.TreeItem {
  const g = node.g
  const groups = listState.last?.groups
  const open = g.id !== 'all' || !groups?.some((x) => x.id === 'here' || x.id === 'continue')
  const areas = groups?.find((x) => x.id === 'all')?.children?.length ?? 0
  const expanded = g.id.startsWith('area:') ? areas <= MANY_AREAS : open
  const item = new vscode.TreeItem(g.label, expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed)
  item.id = `jgroup:${g.id}`
  const n = g.children ? g.children.reduce((a, c) => a + c.keys.length, 0) : g.keys.length + (g.more ?? 0)
  item.description = String(n)
  item.contextValue = 'jgroup'
  return item
}

/** More areas than this: each area's group starts folded. */
const MANY_AREAS = 4

/** "Show all (n more)": the rest of a capped group (In this file). */
function jmoreItem(node: Extract<Node, { kind: 'jmore' }>): vscode.TreeItem {
  const item = new vscode.TreeItem(`Show all (${node.n} more)`)
  item.id = `jmore:${node.g}`
  item.command = { command: Cmd.journeysHereAll, title: 'Show all' }
  return item
}

function sessionItem(node: Extract<Node, { kind: 'session' }>): vscode.TreeItem {
  const hidden = hiddenSessions().has(node.name)
  const item = new vscode.TreeItem(node.name || 'Notes', hidden ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.Expanded)
  item.id = `session:${node.name}`
  const u = node.notes.filter((n) => unread(n) > 0).length
  const all = notes().filter((n) => sessionOf(n) === node.name)
  const done = all.filter((n) => n.data.status === 'resolved').length
  item.description = [`${node.notes.length}`, u ? `${u} new` : '', done ? `${done}/${all.length} resolved` : '', hidden ? 'hidden' : ''].filter(Boolean).join(' · ')
  item.iconPath = new vscode.ThemeIcon(hidden ? 'eye-closed' : 'notebook')
  item.contextValue = `session;${hidden ? 'hidden' : 'shown'}${node.name ? ';named' : ''}`
  item.tooltip = hidden ? 'Hidden in the editor' : 'Shown in the editor'
  item.accessibilityInformation = { label: `${node.name || 'Notes'}, ${item.description}, ${hidden ? 'hidden in' : 'shown in'} the editor` }
  return item
}

/** A note file that can't be used. */
function brokenItem(node: Extract<Node, { kind: 'broken' }>): vscode.TreeItem {
  const known = store.atUri(node.uri)
  const name = baseName(vscode.Uri.parse(node.uri).path)
  const title = store.brokenAt(node.uri)?.title ?? known?.data.messages[0]?.body
  const item = new vscode.TreeItem(title ? plain(title, 50) : name)
  item.id = `broken:${node.uri}`
  item.description = `⚠ ${node.why}`
  item.tooltip = new vscode.MarkdownString(`**${name}**: ${node.why}${known ? `\n\nThe list shows its last good version (\`${known.data.file}\` ${rangeLabel(known)}).` : ''}`)
  item.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('errorForeground'))
  item.contextValue = known ? 'broken;known' : 'broken'
  item.command = { command: Cmd.openBroken, title: 'Open', arguments: [node] }
  return item
}

/** Folders shown in a file row's description, the last ones ("…/api/v2"). */
const DIRS_SHOWN = 2

function fileItem(node: Extract<Node, { kind: 'file' }>): vscode.TreeItem {
  const item = new vscode.TreeItem(baseName(node.file), vscode.TreeItemCollapsibleState.Expanded)
  item.id = `file:${node.key}`
  const dir = node.file.includes('/') ? node.file.slice(0, node.file.lastIndexOf('/')) : ''
  const stale = node.notes.filter((n) => n.data.stale).length
  const newMsgs = node.notes.reduce((a, n) => a + unread(n), 0)
  const segs = dir.split('/').filter(Boolean)
  const shortDir = segs.length > DIRS_SHOWN ? `…/${segs.slice(-DIRS_SHOWN).join('/')}` : dir
  item.description = [`${node.notes.length}`, newMsgs ? `${newMsgs} new` : '', stale ? `${stale} stale` : '', shortDir].filter(Boolean).join(' · ')
  // A query keeps VS Code's Problems/git decorations off the row while the file icon still follows the extension.
  item.resourceUri = vscode.Uri.joinPath(node.folder.uri, node.file).with({ query: 'code-notes' })
  item.iconPath = node.isFolder ? vscode.ThemeIcon.Folder : vscode.ThemeIcon.File
  item.contextValue = 'file'
  item.tooltip = node.file
  return item
}

/** What a note's row shows besides its text. */
interface NoteFlags {
  /** Replies not seen yet. */
  unread: number
  /** Its file (or folder) is not found. */
  gone: boolean
}

function noteItem(node: Extract<Node, { kind: 'note' }>): vscode.TreeItem {
  const n = node.note
  const d = n.data
  const flags: NoteFlags = { unread: unread(n), gone: placement.missing(d.id) }
  const item = new vscode.TreeItem({ label: noteLabel(n, flags) })
  item.id = `note:${d.id}`
  item.description = noteDescription(n, flags)
  item.iconPath = noteIcon(n, flags)
  item.tooltip = noteTooltip(n, flags)
  item.command = { command: Cmd.reveal, title: 'Go to Note', arguments: [node] }
  item.contextValue = noteContext(n, flags)
  // No checkbox on every row: bulk actions use the list's own multi-select (Ctrl/Shift+click).
  return item
}

/** ⚠ (unread and stale), "Step n ·" (asked from a journey step), then the note's first words. */
function noteLabel(n: Note, f: NoteFlags): string {
  const link = stepLinkOf(n)
  const stale = f.unread && n.data.stale ? '⚠ ' : ''
  const step = link && journeyOfNote(n, journeys.list.values()) ? `Step ${link.n} · ` : ''
  return `${stale}${step}${isolate(plain(n.data.messages[0]?.body ?? '(empty note)', 60))}`
}

/** State first (it must survive truncation at the default sidebar width), then where, then replies. */
function noteDescription(n: Note, f: NoteFlags): string {
  const d = n.data
  const replies = d.messages.length - 1
  // Alone in its file: the row says which file (`app.ts:12`), there is no file row above it.
  const base = baseName(d.file)
  const where = !ownRow(n) ? rangeLabel(n) : d.target === 'folder' ? `${base}/` : d.target ? base : `${base}:${d.range.start}`
  return [
    f.unread ? `${f.unread} new` : '',
    claudeState(d.id),
    f.gone ? 'file not found' : d.stale ? 'stale' : '',
    d.status === 'resolved' ? 'resolved' : '',
    where,
    !f.unread && replies > 0 ? plural(replies, 'reply', 'replies') : '',
  ].filter(Boolean).join(' · ')
}

/** For the menus: the status (no Ask Claude on a resolved note), stale, unread, replied, `asking` (Stop Claude only then). */
function noteContext(n: Note, f: NoteFlags): string {
  const d = n.data
  const replied = d.messages.some((m) => !mine(m))
  const flags = [d.stale ? 'stale' : '', f.unread ? 'unread' : '', replied ? 'replied' : '', asking.has(d.id) ? 'asking' : '']
  return ['note', d.status, ...flags].filter(Boolean).join(';')
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
