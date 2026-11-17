// The Code Notes view's rows: what a row is (Node), which notes are listed (the filter, sessions), and in what order.

import * as vscode from 'vscode'
import { byId, notes, setCtx, state, understanding } from '../app'
import { mine } from '../identity'
import { Group } from '../journeyList'
import { LoadedJourney } from '../journeys'
import { refreshAll } from '../refresh'
import { unread } from '../seen'
import { Note, Severity } from '../store'
import { setCollapse } from '../threads/settle'
import { revealed, threads } from '../threads/threads'
import { journeyOfNote } from './journeyRows'

export type Node =
  | { kind: 'session'; name: string; notes: Note[] }
  | { kind: 'file'; key: string; folder: vscode.WorkspaceFolder; file: string; notes: Note[]; session?: string; isFolder?: boolean }
  | { kind: 'note'; note: Note }
  | { kind: 'broken'; uri: string; why: string }
  | { kind: 'journeys' }
  | { kind: 'journey'; lj: LoadedJourney; group?: string }
  | { kind: 'jgroup'; g: Group }
  | { kind: 'jmore'; g: string; n: number }
  | { kind: 'badJourney'; uri: vscode.Uri; why: string }
  | { kind: 'intro' }
  | { kind: 'questions'; lj: LoadedJourney; notes: Note[] }

/** One object per tree element (TreeView.reveal finds elements by identity). */
const nodes = new Map<string, Node>()

export function cached<T extends Node>(key: string, fresh: T): T {
  const c = nodes.get(key)
  if (!c) { nodes.set(key, fresh); return fresh }
  for (const k of Object.keys(c)) delete (c as any)[k]
  return Object.assign(c, fresh) as T
}

export const noteNode = (note: Note) => cached(`note:${note.data.id}`, { kind: 'note', note })

export const sessionNode = (name: string) => cached(`session:${name}`, { kind: 'session' as const, name, notes: notes().filter((x) => sessionOf(x) === name && matchesFilter(x)) })

const journeysNode = () => cached('journeys', { kind: 'journeys' as const })

export const journeyNode = (lj: LoadedJourney) => cached(`journey:${lj.key}`, { kind: 'journey' as const, lj })

/** What the Code Notes view lists. The picker offers FILTERS; `needsMe` (an agent spoke last) and `waiting` (you did)
 *  are not offered: nothing sets them now. */
type Filter = 'all' | 'unread' | 'needsMe' | 'waiting' | 'stale'

export const FILTERS: { id: Filter; label: string; detail: string }[] = [
  { id: 'all', label: 'All notes', detail: 'Open notes (and resolved ones when shown)' },
  { id: 'unread', label: 'Unread', detail: 'Notes with replies you have not seen' },
  { id: 'stale', label: 'Stale', detail: 'The code under the note changed' },
]

export let filter: Filter = 'all'

let showResolved = false

export let groupMode: 'file' | 'session' = 'file'

const GROUP_KEY = 'codeNotes.groupBy'

export const checked = new Set<string>() // note ids selected in the sidebar (2 or more: bulk actions)

export const lastMessage = (n: Note) => n.data.messages[n.data.messages.length - 1]

export function matchesFilter(n: Note): boolean {
  // A check's questions are listed in the Check view, not here as well.
  if (understanding?.isCheck(n)) return false
  const open = n.data.status === 'open'
  switch (filter) {
    case 'unread': return unread(n) > 0 || revealed.id === n.data.id
    case 'needsMe': return open && !!lastMessage(n) && !mine(lastMessage(n)!)
    case 'waiting': return open && !!lastMessage(n) && mine(lastMessage(n)!)
    case 'stale': return !!n.data.stale && (open || showResolved)
    default: return open || showResolved || unread(n) > 0
  }
}

export const order = (a: Note, b: Note) => a.data.range.start - b.data.range.start || (a.data.createdAt ?? a.data.id).localeCompare(b.data.createdAt ?? b.data.id)

/** Most severe first; a note without a severity counts as medium. */
const SEV_RANK: Record<Severity, number> = { high: 0, medium: 1, low: 2, nit: 3 }

const sevRank = (n: Note) => SEV_RANK[n.data.severity ?? 'medium']

/** The sidebar's order inside a group: severity, then the whole-file note, then by line. */
export const rowOrder = (a: Note, b: Note) => sevRank(a) - sevRank(b) || (a.data.target ? 0 : 1) - (b.data.target ? 0 : 1) || order(a, b)

export const SEV_ICON: Record<Severity, [string, string]> = { high: ['flame', 'charts.red'], medium: ['triangle-up', 'charts.orange'], low: ['triangle-down', 'charts.blue'], nit: ['dash', 'descriptionForeground'] }

export const sessionOf = (n: Note) => n.data.session ?? ''

export const HIDDEN_KEY = 'codeNotes.hiddenSessions'

export function hiddenSessions(): Set<string> { return new Set(state.get<string[]>(HIDDEN_KEY) ?? []) }

/** A note whose session is hidden is not drawn in the editor (unless it was just opened from the list). */
export const hiddenInEditor = (n: Note) => revealed.id !== n.data.id && hiddenSessions().has(sessionOf(n))

/** Hides or shows sessions; `only` shows these and hides every other one. */
export async function setSessionHidden(names: string[], hidden: boolean, only = false): Promise<void> {
  const h = only ? new Set(notes().map(sessionOf).filter((x) => !names.includes(x))) : hiddenSessions()
  if (!only) for (const name of names) hidden ? h.add(name) : h.delete(name)
  await state.update(HIDDEN_KEY, [...h])
  const r = revealed.id ? byId(revealed.id) : undefined
  if (r && h.has(sessionOf(r))) { revealed.id = undefined; const t = threads.get(r.data.id); if (t) setCollapse(t, vscode.CommentThreadCollapsibleState.Collapsed, r.data.id) }
  refreshAll()
}

/** Notes grouped by file (or folder); a file with one note is that note's row. */
export function fileGroups(list: Note[], session?: string): Node[] {
  const groups = new Map<string, Node & { kind: 'file' }>()
  for (const n of list) {
    const key = `${session ?? ''}|${n.folder.uri}|${n.data.file}`
    if (!groups.has(key)) groups.set(key, cached(`file:${key}`, { kind: 'file', key, folder: n.folder, file: n.data.file, notes: [], ...(session !== undefined ? { session } : {}), ...(n.data.target === 'folder' ? { isFolder: true } : {}) }))
    groups.get(key)!.notes.push(n)
  }
  // A stable order: the list must not jump while an agent writes; unread shows as dots.
  // In a session (a review): the most severe findings first, then by file.
  const worst = (g: { notes: Note[] }) => (session !== undefined ? Math.min(...g.notes.map(sevRank)) : 0)
  return [...groups.values()].sort((a, b) => worst(a) - worst(b) || a.file.localeCompare(b.file)).map((g) => (g.notes.length === 1 ? noteNode(g.notes[0]) : g))
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
  return notes().filter((x) => x.folder === n.folder && x.data.file === n.data.file && matchesFilter(x) && scopeOf(x) === scope && !journeyOfNote(x))
}

/** A row of its own: alone in its file. */
export const ownRow = (n: Note) => sameRow(n).length <= 1

export const showResolvedNotes = () => { showResolved = true; setCtx('codeNotes.showResolved', true); refreshAll() }

export const hideResolvedNotes = () => { showResolved = false; setCtx('codeNotes.showResolved', false); refreshAll() }

export const pickFilter = async () => {
  const pick = await vscode.window.showQuickPick(FILTERS.map((f) => ({
    label: `${f.id === filter ? '$(check) ' : ''}${f.label}`, detail: f.detail, id: f.id,
    description: `${notes().filter((n) => { const keep = filter; filter = f.id; const r = matchesFilter(n); filter = keep; return r }).length}`,
  })), { title: 'Show in Code Notes' })
  if (!pick) return
  filter = pick.id
  for (const id of [...checked]) { const n = byId(id); if (!n || !matchesFilter(n)) checked.delete(id) } // no invisible ticks
  refreshAll()
}

export const groupByFile = async () => { groupMode = 'file'; await state.update(GROUP_KEY, 'file'); refreshAll() }

export const groupBySession = async () => { groupMode = 'session'; await state.update(GROUP_KEY, 'session'); refreshAll() }

/** Group by file or by session, as last chosen in this workspace. */
export function loadGroupMode(): void {
  groupMode = state.get<'file' | 'session'>(GROUP_KEY) === 'session' ? 'session' : 'file'
}
