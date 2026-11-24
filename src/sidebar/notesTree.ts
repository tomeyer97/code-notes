// The Code Notes view: notes by file or session (its rows: rowItems.ts; which notes: notesFilter.ts).

import * as vscode from 'vscode'
import { notes, setCtx, store } from '../app'
import { unread } from '../notes/seen'
import { Note } from '../notes/store'
import { journeyOfNote, journeyQuestionRows, journeyRows, questionRows } from './journeyRows'
import { journeysTree } from './journeysTree'
import { fileNode, Node, noteNode, rowOrder, sessionNode, sessionOf } from './nodes'
import { checked, fileGroups, matchesFilter, ownRow, sameRow, scopeOf } from './notesFilter'
import { itemOf } from './rowItems'
import { ViewSync } from './viewSync'

export let tree: NotesTree

export let treeView: vscode.TreeView<Node>

/** The rows under each kind of row. */
const CHILDREN: { [K in Node['kind']]?: (node: Extract<Node, { kind: K }>) => Node[] } = {
  file: (node) => [...node.notes].sort(rowOrder).map(noteNode),
  session: (node) => fileGroups(node.notes, node.name),
  journeys: () => journeyRows(),
  journey: (node) => journeyQuestionRows(node.lj),
  questions: (node) => questionRows(node.notes),
}

class NotesTree implements vscode.TreeDataProvider<Node> {
  /** One redraw for a burst of changes (as the Journeys view): VS Code asked for a row of one drawing after the next had
   *  dropped it ("Cannot resolve tree item"). Reveals: `revealRow`. */
  readonly sync = new ViewSync<Node>(50)
  refresh() { this.sync.refresh(); journeysTree?.refresh() }

  /** Selects a row once the view holds it, or holds its group (viewSync.ts). */
  revealRow(node: Node): void {
    this.sync.reveal(treeView, this, () => node, { select: true, focus: false })
  }

  getChildren(node?: Node): Node[] {
    if (!node) return rootRows()
    const children = CHILDREN[node.kind] as ((n: Node) => Node[]) | undefined
    return children ? children(node) : []
  }

  /** Only for rows this view lists: a question asked from a step is listed in the Journeys view (journeyOfNote), as
   *  journeys are; they have no parent here. */
  getParent(node: Node): Node | undefined {
    if (node.kind === 'file') return node.session !== undefined ? sessionNode(node.session) : undefined
    if (node.kind !== 'note' || journeyOfNote(node.note)) return undefined
    const n = node.note
    const scope = scopeOf(n)
    if (ownRow(n)) return scope !== undefined ? sessionNode(scope) : undefined
    return fileNode(n, scope, sameRow(n))
  }

  /** What the person expanded or folded, by row id: kept when a filter hides and brings rows back. */
  readonly folded = new Map<string, vscode.TreeItemCollapsibleState>()
  getTreeItem(node: Node): vscode.TreeItem {
    const it = itemOf(node)
    const st = it.id ? this.folded.get(it.id) : undefined
    if (st !== undefined && it.collapsibleState !== undefined && it.collapsibleState !== vscode.TreeItemCollapsibleState.None) it.collapsibleState = st
    return it
  }
}

/**
 * The top of the view: note files that can't be used, the sessions (when grouped by session), then the notes by
 * file. Questions asked from a step are listed under their journey, in the Journeys view, not as loose rows here.
 */
function rootRows(): Node[] {
  const visible = notes().filter((n) => matchesFilter(n) && !journeyOfNote(n))
  const broken: Node[] = [...store.broken].map(([uri, why]) => ({ kind: 'broken', uri, why }))
  const grouped = visible.filter((n) => scopeOf(n) !== undefined)
  const loose = visible.filter((n) => scopeOf(n) === undefined)
  if (!grouped.length) return [...broken, ...fileGroups(loose)]
  return [...broken, ...sessionRows(grouped), ...fileGroups(loose)]
}

/** One row per session: those with unread replies first, then the newest; notes without one are under "Notes". */
function sessionRows(grouped: Note[]): Node[] {
  const bySession = new Map<string, Note[]>()
  for (const n of grouped) bySession.set(sessionOf(n), [...(bySession.get(sessionOf(n)) ?? []), n])
  const latest = (list: Note[]) => list.map((n) => n.data.createdAt ?? n.data.id).sort().pop() ?? ''
  const hasNew = (list: Note[]) => (list.some((n) => unread(n) > 0) ? 0 : 1)
  return [...bySession].map(([name, list]) => sessionNode(name, list))
    .sort((x, y) => hasNew(x.notes) - hasNew(y.notes) || latest(y.notes).localeCompare(latest(x.notes)))
}

/** The Code Notes view; what the person folds stays folded. */
export function createNotesView(context: vscode.ExtensionContext): void {
  tree = new NotesTree()
  treeView = vscode.window.createTreeView('codeNotes.notes', {
    treeDataProvider: tree.sync.provider(tree), showCollapseAll: false, canSelectMany: true, manageCheckboxStateManually: true,
  })
  const folded = (e: vscode.TreeViewExpansionEvent<Node>, st: vscode.TreeItemCollapsibleState) => {
    const id = tree.getTreeItem(e.element).id
    if (id) tree.folded.set(id, st)
  }
  context.subscriptions.push(
    treeView.onDidExpandElement((e) => folded(e, vscode.TreeItemCollapsibleState.Expanded)),
    treeView.onDidCollapseElement((e) => folded(e, vscode.TreeItemCollapsibleState.Collapsed)),
    ...tree.sync.watch(treeView),
  )
}

/** Rows selected in the Code Notes view: two or more are the notes bulk actions work on. */
export function rowsSelected(e: vscode.TreeViewSelectionChangeEvent<Node>): void {
  checked.clear()
  const sel = e.selection.filter((x) => x.kind === 'note')
  if (sel.length > 1) for (const x of sel) checked.add((x as { note: Note }).note.data.id)
  setCtx('codeNotes.hasChecked', checked.size > 0)
}
