// The refresh after anything changed: threads, both views, the badge and the context keys menus depend on.

import * as vscode from 'vscode'
import { journeys, notes, setCtx, store, understanding } from './app'
import { refreshAskStatus } from './ask/run'
import { refreshDecorations } from './notes/decorations'
import { notesAtLine } from './notes/location'
import { unread } from './seen'
import { checked, filter, FILTERS, groupMode, hiddenSessions, matchesFilter, sessionOf } from './sidebar/nodes'
import { tree, treeView } from './sidebar/notesTree'
import { plural } from './text'
import { syncThreads } from './threads/sync'
import { walk } from './tour/tour'

/** codeNotes.cursorOnNote: the caret is on a note's lines. */
export function updateCursorContext(): void {
  const e = vscode.window.activeTextEditor
  const line = e ? e.selection.active.line + 1 : -1
  setCtx('codeNotes.cursorOnNote', !!e && notesAtLine(e.document.uri, line).length > 0)
}

/** Everything that shows notes, in this order. */
export function refreshAll(): void {
  const ids = syncThreads()
  for (const id of [...checked]) if (!ids.has(id)) checked.delete(id)
  refreshNotesView()
  refreshContextKeys(ids.size)
  refreshAskStatus()
  refreshDecorations()
  updateCursorContext()
  walk.updateTour()
}

/** The Code Notes view: its rows, the unread badge, and an active filter made visible (title, a message). */
function refreshNotesView(): void {
  tree.refresh()
  const u = notes().filter((n) => unread(n) > 0).length
  treeView.badge = u ? { value: u, tooltip: `${plural(u, 'note')} with new replies` } : undefined
  const shownCount = notes().filter(matchesFilter).length
  const label = FILTERS.find((f) => f.id === filter)!.label
  treeView.description = filter === 'all' ? undefined : `${label} · ${shownCount}`
  const broken = store.broken.size
  treeView.message = [
    broken ? `${plural(broken, 'note file')} can't be used (top of the list)` : '',
    filter !== 'all' && !shownCount ? `No notes match "${label}".` : '',
    filter !== 'all' && journeys.all().length ? 'Journeys are hidden while filtering.' : '',
  ].filter(Boolean).join(' ') || undefined
}

/** The context keys menus and views depend on; `shown`: how many notes are shown. */
function refreshContextKeys(shown: number): void {
  setCtx('codeNotes.hasNotes', shown > 0 || store.broken.size > 0)
  // Notes the Code Notes view lists (a check's questions are in the Check view): without any, it steps aside while a check is open.
  setCtx('codeNotes.listsNotes', notes().some((n) => !understanding?.isCheck(n)) || store.broken.size > 0)
  setCtx('codeNotes.hasChecked', checked.size > 0)
  setCtx('codeNotes.filtered', filter !== 'all')
  setCtx('codeNotes.groupBy', groupMode)
  setCtx('codeNotes.hasSessions', notes().some((n) => n.data.session))
  setCtx('codeNotes.hasHiddenSessions', notes().some((n) => hiddenSessions().has(sessionOf(n))))
}
