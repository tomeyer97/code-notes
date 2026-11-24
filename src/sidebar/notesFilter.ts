// Which notes the Code Notes view lists and how: the filter, resolved notes shown or not, hidden sessions, grouping by
// file or by session, the rows ticked for bulk actions, and the commands that change them.

import * as vscode from 'vscode'
import { byId, notes, setCtx, stored, understanding } from '../app'
import { refreshAll } from '../refresh'
import { unread } from '../notes/seen'
import { Note } from '../notes/store'
import { setCollapse } from '../threads/settle'
import { revealed, threads } from '../threads/sync'
import { journeyOfNote } from './journeyRows'
import { fileNode, Node, noteNode, sessionOf, sevRank } from './nodes'
import { fireAndForget } from '../platform/run'
import { STATE } from '../platform/state'
import { sessionFileKey } from '../platform/keys'

/** What the Code Notes view lists (the picker: FILTERS). Who spoke last is each row's icon, not a filter. */
type Filter = 'all' | 'unread' | 'stale'

export const FILTERS: { id: Filter; label: string; detail: string }[] = [
  { id: 'all', label: 'All notes', detail: 'Open notes (and resolved ones when shown)' },
  { id: 'unread', label: 'Unread', detail: 'Notes with replies you have not seen' },
  { id: 'stale', label: 'Stale', detail: 'The code under the note changed' },
]

export let filter: Filter = 'all'

let showResolved = false

export let groupMode: 'file' | 'session' = 'file'

export const checked = new Set<string>() // note ids selected in the sidebar (2 or more: bulk actions)

/** The note is listed (under the view's filter). */
export function matchesFilter(n: Note): boolean {
  return listedUnder(n, filter)
}

/** The note is listed under filter `f`. */
function listedUnder(n: Note, f: Filter): boolean {
  // A check's questions are listed in the Check view, not here as well.
  if (understanding?.isCheck(n)) return false
  const open = n.data.status === 'open'
  switch (f) {
    case 'unread': return unread(n) > 0 || revealed.id === n.data.id
    case 'stale': return !!n.data.stale && (open || showResolved)
    default: return open || showResolved || unread(n) > 0
  }
}

export function hiddenSessions(): Set<string> { return new Set(stored.get(STATE.hiddenSessions)) }

/** A note whose session is hidden is not drawn in the editor (unless it was just opened from the list). */
export const hiddenInEditor = (n: Note) => revealed.id !== n.data.id && hiddenSessions().has(sessionOf(n))

/** Hides or shows sessions; `only` shows these and hides every other one. */
export async function setSessionHidden(names: string[], hidden: boolean, only = false): Promise<void> {
  const h = only ? new Set(notes().map(sessionOf).filter((x) => !names.includes(x))) : hiddenSessions()
  if (!only) for (const name of names) hidden ? h.add(name) : h.delete(name)
  await stored.set(STATE.hiddenSessions, [...h])
  // The note just opened from the list is folded when its session is hidden now.
  const r = revealed.id ? byId(revealed.id) : undefined
  if (r && h.has(sessionOf(r))) {
    revealed.id = undefined
    const t = threads.get(r.data.id)
    if (t) setCollapse(t, vscode.CommentThreadCollapsibleState.Collapsed, r.data.id)
  }
  refreshAll()
}

/** Notes grouped by file (or folder); a file with one note is that note's row. */
export function fileGroups(list: Note[], session?: string): Node[] {
  const groups = new Map<string, Node & { kind: 'file' }>()
  for (const n of list) {
    const key = sessionFileKey(session, n.folder.uri, n.data.file)
    if (!groups.has(key)) groups.set(key, fileNode(n, session, []))
    groups.get(key)!.notes.push(n)
  }
  // A stable order: the list must not jump while an agent writes; unread shows as dots.
  // In a session (a review): the most severe findings first, then by file.
  const worst = (g: { notes: Note[] }) => (session !== undefined ? Math.min(...g.notes.map(sevRank)) : 0)
  return [...groups.values()]
    .sort((a, b) => worst(a) - worst(b) || a.file.localeCompare(b.file))
    .map((g) => (g.notes.length === 1 ? noteNode(g.notes[0]) : g))
}

/** Group by session (when there are sessions and the person chose it). */
const bySessions = () => groupMode === 'session' && notes().some((x) => x.data.session)

/** The session group a note is listed under, if any. */
export function scopeOf(n: Note): string | undefined {
  return bySessions() ? sessionOf(n) : undefined
}

/** The visible notes listed with this one under the same file row (itself included). */
export function sameRow(n: Note): Note[] {
  const scope = scopeOf(n)
  const sameFile = (x: Note) => x.folder === n.folder && x.data.file === n.data.file
  return notes().filter((x) => sameFile(x) && matchesFilter(x) && scopeOf(x) === scope && !journeyOfNote(x))
}

/** A row of its own: alone in its file. */
export const ownRow = (n: Note) => sameRow(n).length <= 1

export const showResolvedNotes = () => { showResolved = true; fireAndForget(setCtx('codeNotes.showResolved', true), 'notesFilter: setCtx codeNotes.showResolved'); refreshAll() }

export const hideResolvedNotes = () => { showResolved = false; fireAndForget(setCtx('codeNotes.showResolved', false), 'notesFilter: setCtx codeNotes.showResolved'); refreshAll() }

/** Show in Code Notes: a filter, each with how many notes it shows. */
export const pickFilter = async () => {
  const items = FILTERS.map((f) => ({
    label: `${f.id === filter ? '$(check) ' : ''}${f.label}`,
    detail: f.detail,
    id: f.id,
    description: `${notes().filter((n) => listedUnder(n, f.id)).length}`,
  }))
  const pick = await vscode.window.showQuickPick(items, { title: 'Show in Code Notes' })
  if (!pick) return
  filter = pick.id
  // No invisible ticks.
  for (const id of [...checked]) {
    const n = byId(id)
    if (!n || !matchesFilter(n)) checked.delete(id)
  }
  refreshAll()
}

export const groupByFile = async () => { groupMode = 'file'; await stored.set(STATE.groupBy, 'file'); refreshAll() }

export const groupBySession = async () => { groupMode = 'session'; await stored.set(STATE.groupBy, 'session'); refreshAll() }

/** Group by file or by session, as last chosen in this workspace. */
export function loadGroupMode(): void {
  groupMode = stored.get(STATE.groupBy) === 'session' ? 'session' : 'file'
}
