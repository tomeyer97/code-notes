// The refresh after anything changed: threads, both views, the badge and the context keys menus depend on.

import * as vscode from 'vscode'
import { journeys, notes, setCtx, store, understanding } from './app'
import { asking } from './ask'
import { unread } from './seen'
import { sessionOf } from './sidebar/nodes'
import { checked, filter, FILTERS, groupMode, hiddenSessions, matchesFilter } from './sidebar/notesFilter'
import { tree, treeView } from './sidebar/notesTree'
import { notesFor } from './threads/anchoring'
import { refreshDecorations, syncThread, threads } from './threads/threads'
import { walk } from './tour/tour'

export let statusItem: vscode.StatusBarItem

export function updateCursorContext(): void {
  const e = vscode.window.activeTextEditor
  const line = e ? e.selection.active.line + 1 : -1
  setCtx('codeNotes.cursorOnNote', !!e && notesFor(e.document.uri).some((n) => line >= n.data.range.start && line <= n.data.range.end))
}

export function refreshAll(): void {
  for (const n of notes()) syncThread(n)
  const ids = new Set(notes().map((n) => n.data.id))
  for (const id of [...threads.keys()]) if (!ids.has(id)) { threads.get(id)!.dispose(); threads.delete(id) }
  for (const id of [...checked]) if (!ids.has(id)) checked.delete(id)
  tree.refresh()
  const u = notes().filter((n) => unread(n) > 0).length
  treeView.badge = u ? { value: u, tooltip: `${u} note${u === 1 ? '' : 's'} with new replies` } : undefined
  // An active filter is visible: view title, a message, a filled filter icon.
  const shownCount = notes().filter(matchesFilter).length
  const label = FILTERS.find((f) => f.id === filter)!.label
  treeView.description = filter === 'all' ? undefined : `${label} · ${shownCount}`
  treeView.message = [
    store.broken.size ? `${store.broken.size} note file${store.broken.size === 1 ? '' : 's'} can't be used (top of the list)` : '',
    filter !== 'all' && !shownCount ? `No notes match "${label}".` : '',
    filter !== 'all' && journeys.all().length ? 'Journeys are hidden while filtering.' : '',
  ].filter(Boolean).join(' ') || undefined
  setCtx('codeNotes.hasNotes', ids.size > 0 || store.broken.size > 0)
  // Notes the Code Notes view lists (a check's questions are in the Check view): without any, it steps aside while a check is open.
  setCtx('codeNotes.listsNotes', notes().some((n) => !understanding?.isCheck(n)) || store.broken.size > 0)
  setCtx('codeNotes.hasChecked', checked.size > 0)
  setCtx('codeNotes.filtered', filter !== 'all')
  setCtx('codeNotes.groupBy', groupMode)
  setCtx('codeNotes.hasSessions', notes().some((n) => n.data.session))
  setCtx('codeNotes.hasHiddenSessions', notes().some((n) => hiddenSessions().has(sessionOf(n))))
  if (asking.size) {
    statusItem.text = `$(sync~spin) Claude · ${asking.size}`
    statusItem.tooltip = `Claude is answering ${asking.size} note${asking.size === 1 ? '' : 's'}`
    statusItem.command = 'codeNotes.notes.focus'
    statusItem.show()
  } else statusItem.hide() // no note counter: the activity bar badge is the one unread count
  refreshDecorations()
  updateCursorContext()
  walk.updateTour()
}

/** The status bar item that says Claude is answering. */
export function createStatusItem(): void {
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50)
}
