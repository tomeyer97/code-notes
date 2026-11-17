// The Code Notes view: notes by file or session, and the questions asked from journey steps under their journey.

import * as vscode from 'vscode'
import { notes, setCtx, store } from '../app'
import { askErrors, asking } from '../ask'
import { mine } from '../identity'
import { unread } from '../seen'
import { Note } from '../store'
import { ago, isolate, plain } from '../text'
import { missing } from '../threads/anchoring'
import { lines } from '../threads/comments'
import { tour, walk } from '../tour/tour'
import { journeyItem, journeyOfNote, journeyRows, questionsNode, showIntro, stepLinkOf } from './journeyRows'
import { journeysTree } from './journeysTree'
import { cached, checked, fileGroups, hiddenSessions, journeyNode, lastMessage, matchesFilter, Node, noteNode, order, ownRow, rowOrder, sameRow, scopeOf, sessionNode, sessionOf, SEV_ICON } from './nodes'

export let tree: NotesTree

export let treeView: vscode.TreeView<Node>

class NotesTree implements vscode.TreeDataProvider<Node> {
  private readonly changed = new vscode.EventEmitter<Node | undefined>()
  readonly onDidChangeTreeData = this.changed.event
  /** One redraw for a burst of changes (as the Journeys view): VS Code asked for a row of one drawing after the next had
   *  dropped it ("Cannot resolve tree item"). */
  private timer: NodeJS.Timeout | undefined
  refresh() { clearTimeout(this.timer); this.timer = setTimeout(() => this.changed.fire(undefined), 50); journeysTree?.refresh() }

  getChildren(node?: Node): Node[] {
    if (node?.kind === 'file') return [...node.notes].sort(rowOrder).map(noteNode)
    if (node?.kind === 'session') return fileGroups(node.notes, node.name)
    if (node?.kind === 'journeys') return journeyRows()
    if (node?.kind === 'journey') { const q = questionsNode(node.lj); return q && q.kind === 'questions' ? [...q.notes].sort(order).map(noteNode) : [] }
    if (node?.kind === 'questions') return [...node.notes].sort(order).map(noteNode)
    if (node) return []
    // Questions asked from a step are listed under their journey, not as loose rows.
    const visibleNotes = notes().filter((n) => matchesFilter(n) && !journeyOfNote(n))
    const broken: Node[] = [...store.broken].map(([uri, why]) => ({ kind: 'broken', uri, why }))
    // Journeys: one collapsed group (reading material, not an inbox:-), above the notes.
    // Notes first (they may need you), then the journeys; a notes filter hides the journeys.
    // Journeys have their own view (JourneysTree).
    const js: Node[] = []
    const grouped = visibleNotes.filter((n) => scopeOf(n) !== undefined)
    const loose = visibleNotes.filter((n) => scopeOf(n) === undefined)
    if (!grouped.length) return [...broken, ...fileGroups(loose), ...js]
    // Sessions: newest first; notes without one are under "Notes".
    const bySession = new Map<string, Note[]>()
    for (const n of grouped) bySession.set(sessionOf(n), [...(bySession.get(sessionOf(n)) ?? []), n])
    const latest = (list: Note[]) => list.map((n) => n.data.createdAt ?? n.data.id).sort().pop() ?? ''
    const hasNew = (list: Note[]) => (list.some((n) => unread(n) > 0) ? 0 : 1)
    const sessions = [...bySession].map(([name, list]) => cached(`session:${name}`, { kind: 'session' as const, name, notes: list }))
      .sort((x, y) => hasNew(x.notes) - hasNew(y.notes) || latest(y.notes).localeCompare(latest(x.notes)))
    return [...broken, ...sessions, ...fileGroups(loose), ...js]
  }

  getParent(node: Node): Node | undefined {
    if (node.kind === 'journey' || node.kind === 'intro' || node.kind === 'badJourney' || node.kind === 'jgroup' || node.kind === 'jmore') return journeysTree.getParent(node)
    if (node.kind === 'questions') return journeyNode(node.lj)
    if (node.kind === 'note') { const lj = journeyOfNote(node.note); if (lj) return journeyNode(lj) }
    if (node.kind === 'file' && node.session !== undefined) {
      return cached(`session:${node.session}`, { kind: 'session', name: node.session, notes: notes().filter((x) => sessionOf(x) === node.session && matchesFilter(x)) })
    }
    if (node.kind !== 'note') return undefined
    const n = node.note
    const scope = scopeOf(n)
    if (ownRow(n)) return scope !== undefined ? sessionNode(scope) : undefined
    const key = `${scope ?? ''}|${n.folder.uri}|${n.data.file}`
    return cached(`file:${key}`, { kind: 'file', key, folder: n.folder, file: n.data.file, notes: sameRow(n), ...(scope !== undefined ? { session: scope } : {}), ...(n.data.target === 'folder' ? { isFolder: true } : {}) })
  }

  /** What the person expanded or folded, by row id: kept when a filter hides and brings rows back. */
  readonly folded = new Map<string, vscode.TreeItemCollapsibleState>()
  getTreeItem(node: Node): vscode.TreeItem {
    const it = this.itemOf(node)
    const st = it.id ? this.folded.get(it.id) : undefined
    if (st !== undefined && it.collapsibleState !== undefined && it.collapsibleState !== vscode.TreeItemCollapsibleState.None) it.collapsibleState = st
    return it
  }
  private itemOf(node: Node): vscode.TreeItem {
    return (ITEMS[node.kind] as (n: Node) => vscode.TreeItem)(node)
  }
}

/** The row of each kind of node. */
const ITEMS: { [K in Node['kind']]: (node: Extract<Node, { kind: K }>) => vscode.TreeItem } = {
  journeys: () => journeysItem(),
  intro: () => introItem(),
  journey: (node) => journeyItem(node.lj),
  badJourney: (node) => badJourneyItem(node),
  questions: (node) => questionsItem(node),
  session: (node) => sessionItem(node),
  broken: (node) => brokenItem(node),
  file: (node) => fileItem(node),
  jgroup: (node) => journeysTree.getTreeItem(node),
  jmore: (node) => journeysTree.getTreeItem(node),
  note: (node) => noteItem(node),
}

/** Open the first time (with one quiet line saying what it is: R1), then folded: reading material, not an inbox. */
function journeysItem(): vscode.TreeItem {
  const item = new vscode.TreeItem('Journeys', (walk.tourJourney() && tour.step) || showIntro() ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed)
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

/** A journey file that can't be read: one dimmed row (the text is the row's muted description), why on hover, click opens it. */
function badJourneyItem(node: Extract<Node, { kind: 'badJourney' }>): vscode.TreeItem {
  const name = node.uri.path.split('/').pop()!
  const item = new vscode.TreeItem('')
  item.id = `badJourney:${node.uri}`
  item.description = `⚠ ${name}`
  const tip = new vscode.MarkdownString(`${node.why.replace(/[\\`*_[\]<>]/g, '\\$&')}\n\n[Open file](command:vscode.open?${encodeURIComponent(JSON.stringify([node.uri.toString()]))})`)
  tip.isTrusted = { enabledCommands: ['vscode.open'] }
  item.tooltip = tip
  item.accessibilityInformation = { label: `${name}: can't be read` }
  item.command = { command: 'vscode.open', title: 'Open file', arguments: [node.uri] }
  item.contextValue = 'badJourney'
  return item
}

function questionsItem(node: Extract<Node, { kind: 'questions' }>): vscode.TreeItem {
  const item = new vscode.TreeItem(`Questions (${node.notes.length})`, vscode.TreeItemCollapsibleState.Expanded)
  item.id = `questions:${node.lj.key}`
  item.iconPath = new vscode.ThemeIcon('comment-discussion')
  const u = node.notes.filter((n) => unread(n) > 0).length
  if (u) item.description = `${u} new`
  item.tooltip = 'Notes asked from this journey\'s steps'
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
  const known = store.notes.get(node.uri)
  const name = vscode.Uri.parse(node.uri).path.split('/').pop() ?? node.uri
  const title = store.brokenTitle.get(node.uri) ?? known?.data.messages[0]?.body
  const item = new vscode.TreeItem(title ? plain(title, 50) : name)
  item.id = `broken:${node.uri}`
  item.description = `⚠ ${node.why}`
  item.tooltip = new vscode.MarkdownString(`**${name}**: ${node.why}${known ? `\n\nThe list shows its last good version (\`${known.data.file}\` ${lines(known)}).` : ''}`)
  item.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('errorForeground'))
  item.contextValue = known ? 'broken;known' : 'broken'
  item.command = { command: 'codeNotes.openBroken', title: 'Open', arguments: [node] }
  return item
}

/** Folders shown in a file row's description, the last ones ("…/api/v2"). */
const DIRS_SHOWN = 2

function fileItem(node: Extract<Node, { kind: 'file' }>): vscode.TreeItem {
  const item = new vscode.TreeItem(node.file.split('/').pop() ?? node.file, vscode.TreeItemCollapsibleState.Expanded)
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

function noteItem(node: Extract<Node, { kind: 'note' }>): vscode.TreeItem {
  const n = node.note
  const d = n.data
  const u = unread(n)
  const gone = missing.has(d.id)
  const link = stepLinkOf(n)
  const item = new vscode.TreeItem({ label: `${u && d.stale ? '⚠ ' : ''}${link && journeyOfNote(n) ? `Step ${link.n} · ` : ''}${isolate(plain(d.messages[0]?.body ?? '(empty note)', 60))}` })
  item.id = `note:${d.id}`
  const replies = d.messages.length - 1
  // Alone in its file: the row says which file (`app.ts:12`), there is no file row above it.
  const base = d.file.split('/').pop() ?? d.file
  const where = !ownRow(n) ? lines(n) : d.target === 'folder' ? `${base}/` : d.target ? base : `${base}:${d.range.start}`
  // State first: it must survive truncation at the default sidebar width.
  item.description = [
    u ? `${u} new` : '',
    claudeState(d.id),
    gone ? 'file not found' : d.stale ? 'stale' : '',
    d.status === 'resolved' ? 'resolved' : '',
    where,
    !u && replies > 0 ? `${replies} repl${replies === 1 ? 'y' : 'ies'}` : '',
  ].filter(Boolean).join(' · ')
  item.iconPath = noteIcon(n, u, gone)
  item.tooltip = noteTooltip(n, gone)
  item.command = { command: 'codeNotes.reveal', title: 'Go to Note', arguments: [node] }
  // `asking` (Stop Claude only then), the status (no Ask Claude on a resolved note).
  item.contextValue = ['note', d.status, d.stale ? 'stale' : '', u ? 'unread' : '', d.messages.some((m) => !mine(m)) ? 'replied' : '', asking.has(d.id) ? 'asking' : ''].filter(Boolean).join(';')
  // No checkbox on every row: bulk actions use the list's own multi-select (Ctrl/Shift+click).
  return item
}

/** What Claude is doing with the note, for its row. */
function claudeState(id: string): string {
  const a = asking.get(id)
  if (a) return a.activity === 'Queued…' ? 'queued for Claude' : 'Claude is answering…'
  return askErrors.has(id) ? 'Claude failed' : ''
}

/** A note's icon: the first that applies, in this order. */
function noteIcon(n: Note, unreadCount: number, gone: boolean): vscode.ThemeIcon {
  const d = n.data
  const icon = (id: string, color?: string) => new vscode.ThemeIcon(id, color ? new vscode.ThemeColor(color) : undefined)
  if (asking.has(d.id)) return icon('sync~spin')
  if (askErrors.has(d.id)) return icon('error', 'errorForeground')
  // An open finding shows its severity even while unread (a fresh review is all unread; "n new" says so).
  if (d.severity && d.status === 'open' && !d.stale) return icon(...SEV_ICON[d.severity])
  if (unreadCount) return icon('circle-filled', 'codeNotes.unreadForeground')
  if (gone) return icon('error', 'editorWarning.foreground')
  if (d.stale) return icon('warning', 'editorWarning.foreground')
  if (d.status === 'resolved') return icon('pass', 'testing.iconPassed')
  // Who spoke last: you (waiting on the agent) or an agent (your turn).
  const last = lastMessage(n)
  return last && mine(last) ? icon('person') : icon('sparkle')
}

/** The newest reply first (it is what changed; the row itself stays the question), then the question, the last status
 *  change, the severity, and whether the code is still there. */
function noteTooltip(n: Note, gone: boolean): vscode.MarkdownString {
  const d = n.data
  const first = d.messages[0]
  const last = lastMessage(n)
  const tip = new vscode.MarkdownString()
  if (last && last !== first) tip.appendMarkdown(`**${last.author}** ${ago(last.at)}\n\n${plain(last.body, 300)}\n\n---\n\n`)
  if (first) tip.appendMarkdown(`${d.messages.length > 2 ? `_${d.messages.length - 2} more · _` : ''}**${first.author}** ${ago(first.at)}\n\n${plain(first.body, 300)}\n\n`)
  const ev = d.events?.[d.events.length - 1]
  if (ev) tip.appendMarkdown(`_${ev.type === 'resolved' ? 'Resolved' : 'Reopened'} by ${ev.by} ${ago(ev.at)}_\n\n`)
  if (d.severity) tip.appendMarkdown(`Severity: ${d.severity}\n\n`)
  if (d.stale) tip.appendMarkdown(`---\n\n⚠ ${gone ? `The ${d.target === 'folder' ? 'folder' : 'file'} no longer exists.` : 'The code changed since this note.'}`)
  return tip
}

/** The Code Notes view; what the person folds stays folded. */
export function createNotesView(context: vscode.ExtensionContext): void {
  tree = new NotesTree()
  treeView = vscode.window.createTreeView('codeNotes.notes', { treeDataProvider: tree, showCollapseAll: false, canSelectMany: true, manageCheckboxStateManually: true })
  const folded = (e: vscode.TreeViewExpansionEvent<Node>, st: vscode.TreeItemCollapsibleState) => { const id = tree.getTreeItem(e.element).id; if (id) tree.folded.set(id, st) }
  context.subscriptions.push(treeView.onDidExpandElement((e) => folded(e, vscode.TreeItemCollapsibleState.Expanded)), treeView.onDidCollapseElement((e) => folded(e, vscode.TreeItemCollapsibleState.Collapsed)))
}

/** Rows selected in the Code Notes view: two or more are the notes bulk actions work on. */
export function rowsSelected(e: vscode.TreeViewSelectionChangeEvent<Node>): void {
  checked.clear()
  const sel = e.selection.filter((x) => x.kind === 'note')
  if (sel.length > 1) for (const x of sel) checked.add((x as { note: Note }).note.data.id)
  setCtx('codeNotes.hasChecked', checked.size > 0)
}
