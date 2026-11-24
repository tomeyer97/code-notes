// How the Code Notes view lists the notes (notes/model has which ones: the filter, resolved notes shown or not,
// hidden sessions, grouping): file rows and the commands that change the model's choices.

import * as vscode from 'vscode'
import { journeys } from './ports'
import { visibleNotes } from '../notes/visible'
import { stored } from '../platform/host'
import { Note } from '../notes/store'
import { FILTERS, matchesFilter, notesModel, scopeOf } from '../notes/model'
import { journeyOfNote } from '../notes/model/journeyLink'
import { fileNode, Node, noteNode, sevRank } from './nodes'
import { STATE } from '../platform/state'
import { sessionFileKey } from '../platform/keys'

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

/** A question asked from a step: listed under its journey, in the Journeys view. */
export const askedFromStep = (n: Note) => !!journeyOfNote(n, journeys().list.values())

/** The visible notes listed with this one under the same file row (itself included). */
export function sameRow(n: Note): Note[] {
  const scope = scopeOf(n)
  const sameFile = (x: Note) => x.folder === n.folder && x.data.file === n.data.file
  return visibleNotes().filter((x) => sameFile(x) && matchesFilter(x) && scopeOf(x) === scope && !askedFromStep(x))
}

/** A row of its own: alone in its file. */
export const ownRow = (n: Note) => sameRow(n).length <= 1

export const showResolvedNotes = () => notesModel().setShowResolved(true)

export const hideResolvedNotes = () => notesModel().setShowResolved(false)

/** Show in Code Notes: a filter, each with how many notes it shows. */
export const pickFilter = async () => {
  const { query } = notesModel()
  const items = FILTERS.map((f) => ({
    label: `${f.id === query.filter ? '$(check) ' : ''}${f.label}`,
    detail: f.detail,
    id: f.id,
    description: `${query.count(f.id)}`,
  }))
  const pick = await vscode.window.showQuickPick(items, { title: 'Show in Code Notes' })
  if (pick) notesModel().setFilter(pick.id)
}

export const groupByFile = async () => { await stored().set(STATE.groupBy, 'file'); notesModel().setGroupMode('file') }

export const groupBySession = async () => { await stored().set(STATE.groupBy, 'session'); notesModel().setGroupMode('session') }

/** Group by file or by session, as last chosen in this workspace. */
export function loadGroupMode(): void {
  notesModel().query.groupMode = stored().get(STATE.groupBy) === 'session' ? 'session' : 'file'
}
