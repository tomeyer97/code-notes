// The Code Notes view: notes by file or session. Its structure: noteGroups.ts (made once per drawing); its rows:
// notesRows.ts; which notes: the notes model.

import * as vscode from 'vscode'
import { journeys, notesStore } from './ports'
import { visibleNotes } from '../notes/visible'
import { setCtx } from '../platform/context'
import { unread } from '../notes/seen'
import { Note } from '../notes/store'
import { FILTERS, matchesFilter, NotesApi, NotesChange, notesModel, scopeOf, selection, whileTyping } from '../notes/model'
import { NOTES_CTX } from '../notes/model/contextKeys'
import { plural } from '../core/text'
import { journeyOfNote } from './journeyRows'
import { journeysTree } from './journeysTree'
import { BrokenNode, NoteNode, noteNode, noteNodes } from './noteNodes'
import { NotesLayout, RowFacts } from './noteGroups'
import { notesRowItem } from './notesRows'
import { ViewSync } from './viewSync'
import { fireAndForget } from '../platform/run'

export let tree: NotesTree

export let treeView: vscode.TreeView<NoteNode>

/** Both views drawn again (the Journeys view lists the notes asked from a step). */
export function refreshViews(): void {
  tree.refreshRows()
  journeysTree?.refresh()
}

class NotesTree implements vscode.TreeDataProvider<NoteNode> {
  /** One redraw for a burst of changes (as the Journeys view): VS Code asked for a row of one drawing after the next had
   *  dropped it ("Cannot resolve tree item"). Reveals: `revealRow`. What the person folds stays folded. */
  readonly sync = new ViewSync<NoteNode>(50, { keepFolds: true })
  /** The structure of the latest drawing; made again on the next one, or when asked after a change. */
  private drawn: NotesLayout | undefined

  /** This view's rows drawn again. */
  refreshRows(): void {
    this.drawn = undefined
    this.sync.refresh()
  }

  /** Both views drawn again (the tour's callers). */
  refresh(): void { refreshViews() }

  /** Selects a row once the view holds it, or holds its group (viewSync.ts). */
  revealRow(node: NoteNode): void {
    this.sync.reveal(treeView, this, () => node, { select: true, focus: false })
  }

  layout(): NotesLayout { return (this.drawn ??= layOut()) }

  getChildren(node?: NoteNode): NoteNode[] {
    if (node) return this.layout().children(node)
    // A new drawing: the rows it no longer has are forgotten.
    noteNodes.sweep()
    this.drawn = layOut()
    return this.drawn.roots
  }

  /** The parent recorded while the rows were made; none for a row this view doesn't list (a question asked from a
   *  step is listed in the Journeys view). */
  getParent(node: NoteNode): NoteNode | undefined { return this.layout().parent(node) }

  getTreeItem(node: NoteNode): vscode.TreeItem { return notesRowItem(node, this.layout()) }
}

/** The rows' structure from the notes now. Questions asked from a step are listed under their journey, in the
 *  Journeys view, not as loose rows here. */
function layOut(): NotesLayout {
  const visible = visibleNotes()
  return new NotesLayout({
    visible,
    listed: visible.filter((n) => matchesFilter(n) && !journeyOfNote(n)),
    broken: notesStore().broken().map(({ uri, why }) => brokenNode(uri, why)),
    scopeOf,
    unread,
  })
}

/** A note file that can't be used: its title (or first message) and its last good version, when known. */
function brokenNode(uri: string, why: string): BrokenNode {
  const known = notesStore().atUri(uri)
  const title = notesStore().brokenAt(uri)?.title ?? known?.data.messages[0]?.body
  return { kind: 'broken', uri, why, ...(title ? { title } : {}), ...(known ? { known } : {}) }
}

/** What a note row shows that depends on the rows around it, as the Code Notes view has them now. */
export const notesRowFacts = (): RowFacts => tree.layout()

/** The Code Notes view. */
export function createNotesView(context: vscode.ExtensionContext): void {
  tree = new NotesTree()
  treeView = vscode.window.createTreeView('codeNotes.notes', {
    treeDataProvider: tree.sync.provider(tree), showCollapseAll: false, canSelectMany: true, manageCheckboxStateManually: true,
  })
  context.subscriptions.push(...tree.sync.watch(treeView))
}

/** Rows selected in the Code Notes view: two or more are the notes bulk actions work on. */
export function rowsSelected(e: vscode.TreeViewSelectionChangeEvent<NoteNode>): void {
  const sel = selection()
  sel.select(e.selection.flatMap((x) => (x.kind === 'note' ? [x.note.data.id] : [])))
  fireAndForget(setCtx(NOTES_CTX.hasChecked, sel.checked.size > 0), 'notesTree: setCtx codeNotes.hasChecked')
}

/** The view follows the notes (not each key typed: once the typing stops), and selects the row of a note opened. */
export function followNotes(model: NotesApi): vscode.Disposable {
  return vscode.Disposable.from(
    model.onDidChange((c) => { if (!whileTyping(c)) refreshNotesView(c) }),
    model.onDidReveal(revealInList),
  )
}

/** Selects the note's row, when the view is open and lists it. */
function revealInList(n: Note): void {
  // A step's question is listed under its journey in the Journeys view, not in this one.
  if (!treeView.visible || !matchesFilter(n) || journeyOfNote(n)) return
  tree.revealRow(noteNode(n))
}

/** The rows, the unread badge, and an active filter made visible (title, a message). */
function refreshNotesView(c: NotesChange): void {
  refreshViews()
  const u = visibleNotes().filter((n) => unread(n) > 0).length
  treeView.badge = u ? { value: u, tooltip: `${plural(u, 'note')} with new replies` } : undefined
  const { filter } = notesModel().query
  const shownCount = visibleNotes().filter(matchesFilter).length
  const label = FILTERS.find((f) => f.id === filter)!.label
  treeView.description = filter === 'all' ? undefined : `${label} · ${shownCount}`
  const broken = notesStore().brokenCount()
  treeView.message = c.notice ?? ([
    broken ? `${plural(broken, 'note file')} can't be used (top of the list)` : '',
    filter !== 'all' && !shownCount ? `No notes match "${label}".` : '',
    filter !== 'all' && journeys().all().length ? 'Journeys are hidden while filtering.' : '',
  ].filter(Boolean).join(' ') || undefined)
}
